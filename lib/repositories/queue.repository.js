import supabase from '../supabase.js';
import { config, pickAggregationWindowMs } from '../../src/config.js';

// 进程级唯一 ID，用于 acquire_queue_messages RPC 的分布式锁。
// process.pid 是 Node-only，所以不放在 src/config.js（避免 Edge Runtime 编译失败）。
const QUEUE_INSTANCE_ID = `instance-${process.pid}`;

/**
 * Enqueue a message for aggregated processing.
 *
 * Insert-or-skip 语义：wa_message_id 已存在的行**绝不覆盖**——之前的 upsert
 * 会把已经被 worker 锁住或已经 completed 的行强行翻回 `status='pending'`，
 * 导致 Meta 重投 webhook 触发并发处理 + 双发 WhatsApp。现在改成：INSERT 撞
 * 23505 → 直接查回已有行返回，状态保持不动。
 */
export async function enqueueMessage(data) {
  // 调用方（webhook）有两种姿势：
  //   - processAfter (Date / ISO string): burst 共享同一个绝对 deadline，
  //     传这个就锁定 deadline 不再受 Date.now() 漂移影响（推荐）。
  //   - aggregationWindowMs (number): 兼容老调用方，按 Date.now()+window
  //     现算 deadline，循环里多条 enqueue 会有几十~几百毫秒漂移。
  // 都没传就各自现摇一个 window，向后兼容。
  let processAfter;
  if (data.processAfter) {
    processAfter = data.processAfter instanceof Date
      ? data.processAfter
      : new Date(data.processAfter);
  } else {
    const windowMs = typeof data.aggregationWindowMs === 'number'
      ? data.aggregationWindowMs
      : pickAggregationWindowMs();
    processAfter = new Date(Date.now() + windowMs);
  }

  const { data: msg, error } = await supabase
    .from('message_queue')
    .insert({
      conversation_id: data.conversationId,
      contact_id: data.contactId,
      wa_id: data.waId,
      content: data.content,
      message_type: data.messageType || 'text',
      metadata: data.metadata || {},
      wa_message_id: data.waMessageId,
      status: 'pending',
      process_after: processAfter.toISOString(),
    })
    .select()
    .single();

  if (!error) return msg;

  // 23505 = unique_violation on wa_message_id → 已存在；查回那一行原样返回，
  // 不动 status / process_after / locked_*。
  if (error.code === '23505' && data.waMessageId) {
    const { data: existing, error: fetchError } = await supabase
      .from('message_queue')
      .select('*')
      .eq('wa_message_id', data.waMessageId)
      .single();
    if (fetchError) throw fetchError;
    return { ...existing, _duplicate: true };
  }

  throw error;
}

/**
 * Acquire and lock pending messages for a conversation
 * Uses PostgreSQL FOR UPDATE SKIP LOCKED for distributed safety
 *
 * Tenant 维度刻意不传：message_queue 没有 tenant_id 列（004 老迁移，多租户
 * foundation 也没列入），加列要 ALTER TABLE + 回填，结构性改动。conversation_id
 * 是全局唯一 UUID，通过它锁定的 message_queue 行天然限定在单个 conversation
 * 范围内 —— 不存在跨租户错锁的可能。RPC 老接口一并保留不动。
 *
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Array>} - Locked messages (empty if none or already locked)
 */
export async function acquirePendingMessages(conversationId) {
  const { data, error } = await supabase.rpc('acquire_queue_messages', {
    p_conversation_id: conversationId,
    p_instance_id: QUEUE_INSTANCE_ID,
  });

  if (error) {
    console.error('Error acquiring queue messages:', error);
    return [];
  }

  return data || [];
}

/**
 * Check if there are pending messages ready to process
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<boolean>} - True if ready messages exist
 */
export async function hasPendingMessages(conversationId) {
  const { data, error } = await supabase
    .from('message_queue')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('status', 'pending')
    .lte('process_after', new Date().toISOString())
    .limit(1);

  if (error) {
    console.error('Error checking pending messages:', error);
    return false;
  }

  return data && data.length > 0;
}

/**
 * Mark messages as completed
 * @param {Array<string>} ids - Message queue IDs
 * @returns {Promise<void>}
 */
export async function markAsCompleted(ids) {
  const { error } = await supabase
    .from('message_queue')
    .update({
      status: 'completed',
      processed_at: new Date().toISOString(),
    })
    .in('id', ids);

  if (error) {
    throw error;
  }
}

/**
 * Mark messages as failed and schedule retry
 * @param {Array<string>} ids - Message queue IDs
 * @param {string} errorMessage - Error description
 * @returns {Promise<void>}
 */
export async function markAsFailed(ids, errorMessage) {
  // First get current retry counts
  const { data: messages, error: fetchError } = await supabase
    .from('message_queue')
    .select('id, retry_count')
    .in('id', ids);

  if (fetchError) {
    throw fetchError;
  }

  // Update each message individually to handle retry count
  for (const msg of messages) {
    const newRetryCount = (msg.retry_count || 0) + 1;
    const newStatus = newRetryCount >= config.queue.maxRetries ? 'failed' : 'pending';
    const processAfter = new Date(Date.now() + 5000); // Retry after 5s

    const { error } = await supabase
      .from('message_queue')
      .update({
        status: newStatus,
        error_message: errorMessage,
        retry_count: newRetryCount,
        process_after: processAfter.toISOString(),
        locked_at: null,
        locked_by: null,
      })
      .eq('id', msg.id);

    if (error) {
      console.error(`Error marking message ${msg.id} as failed:`, error);
    }
  }
}

/**
 * Release stale locks from crashed instances
 * @returns {Promise<number>} - Number of released locks
 */
export async function releaseStaleLocks() {
  const timeoutSeconds = Math.floor(config.queue.lockTimeoutMs / 1000);

  const { data, error } = await supabase.rpc('release_stale_queue_locks', {
    p_timeout_seconds: timeoutSeconds,
  });

  if (error) {
    console.error('Error releasing stale locks:', error);
    return 0;
  }

  return data || 0;
}

/**
 * Get all conversation IDs with pending messages ready to process
 * Used by cron job for fallback processing
 * @returns {Promise<Array<string>>} - Array of conversation IDs
 */
export async function getConversationsWithPendingMessages() {
  const { data, error } = await supabase
    .from('message_queue')
    .select('conversation_id')
    .eq('status', 'pending')
    .lte('process_after', new Date().toISOString());

  if (error) {
    console.error('Error getting conversations with pending messages:', error);
    return [];
  }

  // Deduplicate conversation IDs
  return [...new Set((data || []).map(d => d.conversation_id))];
}

/**
 * Get queue statistics for monitoring
 * @returns {Promise<Object>} - Queue stats
 */
export async function getQueueStats() {
  const { data: pending } = await supabase
    .from('message_queue')
    .select('id', { count: 'exact' })
    .eq('status', 'pending');

  const { data: processing } = await supabase
    .from('message_queue')
    .select('id', { count: 'exact' })
    .eq('status', 'processing');

  const { data: failed } = await supabase
    .from('message_queue')
    .select('id', { count: 'exact' })
    .eq('status', 'failed');

  return {
    pending: pending?.length || 0,
    processing: processing?.length || 0,
    failed: failed?.length || 0,
  };
}
