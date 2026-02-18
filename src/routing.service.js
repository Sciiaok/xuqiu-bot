/**
 * Routing Service
 * Handles lead routing to n8n webhooks and FAQ delivery
 * Supports both session-based (legacy) and lead-based (multi-lead) routing
 */

import { config } from './config.js';
import { sendMessage } from './whatsapp.service.js';
import { updateLead, getLeadsByConversation } from '../lib/repositories/lead.repository.js';

/**
 * Route a high-quality lead to sales team via n8n
 */
export async function routeToSales(session, handoffSummary) {
  const webhookUrl = config.n8n.webhookHumanNow;

  if (!webhookUrl) {
    console.log('⚠️  n8n HUMAN_NOW webhook not configured - skipping');
    return { success: false, reason: 'webhook_not_configured' };
  }

  const payload = {
    route: 'HUMAN_NOW',
    priority: 'high',
    lead: {
      wa_id: session.wa_id,
      company_name: session.lead_data.company_name,
      buyer_type: session.lead_data.buyer_type,
      destination_country: session.lead_data.destination_country,
      destination_port: session.lead_data.destination_port,
      qty_bucket: session.lead_data.qty_bucket,
      international_commercial_term: session.lead_data.international_commercial_term,
      timeline: session.lead_data.timeline,
      budget_indication: session.lead_data.budget_indication,
    },
    score: session.score,
    score_breakdown: session.score_history,
    risk_flags: session.risk_flags,
    handoff_summary: handoffSummary,
    conversation_history: session.messages.slice(-6), // Last 6 messages
    created_at: session.created_at,
    qualified_at: new Date().toISOString(),
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`n8n webhook failed: ${response.status}`);
      return { success: false, reason: 'webhook_error', status: response.status };
    }

    console.log(`✅ Lead routed to sales team (n8n HUMAN_NOW)`);
    return { success: true };
  } catch (error) {
    console.error('Error calling n8n webhook:', error);
    return { success: false, reason: 'network_error', error: error.message };
  }
}

/**
 * Send FAQ resources to low-quality leads
 */
export async function sendFAQResources(waId) {
  const faqMessage = `Thank you for your interest in our vehicle export services!

Here are some helpful resources:

📋 **Vehicle Catalog**: https://example.com/catalog
💰 **Pricing Guide**: https://example.com/pricing
🚢 **Shipping Information**: https://example.com/shipping
❓ **FAQ**: https://example.com/faq

For immediate assistance, please contact our sales team:
📧 Email: official@revopanda.com
📱 WhatsApp: +971-XXX-XXXX

We look forward to serving you!`;

  try {
    await sendMessage(waId, faqMessage);
    console.log(`📚 FAQ resources sent to ${waId}`);
    return { success: true };
  } catch (error) {
    console.error('Error sending FAQ:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Handle routing based on decision
 */
export async function executeRouting(route, session, handoffSummary) {
  switch (route) {
    case 'HUMAN_NOW':
      return await routeToSales(session, handoffSummary);

    case 'FAQ_END':
      return await sendFAQResources(session.wa_id);

    case 'CONTINUE':
      return { success: true, action: 'continue_conversation' };

    default:
      console.log(`Unknown route: ${route}`);
      return { success: false, reason: 'unknown_route' };
  }
}

/**
 * Route an individual lead to sales team via n8n
 * @param {Object} lead - Lead object from database
 * @param {string} handoffSummary - Summary for sales team
 */
export async function routeLeadToSales(lead, handoffSummary) {
  const webhookUrl = config.n8n.webhookHumanNow;

  if (!webhookUrl) {
    console.log('⚠️  n8n HUMAN_NOW webhook not configured - skipping');
    return { success: false, reason: 'webhook_not_configured' };
  }

  const payload = {
    route: 'HUMAN_NOW',
    priority: 'high',
    lead: {
      id: lead.id,
      lead_key: lead.lead_key,
      wa_id: lead.contact?.wa_id,
      company_name: lead.contact?.company_name,
      buyer_type: lead.buyer_type,
      destination_country: lead.destination_country,
      destination_port: lead.destination_port,
      qty_bucket: lead.qty_bucket,
      car_model: lead.car_model,
      incoterm: lead.incoterm,
      timeline: lead.timeline,
      color_quantity: lead.color_quantity,
    },
    score: lead.score,
    stage: lead.stage,
    handoff_summary: handoffSummary,
    qualified_at: new Date().toISOString(),
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.error(`n8n webhook failed: ${response.status}`);
      return { success: false, reason: 'webhook_error', status: response.status };
    }

    // Update lead route in database
    await updateLead(lead.id, { route: 'HUMAN_NOW', handoffSummary });

    console.log(`✅ Lead ${lead.id} routed to sales (HUMAN_NOW)`);
    return { success: true };
  } catch (error) {
    console.error('Error calling n8n webhook:', error);
    return { success: false, reason: 'network_error', error: error.message };
  }
}

/**
 * Handle routing for an individual lead
 * @param {string} route - Route decision
 * @param {Object} lead - Lead object
 * @param {string} handoffSummary - Optional summary
 */
export async function executeLeadRouting(route, lead, handoffSummary) {
  switch (route) {
    case 'HUMAN_NOW':
      return await routeLeadToSales(lead, handoffSummary);

    case 'FAQ_END':
      await updateLead(lead.id, { route: 'FAQ_END' });
      return { success: true, action: 'marked_faq_end' };

    case 'CONTINUE':
      return { success: true, action: 'continue_conversation' };

    default:
      console.log(`Unknown route: ${route}`);
      return { success: false, reason: 'unknown_route' };
  }
}

/**
 * Route all active leads in a conversation
 * Used when conversation routing decision applies to all leads
 * @param {string} route - Route decision
 * @param {string} conversationId - Conversation UUID
 * @param {string} waId - WhatsApp ID for FAQ delivery
 * @param {string} handoffSummary - Optional summary
 */
export async function executeConversationRouting(route, conversationId, waId, handoffSummary) {
  if (route === 'CONTINUE') {
    return { success: true, action: 'continue_conversation' };
  }

  // Get all active leads for this conversation
  const activeLeads = await getLeadsByConversation(conversationId);

  if (activeLeads.length === 0) {
    console.log('No active leads to route');
    return { success: true, action: 'no_leads' };
  }

  console.log(`Routing ${activeLeads.length} active lead(s) to ${route}`);

  const results = [];
  for (const lead of activeLeads) {
    const result = await executeLeadRouting(route, lead, handoffSummary);
    results.push({ leadId: lead.id, leadKey: lead.lead_key, ...result });
  }

  // Send FAQ resources if applicable (once per conversation)
  if (route === 'FAQ_END') {
    await sendFAQResources(waId);
  }

  return {
    success: results.every(r => r.success),
    results,
    leadsRouted: results.length,
  };
}

export default {
  routeToSales,
  routeLeadToSales,
  sendFAQResources,
  executeRouting,
  executeLeadRouting,
  executeConversationRouting,
};
