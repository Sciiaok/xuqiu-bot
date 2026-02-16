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
 * Find active conversation for a contact
 * @param {string} contactId - Contact UUID
 * @returns {Promise<Object|null>} - Conversation object or null
 */
export async function findActiveConversation(contactId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .order('last_message_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data;
}

/**
 * Create a new conversation
 * @param {string} contactId - Contact UUID
 * @returns {Promise<Object>} - Created conversation
 */
export async function createConversation(contactId) {
  const { data, error } = await supabase
    .from('conversations')
    .insert({
      contact_id: contactId,
      status: 'active',
      started_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
      message_count: 0,
    })
    .select()
    .single();

  if (error) {
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
 * Get or create conversation for a contact
 * Implements 3-day timeout rule
 * @param {string} contactId - Contact UUID
 * @returns {Promise<Object>} - Conversation object
 */
export async function getOrCreateConversation(contactId) {
  const existing = await findActiveConversation(contactId);

  if (existing) {
    const daysSinceLastMessage = daysDiff(existing.last_message_at, new Date());

    if (daysSinceLastMessage >= IDLE_THRESHOLD_DAYS) {
      console.log(`Conversation ${existing.id} timed out (${daysSinceLastMessage.toFixed(1)} days), creating new one`);
      await markConversationIdle(existing.id);
      return createConversation(contactId);
    }

    return existing;
  }

  return createConversation(contactId);
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
