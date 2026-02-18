import supabase from '../supabase.js';

/**
 * Create a new message
 * @param {Object} messageData - Message data
 * @returns {Promise<Object>} - Created message
 */
export async function createMessage(messageData) {
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: messageData.conversationId,
      role: messageData.role,
      content: messageData.content,
      score_delta: messageData.scoreDelta || 0,
      risk_flags: messageData.riskFlags || [],
      sent_at: messageData.sentAt || new Date().toISOString(),
      sent_by: messageData.sentBy,
      metadata: messageData.metadata || {},
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Update message with scoring data
 * @param {string} messageId - Message UUID
 * @param {Object} updates - Fields to update (supports leadId, scoreDelta, riskFlags)
 * @returns {Promise<Object>} - Updated message
 */
export async function updateMessage(messageId, updates) {
  const updateData = {};

  // Map camelCase to snake_case
  if (updates.scoreDelta !== undefined) updateData.score_delta = updates.scoreDelta;
  if (updates.score_delta !== undefined) updateData.score_delta = updates.score_delta;
  if (updates.riskFlags !== undefined) updateData.risk_flags = updates.riskFlags;
  if (updates.risk_flags !== undefined) updateData.risk_flags = updates.risk_flags;
  if (updates.metadata !== undefined) updateData.metadata = updates.metadata;

  const { data, error } = await supabase
    .from('messages')
    .update(updateData)
    .eq('id', messageId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Get messages for a conversation
 * @param {string} conversationId - Conversation UUID
 * @param {number} limit - Max messages to return (default: 50)
 * @returns {Promise<Array>} - Array of messages
 */
export async function getMessagesByConversation(conversationId, limit = 50) {
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: true })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data || [];
}

/**
 * Get recent messages for Claude context (limited to last N)
 * @param {string} conversationId - Conversation UUID
 * @param {number} limit - Max messages (default: 100)
 * @returns {Promise<Array>} - Array of {role, content} for Claude
 */
export async function getMessagesForClaude(conversationId, limit = 100) {
  const messages = await getMessagesByConversation(conversationId, limit);

  return messages.map(msg => ({
    role: msg.role,
    content: msg.content,
  }));
}

/**
 * Get total score from all messages in a conversation
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<number>} - Total score
 */
export async function getTotalScore(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('score_delta')
    .eq('conversation_id', conversationId);

  if (error) {
    throw error;
  }

  return (data || []).reduce((sum, msg) => sum + (msg.score_delta || 0), 0);
}

/**
 * Get all risk flags from a conversation
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Array>} - Unique risk flags
 */
export async function getAllRiskFlags(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('risk_flags')
    .eq('conversation_id', conversationId);

  if (error) {
    throw error;
  }

  const allFlags = (data || []).flatMap(msg => msg.risk_flags || []);
  return [...new Set(allFlags)];
}
