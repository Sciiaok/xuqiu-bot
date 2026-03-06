import supabase from '../supabase.js';

const IDLE_THRESHOLD_DAYS = 3;

/**
 * Calculate days between two dates
 */
function daysDiff(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffMs = Math.abs(d2 - d1);
  return diffMs / (1000 * 60 * 60 * 24);
}

/**
 * Find active conversation for a contact, optionally scoped to an agent
 * @param {string} contactId - Contact UUID
 * @param {string|null} agentId - Agent UUID (null = unscoped conversations)
 * @returns {Promise<Object|null>} - Conversation object or null
 */
export async function findActiveConversation(contactId, agentId = null) {
  let query = supabase
    .from('conversations')
    .select('*')
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .order('last_message_at', { ascending: false })
    .limit(1);

  if (agentId) {
    query = query.eq('agent_id', agentId);
  } else {
    query = query.is('agent_id', null);
  }

  const { data, error } = await query.single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data;
}

/**
 * Create a new conversation
 * Handles race conditions with unique constraint on (contact_id) WHERE status='active'
 * @param {string} contactId - Contact UUID
 * @param {string|null} agentId - Agent UUID
 * @returns {Promise<Object>} - Created conversation
 */
export async function createConversation(contactId, agentId = null) {
  const { data, error } = await supabase
    .from('conversations')
    .insert({
      contact_id: contactId,
      agent_id: agentId,
      status: 'active',
      started_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
      message_count: 0,
    })
    .select()
    .single();

  if (error) {
    // If unique constraint violation, another request created it - fetch it
    if (error.code === '23505') {
      console.log(`Race condition detected, fetching existing active conversation for contact ${contactId}`);
      const existing = await findActiveConversation(contactId, agentId);
      if (existing) return existing;
    }
    throw error;
  }

  console.log(`Created new conversation ${data.id} for contact ${contactId}`);
  return data;
}

/**
 * Mark conversation as idle (timeout)
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object>} - Updated conversation
 */
export async function markConversationIdle(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .update({
      status: 'idle',
      closed_reason: 'timeout',
      ended_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Close conversation (route terminal)
 * @param {string} conversationId - Conversation UUID
 * @param {string} reason - Close reason (route_human, route_nurture, route_faq, manual)
 * @returns {Promise<Object>} - Updated conversation
 */
export async function closeConversation(conversationId, reason) {
  const { data, error } = await supabase
    .from('conversations')
    .update({
      status: 'closed',
      closed_reason: reason,
      ended_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Update conversation after message
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object>} - Updated conversation
 */
export async function updateConversationOnMessage(conversationId) {
  // Fetch current count first, then increment
  const { data: conv } = await supabase
    .from('conversations')
    .select('message_count')
    .eq('id', conversationId)
    .single();

  const { data, error } = await supabase
    .from('conversations')
    .update({
      last_message_at: new Date().toISOString(),
      message_count: (conv?.message_count || 0) + 1,
    })
    .eq('id', conversationId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Get or create conversation for a contact, optionally scoped to an agent
 * Implements 3-day timeout rule
 * @param {string} contactId - Contact UUID
 * @param {string|null} agentId - Agent UUID
 * @returns {Promise<Object>} - Conversation object
 */
export async function getOrCreateConversation(contactId, agentId = null) {
  const existing = await findActiveConversation(contactId, agentId);

  if (existing) {
    const daysSinceLastMessage = daysDiff(existing.last_message_at, new Date());

    if (daysSinceLastMessage >= IDLE_THRESHOLD_DAYS) {
      console.log(`Conversation ${existing.id} timed out (${daysSinceLastMessage.toFixed(1)} days), creating new one`);
      await markConversationIdle(existing.id);
      return createConversation(contactId, agentId);
    }

    return existing;
  }

  return createConversation(contactId, agentId);
}

/**
 * Get conversation by ID with related data
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object>} - Conversation with contact and lead
 */
export async function getConversationWithRelations(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .select(`
      *,
      contact:contacts(*),
      lead:leads(*),
      messages(*)
    `)
    .eq('id', conversationId)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Find conversation by ID
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object|null>} - Conversation object or null
 */
export async function findConversationById(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('id', conversationId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data;
}

/**
 * Start human takeover for a conversation
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object>} - Updated conversation
 */
export async function startHumanTakeover(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .update({
      is_human_takeover: true,
      human_takeover_at: new Date().toISOString(),
    })
    .eq('id', conversationId)
    .select()
    .single();

  if (error) throw error;
  console.log(`Human takeover started for conversation ${conversationId}`);
  return data;
}

/**
 * End human takeover for a conversation
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object>} - Updated conversation
 */
export async function endHumanTakeover(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .update({
      is_human_takeover: false,
      human_takeover_at: null,
    })
    .eq('id', conversationId)
    .select()
    .single();

  if (error) throw error;
  console.log(`Human takeover ended for conversation ${conversationId}`);
  return data;
}

/**
 * Check if conversation is in human takeover (pure read, no side effects)
 * FIX (Codex W2): Does NOT auto-expire. Expiry is handled by cron and
 * queue-processor only, to avoid write amplification on reads.
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<boolean>} - True if human is actively controlling
 */
export async function isHumanTakeover(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('is_human_takeover')
    .eq('id', conversationId)
    .single();

  if (error) throw error;
  return data?.is_human_takeover || false;
}

/**
 * Check if takeover has expired (1h timeout) and auto-release if so
 * Called only from queue-processor and cron — NOT from read paths
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<boolean>} - True if human is still actively controlling
 */
export async function checkAndExpireTakeover(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('is_human_takeover, human_takeover_at')
    .eq('id', conversationId)
    .single();

  if (error) throw error;
  if (!data?.is_human_takeover) return false;

  const TAKEOVER_TIMEOUT_MS = 60 * 60 * 1000;
  if (data.human_takeover_at) {
    const elapsed = Date.now() - new Date(data.human_takeover_at).getTime();
    if (elapsed >= TAKEOVER_TIMEOUT_MS) {
      await endHumanTakeover(conversationId);
      console.log(`Human takeover auto-expired for conversation ${conversationId} (${Math.round(elapsed / 60000)}min)`);
      return false;
    }
  }

  return true;
}

/**
 * Find all conversations with expired human takeover (for cron)
 * @returns {Promise<Array>} - Array of conversation IDs to release
 */
export async function findExpiredTakeovers() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('conversations')
    .select('id')
    .eq('is_human_takeover', true)
    .lt('human_takeover_at', oneHourAgo);

  if (error) throw error;
  return (data || []).map(row => row.id);
}

/**
 * Link a conversation to an agent (set agent_id if not already set)
 * @param {string} conversationId
 * @param {string} agentId
 */
export async function linkConversationToAgent(conversationId, agentId) {
  const { error } = await supabase
    .from('conversations')
    .update({ agent_id: agentId })
    .eq('id', conversationId)
    .is('agent_id', null);

  if (error) {
    console.error('Error linking conversation to agent:', error);
  }
}
