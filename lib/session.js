/**
 * Session V2 - New data layer using 4-table schema
 * Provides backward-compatible interface for existing code
 */

import {
  findOrCreateContact,
  findContactById,
  updateContact,
} from './repositories/contact.repository.js';
import {
  getOrCreateConversation,
  findConversationById,
  updateConversationOnMessage,
  linkConversationToAgent,
} from './repositories/conversation.repository.js';
import {
  findAgentByPhoneNumberId,
} from './repositories/agent.repository.js';
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
 * Get the minimum conversation context needed at webhook ingest time
 * Resolves agent from phoneNumberId and scopes conversation to that agent
 * @param {Object} params
 * @param {string} params.waId - WhatsApp user ID
 * @param {string} [params.profileName] - Contact name from webhook profile
 * @param {string} [params.phoneNumberId] - WhatsApp phone number ID (identifies agent)
 * @returns {Promise<Object>} - Contact and conversation identifiers
 */
export async function getOrCreateConversationContext({ waId, profileName, phoneNumberId }) {
  const contact = await findOrCreateContact({ waId, profileName });

  // Resolve agent from phone_number_id (strict match, no fallback)
  let agent = null;
  if (phoneNumberId) {
    agent = await findAgentByPhoneNumberId(phoneNumberId);
  }
  if (!agent) {
    console.error(`No agent found for phoneNumberId=${phoneNumberId}. Check agents table wa_phone_number_id config.`);
  }
  const agentId = agent?.id || null;

  // Get or create conversation scoped to this agent
  const conversation = await getOrCreateConversation(contact.id, agentId);

  // Ensure conversation is linked to agent
  if (agentId && !conversation.agent_id) {
    await linkConversationToAgent(conversation.id, agentId);
  }

  return {
    wa_id: waId,
    contact_id: contact.id,
    conversation_id: conversation.id,
    agent_id: agentId,
    phone_number_id: phoneNumberId,
    _contact: contact,
    _conversation: conversation,
  };
}

/**
 * Get or create a session for a WhatsApp user
 * Returns a session-like object for backward compatibility
 * @param {string} waId - WhatsApp user ID
 * @returns {Promise<Object>} - Session-like object
 */
export async function getSession(waId) {
  // 1. Find or create contact
  const contact = await findOrCreateContact(waId);

  // 2. Get or create conversation (applies 3-day timeout rule)
  const conversation = await getOrCreateConversation(contact.id);

  // 3. Find existing lead (don't auto-create on first message)
  const lead = await findLeadByConversation(conversation.id);

  // 4. Get messages for Claude
  const messages = await getMessagesForClaude(conversation.id);

  // 5. Get aggregated data
  const riskFlags = await getAllRiskFlags(conversation.id);

  return buildSession({ waId, contact, conversation, lead, messages, riskFlags });
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
 * Process incoming message and update all related data
 * Supports multi-lead: claudeResponse.leads array can contain multiple leads
 * @param {string} waId - WhatsApp user ID
 * @param {string} userMessageContent - User message content
 * @param {Object} claudeResponse - Claude API response
 * @returns {Promise<Object>} - Updated session-like object
 */
export async function processMessage(waId, userMessageContent, claudeResponse) {
  // Get current session state
  const session = await getSession(waId);
  return processMessageWithSession(session, userMessageContent, claudeResponse);
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

async function processMessageWithSession(session, userMessageContent, claudeResponse) {
  // 1. Get leads array (with backward compatibility for extracted_fields)
  let leadsData = claudeResponse.leads || [];
  if (leadsData.length === 0 && claudeResponse.extracted_fields) {
    leadsData = [{ ...claudeResponse.extracted_fields }];
  }

  // 2. Create user message
  await createMessage({
    conversationId: session.conversation_id,
    role: 'user',
    content: userMessageContent,
    sentBy: 'customer',
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

// DEPRECATED: Stage is now determined by Claude via inquiry_quality
// export async function updateSessionStage(waId, newStage) {
//   const session = await getSession(waId);
//   await updateLead(session.lead_id, { stage: newStage });
//   return getSession(waId);
// }

/**
 * Add operator message to conversation
 * @param {string} waId - WhatsApp user ID
 * @param {string} content - Message content
 * @param {string} operatorEmail - Operator email
 * @returns {Promise<Object>} - Updated session
 */
export async function addOperatorMessage(waId, content, operatorEmail, extraMetadata = {}) {
  const session = await getSession(waId);

  await createMessage({
    conversationId: session.conversation_id,
    role: 'assistant',
    content: content,
    sentBy: 'operator',
    metadata: { operator_email: operatorEmail, ...extraMetadata },
  });

  await updateConversationOnMessage(session.conversation_id);

  return getSession(waId);
}
