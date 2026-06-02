/**
 * Session V2 - New data layer using 4-table schema
 * Provides backward-compatible interface for existing code
 */

import {
  findContactById,
  updateContact,
} from './repositories/contact.repository.js';
import {
  findConversationById,
  updateConversationAttribution,
  updateConversationOnMessage,
  refreshTakeoverIfActive,
} from './repositories/conversation.repository.js';
import {
  createMessage,
  getMessagesForClaude,
  getTotalScore,
  getAllRiskFlags,
} from './repositories/message.repository.js';
import {
  findLeadByConversation,
  formatLeadDataForUI,
  replaceConversationLeads,
} from './repositories/lead.repository.js';
import { extractMetaAdIdFromMessageMetadata, getReferralAdId } from './referral-context.js';

function buildSession({ waId, contact, conversation, lead, messages, riskFlags }) {
  return {
    // IDs for new schema
    contact_id: contact.id,
    conversation_id: conversation.id,
    lead_id: lead?.id || null,

    // Backward compatible fields
    wa_id: waId,
    messages,
    stage_turn_count: Math.floor(messages.length / 2),
    risk_flags: riskFlags,
    lead_data: lead ? formatLeadDataForUI({ ...lead, contact }) : {},
    route: lead?.route || 'CONTINUE',

    // Timestamps
    created_at: conversation.started_at,
    updated_at: conversation.last_message_at,

    // Raw objects for advanced use
    _contact: contact,
    _conversation: conversation,
    _lead: lead,
  };
}

/**
 * Get session data for an existing conversation
 * Preserves queue-processor context instead of re-deriving active conversation from waId
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object>} - Session-like object
 */
export async function getSessionByConversationId(conversationId) {
  const conversation = await findConversationById(conversationId);
  if (!conversation) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }

  const [contact, lead, messages, riskFlags] = await Promise.all([
    findContactById(conversation.contact_id),
    findLeadByConversation(conversation.id),
    getMessagesForClaude(conversation.id),
    getAllRiskFlags(conversation.id),
  ]);

  if (!contact) {
    throw new Error(`Contact not found for conversation: ${conversationId}`);
  }

  return buildSession({
    waId: contact.wa_id,
    contact,
    conversation,
    lead,
    messages,
    riskFlags,
  });
}

/**
 * Process incoming message for a known conversation
 * @param {string} conversationId - Conversation UUID
 * @param {string} userMessageContent - User message content
 * @param {Object} claudeResponse - Claude API response
 * @returns {Promise<Object>} - Updated session-like object
 */
export async function processMessageForConversation(conversationId, userMessageContent, claudeResponse) {
  const session = await getSessionByConversationId(conversationId);
  return processMessageWithSession(session, userMessageContent, claudeResponse);
}

function normalizeUserMessageInput(userMessageInput) {
  if (typeof userMessageInput === 'string') {
    return {
      content: userMessageInput,
      metadata: {},
    };
  }

  return {
    content: userMessageInput?.content || '',
    metadata: userMessageInput?.metadata || {},
  };
}

async function processMessageWithSession(session, userMessageContent, claudeResponse) {
  const normalizedUserMessage = normalizeUserMessageInput(userMessageContent);
  const messageMetaAdId = extractMetaAdIdFromMessageMetadata(normalizedUserMessage.metadata);
  const conversationMetaAdId = session._conversation?.meta_ad_id || null;
  // 回头客起新会话时本条消息没带 referral，但 contact 上的 last_referral 仍是
  // 把他带进来的那条广告 —— 用它兜底，让新会话也能归因到原广告。
  const contactReferralAdId = getReferralAdId(session._contact?.metadata?.last_referral);
  const resolvedMetaAdId = messageMetaAdId || conversationMetaAdId || contactReferralAdId;
  const tenantId = session._conversation?.tenant_id;
  if (!tenantId) {
    throw new Error('processMessageWithSession: conversation missing tenant_id');
  }

  // 1. Get leads array (with backward compatibility for extracted_fields)
  let leadsData = claudeResponse.leads || [];
  if (leadsData.length === 0 && claudeResponse.extracted_fields) {
    leadsData = [{ ...claudeResponse.extracted_fields }];
  }

  // 2. Create user message
  await createMessage({
    tenantId,
    conversationId: session.conversation_id,
    role: 'user',
    content: normalizedUserMessage.content,
    sentBy: 'customer',
    metadata: normalizedUserMessage.metadata,
  });

  // 3. Create assistant message (skip if empty)
  if (claudeResponse.next_message && claudeResponse.next_message.trim() !== '') {
    await createMessage({
      tenantId,
      conversationId: session.conversation_id,
      role: 'assistant',
      content: claudeResponse.next_message,
      sentBy: 'bot',
    });
  }

  // 4. Update conversation timestamp
  await updateConversationOnMessage(session.conversation_id);

  // 4.1 Persist ad attribution at conversation level when available from inbound
  //     metadata or inherited from the contact's last_referral.
  if (resolvedMetaAdId && resolvedMetaAdId !== conversationMetaAdId) {
    await updateConversationAttribution(session.conversation_id, {
      metaAdId: resolvedMetaAdId,
    });
  }

  // 5. Replace all leads for this conversation with Claude's response.
  // 业务字段现在都在 lead.details 里 ── normalizeAgentResponse 把顶层字段全部
  // 移进 details JSONB。一条 lead 是否「成立」不能再按 car_model / product_name
  // 这种硬编码字段名判断 ── 产品线的 lead_fields 是可配置的（如农机线用
  // machinery_type / model），自定义 output_schema 是 additionalProperties:false，
  // 模型物理上不会吐出 car_model / product_name。改为：details 里有任意非空字段
  // 即算有效线索。（generic 回退形态字段仍在顶层，一并兜底。）
  const validLeads = leadsData.filter(lead =>
    (lead.details && Object.keys(lead.details).length > 0) ||
    Boolean(lead.product_name || lead.car_model),
  );
  if (validLeads.length > 0) {
    // Convert conversation_intent array to comma-separated string
    const intentString = Array.isArray(claudeResponse.conversation_intent)
      ? claudeResponse.conversation_intent.join(',')
      : claudeResponse.conversation_intent;

    // Prepare leads with conversation-level fields
    const leadsWithConversationFields = validLeads.map(lead => ({
      ...lead,
      inquiry_quality: claudeResponse.inquiry_quality,
      business_value: claudeResponse.business_value,
      conversation_intent: intentString,
      conversation_intent_summary: claudeResponse.conversation_intent_summary,
      handoffSummary: claudeResponse.handoff_summary || null,
      route: claudeResponse.route,
      meta_ad_id: resolvedMetaAdId,
      product_line: session._conversation?.product_line || null,
      details: lead.details || {},
    }));

    await replaceConversationLeads(
      session.conversation_id,
      session.contact_id,
      leadsWithConversationFields,
      { tenantId },
    );
  }

  // 6. Update contact company name if extracted
  const companyName = leadsData.find(l => l.details?.company_name)?.details?.company_name;
  if (companyName) {
    await updateContact(session.contact_id, { company_name: companyName });
  }

  // Note: HUMAN_NOW and FAQ_END no longer close conversation
  // Conversations only close on 3-day timeout

  return getSessionByConversationId(session.conversation_id);
}

/**
 * Add operator message to conversation
 * Preserves the exact conversation selected in the inbox UI.
 * @param {string} conversationId - Conversation UUID
 * @param {string} content - Message content
 * @param {string} operatorEmail - Operator email
 * @param {Object} extraMetadata - Extra metadata to attach to message
 * @returns {Promise<Object>} - Updated session
 */
export async function addOperatorMessage(conversationId, content, operatorEmail, extraMetadata = {}) {
  const session = await getSessionByConversationId(conversationId);
  const tenantId = session._conversation?.tenant_id;
  if (!tenantId) {
    throw new Error('addOperatorMessage: conversation missing tenant_id');
  }

  await createMessage({
    tenantId,
    conversationId: session.conversation_id,
    role: 'assistant',
    content,
    sentBy: 'operator',
    metadata: { operator_email: operatorEmail, ...extraMetadata },
  });

  await updateConversationOnMessage(session.conversation_id);
  // 操作员主动发消息 → 把 12h TTL 的锚点推到现在，避免「点接管后 12h 才回第一句话，
  // 下一条客户消息立刻被 AI 抢答」。只在 takeover 已经开着时才生效。
  await refreshTakeoverIfActive(session.conversation_id);

  return getSessionByConversationId(session.conversation_id);
}
