import supabase from '../supabase.js';
import { getSupabaseAdmin } from '../supabase-admin.js';

/**
 * Create a new message
 * @param {Object} messageData - Message data
 * @returns {Promise<Object>} - Created message
 */
export async function createMessage(messageData) {
  if (!messageData.tenantId) {
    throw new Error('createMessage: tenantId required');
  }
  const { data, error } = await supabase
    .from('messages')
    .insert({
      tenant_id: messageData.tenantId,
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

  // Fire-and-forget 自动翻译。会话开关 conversations.translation_enabled=true
  // 时，刚落库的消息异步翻译，把结果合并写回 messages.metadata.translation。
  // 失败不能影响 message 入库，所以全部包在 try/catch 里且不 await。
  void queueAutoTranslate(data, messageData.tenantId);

  return data;
}

async function queueAutoTranslate(messageRow, tenantId) {
  try {
    if (!messageRow?.id || !messageRow?.conversation_id) return;
    const admin = getSupabaseAdmin();
    const { data: conv, error } = await admin
      .from('conversations')
      .select('translation_enabled, product_line')
      .eq('id', messageRow.conversation_id)
      .single();
    // 列还没 migrate 上去时 PostgREST 回 42703 —— 视为开关 off，静默跳过
    if (error) {
      if (error.code === '42703' || /column .* does not exist/i.test(error.message || '')) {
        return;
      }
      console.warn('[translate] auto lookup failed', {
        message_id: messageRow.id,
        err: error.message,
      });
      return;
    }
    if (!conv?.translation_enabled) return;
    // 动态 import 切断潜在的反向依赖；translate.service 本身依赖 llm-client，
    // 当前没有反向 import 但保留弹性。
    const { translateMessageAsync } = await import('../../src/translate.service.js');
    void translateMessageAsync(messageRow, {
      tenantId,
      productLine: conv.product_line,
    });
  } catch (err) {
    console.warn('[translate] auto-trigger threw', {
      message_id: messageRow?.id,
      err: err?.message,
    });
  }
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
 * @returns {Promise<Array>} - Array of {role, content, metadata} for Claude
 */
export async function getMessagesForClaude(conversationId, limit = 100) {
  const messages = await getMessagesByConversation(conversationId, limit);

  return messages.map(msg => ({
    role: msg.role,
    content: msg.content,
    metadata: msg.metadata || {},
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
