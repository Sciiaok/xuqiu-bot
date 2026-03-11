/**
 * Routing Service
 * Handles lead routing and FAQ delivery
 */

import { sendMessage } from './whatsapp.service.js';
import { updateLead, getLeadsByConversation } from '../lib/repositories/lead.repository.js';
import { sendFeishuMessage } from './feishu.service.js';
import { createTraceLogger } from '../lib/core-trace.js';

const INQUIRY_QUALITY_LABEL = { GOOD: '优质', POOR: '低质' };
const BUSINESS_VALUE_LABEL = { HIGH: '高', MEDIUM: '中', LOW: '低' };

function buildFeishuLeadMessage(lead, handoffSummary) {
  const lines = [
    '🔥 **高意向线索 - 需立即跟进**',
    '',
    `**询盘质量：** ${INQUIRY_QUALITY_LABEL[lead.inquiry_quality] || lead.inquiry_quality || '-'}`,
    `**商业价值：** ${BUSINESS_VALUE_LABEL[lead.business_value] || lead.business_value || '-'}`,
    '',
    `**联系人：** ${lead.contact?.name || '未知'}`,
    `**公司：** ${lead.contact?.company_name || '未知'}`,
    `**WhatsApp：** ${lead.contact?.wa_id || '未知'}`,
    '',
    `**车型：** ${lead.car_model || '-'}`,
    `**目的国：** ${lead.destination_country || '-'}`,
    `**目的港：** ${lead.destination_port || '-'}`,
    `**数量：** ${lead.qty_bucket || '-'}`,
    `**颜色/数量：** ${lead.color_quantity?.length ? lead.color_quantity.map(c => `${c.color} × ${c.qty}`).join('、') : '-'}`,
    `**贸易条款：** ${lead.incoterm || '-'}`,
    `**装运港：** ${lead.loading_port || '-'}`,
    `**时间线：** ${lead.timeline || '-'}`,
  ];

  if (lead.conversation_intent_summary) {
    lines.push('', `**意图摘要：** ${lead.conversation_intent_summary}`);
  }

  if (handoffSummary) {
    lines.push('', `**对接建议：** ${handoffSummary}`);
  }

  return lines.join('\n');
}

/**
 * Send FAQ resources to low-quality leads
 */
export async function sendFAQResources(waId, phoneNumberId, traceContext = {}) {
  const logger = createTraceLogger({
    component: 'routing',
    trace_id: traceContext.traceId,
    conversation_id: traceContext.conversationId,
    wa_id: traceContext.waId || waId,
  });
  const faqMessage = `Thank you for your interest in our vehicle export services!

Here are some helpful resources:

📋 **Vehicle Catalog**: https://revopanda.com/explore-cars
❓ **FAQ**: https://revopanda.com/contact-us

For immediate assistance, please contact our sales team:
📧 Email: official@revopanda.com
📱 WhatsApp: +86 13392464782

We look forward to serving you!`;

  try {
    await sendMessage(waId, faqMessage, phoneNumberId);
    logger.info('routing.faq.sent');
    return { success: true };
  } catch (error) {
    logger.error('routing.faq.failed', { error: error.message });
    return { success: false, error: error.message };
  }
}

/**
 * Route an individual lead to sales team via Feishu
 * @param {Object} lead - Lead object from database
 * @param {string} handoffSummary - Summary for sales team
 */
export async function routeLeadToSales(lead, handoffSummary, traceContext = {}) {
  const logger = createTraceLogger({
    component: 'routing',
    trace_id: traceContext.traceId,
    conversation_id: traceContext.conversationId || lead.conversation_id,
    lead_id: lead.id,
    wa_id: traceContext.waId || lead.contact?.wa_id,
  });
  const message = buildFeishuLeadMessage(lead, handoffSummary);
  // Feishu uuid max 50 chars; lead.id(36) + '_' + timestamp(13) = 50
  const routeUuid = `${lead.id}_${Date.parse(lead.updated_at || '') || 0}`;

  sendFeishuMessage(message, true, process.env.FEISHU_CHAT_ID, routeUuid).catch(err =>
    logger.error('routing.feishu.failed', { error: err.message })
  );

  logger.info('routing.sales_routed', {
    route_uuid: routeUuid,
  });
  return { success: true };
}

/**
 * Handle routing for an individual lead
 * @param {string} route - Route decision
 * @param {Object} lead - Lead object
 * @param {string} handoffSummary - Optional summary
 */
export async function executeLeadRouting(route, lead, handoffSummary, traceContext = {}) {
  switch (route) {
    case 'HUMAN_NOW':
      return await routeLeadToSales(lead, handoffSummary, traceContext);

    case 'FAQ_END':
      await updateLead(lead.id, { route: 'FAQ_END' });
      return { success: true, action: 'marked_faq_end' };

    case 'CONTINUE':
      return { success: true, action: 'continue_conversation' };

    default:
      createTraceLogger({
        component: 'routing',
        trace_id: traceContext.traceId,
        conversation_id: traceContext.conversationId,
        lead_id: lead?.id,
      }).warn('routing.unknown_route', { route });
      return { success: false, reason: 'unknown_route' };
  }
}

/**
 * Route all active leads in a conversation
 * @param {string} route - Route decision
 * @param {string} conversationId - Conversation UUID
 * @param {string} waId - WhatsApp ID for FAQ delivery
 * @param {string} handoffSummary - Optional summary
 */
export async function executeConversationRouting(route, conversationId, waId, handoffSummary, phoneNumberId, traceContext = {}) {
  const logger = createTraceLogger({
    component: 'routing',
    trace_id: traceContext.traceId,
    conversation_id: traceContext.conversationId || conversationId,
    wa_id: traceContext.waId || waId,
  });
  if (route === 'CONTINUE') {
    return { success: true, action: 'continue_conversation' };
  }

  // Query leads matching the target route (replaceConversationLeads already set it)
  const leads = await getLeadsByConversation(conversationId, route);

  if (leads.length === 0) {
    logger.info('routing.no_leads_for_route', { route });
    return { success: true, action: 'no_leads' };
  }

  logger.info('routing.execute', {
    route,
    leads_count: leads.length,
  });

  const results = [];
  for (const lead of leads) {
    const result = await executeLeadRouting(route, lead, handoffSummary, traceContext);
    results.push({ leadId: lead.id, leadKey: lead.lead_key, ...result });
  }

  if (route === 'FAQ_END') {
    await sendFAQResources(waId, phoneNumberId, traceContext);
  }

  return {
    success: results.every(r => r.success),
    results,
    leadsRouted: results.length,
  };
}

export default {
  routeLeadToSales,
  sendFAQResources,
  executeLeadRouting,
  executeConversationRouting,
};
