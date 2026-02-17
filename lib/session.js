/**
 * Session V2 - New data layer using 4-table schema
 * Provides backward-compatible interface for existing code
 */

import {
  findOrCreateContact,
  updateContact,
} from './repositories/contact.repository.js';
import {
  getOrCreateConversation,
  closeConversation,
  updateConversationOnMessage,
} from './repositories/conversation.repository.js';
import {
  createMessage,
  updateMessage,
  getMessagesForClaude,
  getMessagesByConversation,
  getTotalScore,
  getTotalScoreForLead,
  getAllRiskFlags,
} from './repositories/message.repository.js';
import {
  findOrCreateLead,
  findOrCreateLeadByKey,
  updateLead,
  updateLeadFromClaude,
  updateLeadFromClaudeFields,
  getLeadsByConversation,
  formatLeadDataForUI,
} from './repositories/lead.repository.js';
import { generateLeadKey } from '../src/lead-key.js';

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

  // 3. Find or create lead
  const lead = await findOrCreateLead(conversation.id, contact.id);

  // 4. Get messages for Claude
  const messages = await getMessagesForClaude(conversation.id);

  // 5. Get aggregated data
  const riskFlags = await getAllRiskFlags(conversation.id);

  // Return session-like object for backward compatibility
  return {
    // IDs for new schema
    contact_id: contact.id,
    conversation_id: conversation.id,
    lead_id: lead.id,

    // Backward compatible fields
    wa_id: waId,
    messages: messages,
    stage: lead.stage,
    stage_turn_count: Math.floor(messages.length / 2),
    score: lead.score,
    score_history: [], // Computed from messages if needed
    risk_flags: riskFlags,
    lead_data: formatLeadDataForUI({ ...lead, contact }),
    route: lead.route,

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

  // 1. Get leads array (with backward compatibility for extracted_fields)
  let leadsData = claudeResponse.leads || [];
  if (leadsData.length === 0 && claudeResponse.extracted_fields) {
    // Backward compatibility: convert extracted_fields to single lead
    leadsData = [{ ...claudeResponse.extracted_fields }];
  }

  // 2. Create user message (initially without lead association)
  const userMessage = await createMessage({
    conversationId: session.conversation_id,
    role: 'user',
    content: userMessageContent,
    sentBy: 'customer',
  });

  // 3. Process each lead
  const processedLeads = [];
  for (const leadData of leadsData) {
    // 3.1 Generate lead key from extracted fields
    const leadKey = generateLeadKey(leadData);

    // 3.2 Find or create lead by key
    const targetLead = await findOrCreateLeadByKey(
      session.conversation_id,
      session.contact_id,
      leadKey
    );

    // 3.3 Calculate score delta (only first lead gets the score)
    const scoreDelta = processedLeads.length === 0
      ? (claudeResponse.score_delta || 0)
      : 0;

    // 3.4 Update lead with extracted fields
    const newScore = targetLead.score + scoreDelta;
    await updateLeadFromClaudeFields(targetLead.id, leadData, newScore);

    // 3.5 Update lead route if provided (only for first lead)
    if (processedLeads.length === 0 && claudeResponse.route) {
      await updateLead(targetLead.id, { route: claudeResponse.route });
    }

    processedLeads.push(targetLead);
  }

  // 4. Associate user message with first lead and update scoring
  if (processedLeads.length > 0) {
    await updateMessage(userMessage.id, {
      score_delta: claudeResponse.score_delta || 0,
      risk_flags: claudeResponse.risk_flags || [],
      leadId: processedLeads[0].id,
    });
  } else {
    // No leads extracted, just update scoring without lead association
    await updateMessage(userMessage.id, {
      score_delta: claudeResponse.score_delta || 0,
      risk_flags: claudeResponse.risk_flags || [],
    });
  }

  // 5. Create assistant message (associated with first lead)
  await createMessage({
    conversationId: session.conversation_id,
    role: 'assistant',
    content: claudeResponse.next_message,
    sentBy: 'bot',
    leadId: processedLeads[0]?.id || null,
  });

  // 6. Update conversation timestamp (2 messages added)
  await updateConversationOnMessage(session.conversation_id);
  await updateConversationOnMessage(session.conversation_id);

  // 7. Update contact company name if extracted from any lead
  const companyName = leadsData.find(l => l.company_name)?.company_name;
  if (companyName) {
    await updateContact(session.contact_id, { company_name: companyName });
  }

  // 8. Handle conversation closure on terminal routes
  // Note: route != 'CONTINUE' marks the lead as ended, conversation stays active if other leads exist
  if (claudeResponse.route && claudeResponse.route !== 'CONTINUE') {
    // Check if all leads in this conversation have ended
    const activeLeads = await getLeadsByConversation(session.conversation_id);
    if (activeLeads.length === 0) {
      const reasonMap = {
        'HUMAN_NOW': 'route_human',
        'NURTURE': 'route_nurture',
        'FAQ_END': 'route_faq',
      };
      await closeConversation(session.conversation_id, reasonMap[claudeResponse.route] || 'manual');
    }
  }

  // Return updated session
  return getSession(waId);
}

/**
 * Update session stage (for state machine)
 * @param {string} waId - WhatsApp user ID
 * @param {string} newStage - New stage value
 * @returns {Promise<Object>} - Updated session
 */
export async function updateSessionStage(waId, newStage) {
  const session = await getSession(waId);
  await updateLead(session.lead_id, { stage: newStage });
  return getSession(waId);
}

/**
 * Add operator message to conversation
 * @param {string} waId - WhatsApp user ID
 * @param {string} content - Message content
 * @param {string} operatorEmail - Operator email
 * @returns {Promise<Object>} - Updated session
 */
export async function addOperatorMessage(waId, content, operatorEmail) {
  const session = await getSession(waId);

  await createMessage({
    conversationId: session.conversation_id,
    role: 'assistant',
    content: content,
    sentBy: 'operator',
    metadata: { operator_email: operatorEmail },
  });

  await updateConversationOnMessage(session.conversation_id);

  return getSession(waId);
}

/**
 * Get full conversation data for chat view
 * @param {string} waId - WhatsApp user ID
 * @returns {Promise<Object>} - Full conversation data
 */
export async function getConversationData(waId) {
  const session = await getSession(waId);

  // Get all messages (not just last 10)
  const allMessages = await getMessagesByConversation(session.conversation_id, 100);

  return {
    ...session,
    messages: allMessages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      sent_at: m.sent_at,
      sent_by: m.sent_by,
      score_delta: m.score_delta,
      risk_flags: m.risk_flags,
    })),
  };
}
