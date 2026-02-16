/**
 * Routing Service
 * Handles lead routing to n8n webhooks and FAQ delivery
 */

import { config } from './config.js';
import { sendMessage } from './whatsapp.service.js';

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
 * Route a medium-quality lead to nurture sequence via n8n
 */
export async function routeToNurture(session, handoffSummary) {
  const webhookUrl = config.n8n.webhookNurture;

  if (!webhookUrl) {
    console.log('⚠️  n8n NURTURE webhook not configured - skipping');
    return { success: false, reason: 'webhook_not_configured' };
  }

  const payload = {
    route: 'NURTURE',
    priority: 'medium',
    lead: {
      wa_id: session.wa_id,
      company_name: session.lead_data.company_name,
      buyer_type: session.lead_data.buyer_type,
      destination_country: session.lead_data.destination_country,
      destination_port: session.lead_data.destination_port,
      qty_bucket: session.lead_data.qty_bucket,
      international_commercial_term: session.lead_data.international_commercial_term,
      timeline: session.lead_data.timeline,
    },
    score: session.score,
    handoff_summary: handoffSummary,
    follow_up_after: '24h',
    conversation_snippet: session.messages.slice(-4),
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

    console.log(`✅ Lead routed to nurture sequence (n8n NURTURE)`);
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

    case 'NURTURE':
      return await routeToNurture(session, handoffSummary);

    case 'FAQ_END':
      return await sendFAQResources(session.wa_id);

    case 'CONTINUE':
      // No routing action needed
      return { success: true, action: 'continue_conversation' };

    default:
      console.log(`Unknown route: ${route}`);
      return { success: false, reason: 'unknown_route' };
  }
}

export default {
  routeToSales,
  routeToNurture,
  sendFAQResources,
  executeRouting,
};
