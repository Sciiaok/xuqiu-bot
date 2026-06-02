import supabase from '../supabase.js';
import { getSupabaseAdmin } from '../supabase-admin.js';

/**
 * Create a new message
 * @param {Object} messageData - Message data
 * @returns {Promise<Object>} - Created message
 */
/**
 * Look up a message by its WhatsApp wamid stored in metadata.
 * Used by the coexistence echo handler to skip echoes for messages that
 * LeadEngine itself already sent (or that Meta redelivered).
 * @param {Object} args
 * @param {string} args.conversationId
 * @param {string} args.wamid - WhatsApp message id (e.g. "wamid.xxx")
 * @returns {Promise<{id: string}|null>}
 */
export async function findMessageByWamid({ conversationId, wamid }) {
  if (!conversationId || !wamid) return null;
  const { data, error } = await supabase
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('metadata->>wa_message_id', wamid)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * 全局按 wamid 反查（不限 conversation）。webhook 的 statuses 事件只带
 * wamid，没有 conversation 上下文，必须用 service-role + 全表查。
 * 返回 id + metadata 给上游算下一个 delivery 状态。
 */
export async function findMessageByWamidGlobal(wamid) {
  if (!wamid) return null;
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('messages')
    .select('id, metadata, conversation_id, tenant_id')
    .eq('metadata->>wa_message_id', wamid)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * 把新的 delivery 子对象合并写回 metadata.delivery，不动其它 metadata key。
 * 用 service-role：statuses webhook 是后台异步，且消息可能跨 tenant 写。
 */
export async function updateMessageDelivery(messageId, deliveryPatch) {
  if (!messageId || !deliveryPatch) return;
  const admin = getSupabaseAdmin();
  const { data: row, error: readErr } = await admin
    .from('messages')
    .select('metadata')
    .eq('id', messageId)
    .single();
  if (readErr || !row) {
    console.warn('[delivery] read failed', { id: messageId, err: readErr?.message });
    return;
  }
  const prevDelivery = row.metadata?.delivery || {};
  const nextMeta = {
    ...(row.metadata || {}),
    delivery: { ...prevDelivery, ...deliveryPatch },
  };
  const { error: updErr } = await admin
    .from('messages')
    .update({ metadata: nextMeta })
    .eq('id', messageId);
  if (updErr) {
    console.warn('[delivery] update failed', { id: messageId, err: updErr.message });
  }
}

/**
 * AI 自动回复(bot)发出后回填投递初始态,与人工发送路径
 * (app/api/send-message/route.js) 对齐:
 *   - metadata.wa_message_id = wamid → statuses webhook 能按 wamid 反查到本行,
 *     后续把 delivery 升级成 delivered / read / failed。
 *   - metadata.delivery = { status:'sent', sent_at } → UI 立刻显示 ✓ 角标。
 * bot 消息在 sendMessage 之前就已落库(processMessageWithSession),所以这里走
 * 一次 read-merge-write 补写,不动其它 metadata key。best-effort:失败只 warn,
 * 绝不抛 —— 调用点已过 aiReplyPersisted 分水岭,抛了会触发双发。
 * wamid 理论上 Meta 必返回;为空时只落 delivery,不写空 wamid。
 */
export async function markBotMessageSent(messageId, wamid) {
  if (!messageId) return;
  try {
    const admin = getSupabaseAdmin();
    const { data: row, error: readErr } = await admin
      .from('messages')
      .select('metadata')
      .eq('id', messageId)
      .single();
    if (readErr || !row) {
      console.warn('[delivery] bot read failed', { id: messageId, err: readErr?.message });
      return;
    }
    const nextMeta = {
      ...(row.metadata || {}),
      delivery: {
        ...(row.metadata?.delivery || {}),
        status: 'sent',
        sent_at: new Date().toISOString(),
      },
    };
    if (wamid) nextMeta.wa_message_id = wamid;
    const { error: updErr } = await admin
      .from('messages')
      .update({ metadata: nextMeta })
      .eq('id', messageId);
    if (updErr) {
      console.warn('[delivery] bot update failed', { id: messageId, err: updErr.message });
    }
  } catch (err) {
    console.warn('[delivery] bot backfill threw', { id: messageId, err: err?.message });
  }
}

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

  // Fire-and-forget 自动翻译。默认全开 —— 是否真的调 LLM 由 translate
  // .service 的 shouldSkipTranslation 拦截（已中文 / 附件 / 已缓存全跳过）。
  // 失败不能影响 message 入库，所以全部包在 try/catch 里且不 await。
  void queueAutoTranslate(data, messageData.tenantId);

  return data;
}

async function queueAutoTranslate(messageRow, tenantId) {
  try {
    if (!messageRow?.id || !messageRow?.conversation_id) return;
    const admin = getSupabaseAdmin();
    // 只为 LLM 成本日志归属拿 product_line，本身不再做开关判断。
    const { data: conv } = await admin
      .from('conversations')
      .select('product_line')
      .eq('id', messageRow.conversation_id)
      .single();
    // 动态 import 切断潜在的反向依赖；translate.service 本身依赖 llm-client，
    // 当前没有反向 import 但保留弹性。
    const { translateMessageAsync } = await import('../../src/translate.service.js');
    void translateMessageAsync(messageRow, {
      tenantId,
      productLine: conv?.product_line,
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
