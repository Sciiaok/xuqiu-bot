import { findOrCreateContact } from './repositories/contact.repository.js';
import {
  findLatestActiveConversation,
  getOrCreateConversation,
  markConversationIdle,
} from './repositories/conversation.repository.js';

const IDLE_THRESHOLD_DAYS = 3;

function isConversationStale(lastMessageAt) {
  if (!lastMessageAt) return false;
  const lastMessageDate = new Date(lastMessageAt);
  const ageMs = Math.abs(Date.now() - lastMessageDate.getTime());
  return ageMs / (1000 * 60 * 60 * 24) >= IDLE_THRESHOLD_DAYS;
}

/**
 * Create or reuse conversation context with shared-number routing support.
 *
 * Inbound phone_number_id is preserved as context/logging only.
 * New inbound conversations are created without an agent and routed later by Claude tool use.
 */
export async function getOrCreateRoutedConversationContext({
  waId,
  profileName,
  phoneNumberId,
}) {
  const contact = await findOrCreateContact({ waId, profileName });
  let conversation;
  const latestActiveConversation = await findLatestActiveConversation(contact.id);
  if (latestActiveConversation && !isConversationStale(latestActiveConversation.last_message_at)) {
    conversation = latestActiveConversation.wa_phone_number_id !== (phoneNumberId || null)
      ? await getOrCreateConversation(contact.id, latestActiveConversation.agent_id || null, phoneNumberId || null)
      : latestActiveConversation;
  } else {
    if (latestActiveConversation) {
      await markConversationIdle(latestActiveConversation.id);
    }
    conversation = await getOrCreateConversation(contact.id, null, phoneNumberId || null);
  }

  return {
    wa_id: waId,
    contact_id: contact.id,
    conversation_id: conversation.id,
    agent_id: conversation.agent_id || null,
    phone_number_id: phoneNumberId,
    routing_mode: 'shared',
    _contact: contact,
    _conversation: conversation,
    _agent: null,
  };
}
