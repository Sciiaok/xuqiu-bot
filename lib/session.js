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
import { extractMetaAdIdFromMessageMetadata } from './referral-context.js';

function buildSession({ waId, contact, conversation, lead, messages, riskFlags }) {
  return {
    // IDs for new schema
    contact_id: contact.id,
    conversation_id: conversation.id,
    lead_id: lead?.id || null,

    // Backward compatible fields
    wa_id: waId,
    messages,
    stage: lead?.stage || 'GREET',
    stage_turn_count: Math.floor(messages.length / 2),
    score: lead?.score || 0,
    score_history: [], // Computed from messages if needed
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
  const resolvedMetaAdId = messageMetaAdId || conversationMetaAdId;

  // 1. Get leads array (with backward compatibility for extracted_fields)
  let leadsData = claudeResponse.leads || [];
  if (leadsData.length === 0 && claudeResponse.extracted_fields) {
    leadsData = [{ ...claudeResponse.extracted_fields }];
  }

  // 2. Create user message
  await createMessage({
    conversationId: session.conversation_id,
    role: 'user',
    content: normalizedUserMessage.content,
    sentBy: 'customer',
    metadata: normalizedUserMessage.metadata,
  });

  // 3. Create assistant message (skip if empty)
  if (claudeResponse.next_message && claudeResponse.next_message.trim() !== '') {
    await createMessage({
      conversationId: session.conversation_id,
      role: 'assistant',
      content: claudeResponse.next_message,
      sentBy: 'bot',
    });
  }

  // 4. Update conversation timestamp
  await updateConversationOnMessage(session.conversation_id);

  // 4.1 Persist ad attribution at conversation level when available from inbound metadata.
  if (messageMetaAdId && messageMetaAdId !== conversationMetaAdId) {
    await updateConversationAttribution(session.conversation_id, {
      metaAdId: messageMetaAdId,
    });
  }

  // 5. Replace all leads for this conversation with Claude's response
  // Only process if there's at least one lead with car_model
  const validLeads = leadsData.filter(lead => lead.car_model || lead.product_name);
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
      // Multi-product fields
      agent_id: session._conversation?.agent_id || null,
      product_name: lead.product_name || null,
      sku_description: lead.sku_description || null,
      details: lead.details || {},
    }));

    await replaceConversationLeads(
      session.conversation_id,
      session.contact_id,
      leadsWithConversationFields
    );
  }

  // 6. Update contact company name if extracted
  const companyName = leadsData.find(l => l.company_name)?.company_name;
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

  await createMessage({
    conversationId: session.conversation_id,
    role: 'assistant',
    content,
    sentBy: 'operator',
    metadata: { operator_email: operatorEmail, ...extraMetadata },
  });

  await updateConversationOnMessage(session.conversation_id);

  return getSessionByConversationId(session.conversation_id);
}
