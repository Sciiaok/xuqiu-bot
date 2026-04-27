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
 *
 * tenantId 是必填：webhook 在调进来之前已经按 phoneNumberId 推导出 tenant，
 * 后续 contact / conversation 的创建都按这个 tenant 落地。
 */
export async function getOrCreateRoutedConversationContext({
  tenantId,
  waId,
  profileName,
  phoneNumberId,
  bsuid,
  username,
}) {
  if (!tenantId) throw new Error('getOrCreateRoutedConversationContext: tenantId required');

  const contact = await findOrCreateContact({ tenantId, waId, profileName, bsuid, username });
  let conversation;
  const latestActiveConversation = await findLatestActiveConversation({ tenantId, contactId: contact.id });
  if (latestActiveConversation && !isConversationStale(latestActiveConversation.last_message_at)) {
    conversation = latestActiveConversation.wa_phone_number_id !== (phoneNumberId || null)
      ? await getOrCreateConversation({ tenantId, contactId: contact.id, agentId: latestActiveConversation.agent_id || null, waPhoneNumberId: phoneNumberId || null })
      : latestActiveConversation;
  } else {
    if (latestActiveConversation) {
      await markConversationIdle(latestActiveConversation.id);
    }
    conversation = await getOrCreateConversation({ tenantId, contactId: contact.id, agentId: null, waPhoneNumberId: phoneNumberId || null });
  }

  return {
    wa_id: waId,
    contact_id: contact.id,
    conversation_id: conversation.id,
    agent_id: conversation.agent_id || null,
    phone_number_id: phoneNumberId,
    routing_mode: 'shared',
    tenant_id: tenantId,
    _contact: contact,
    _conversation: conversation,
    _agent: null,
  };
}
