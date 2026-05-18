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
 * Find active conversation for a contact (within tenant), optionally scoped to an agent.
 * tenantId 必填 —— repository 层必须 tenant-aware。
 */
export async function findActiveConversation({ tenantId, contactId, agentId = null }) {
  if (!tenantId || !contactId) {
    throw new Error('findActiveConversation: tenantId and contactId are required');
  }
  let query = supabase
    .from('conversations')
    .select('*')
    .eq('tenant_id', tenantId)
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
 * Find the most recent active conversation for a contact within tenant, regardless
 * of agent binding. tenantId 必填。
 */
export async function findLatestActiveConversation({ tenantId, contactId }) {
  if (!tenantId || !contactId) {
    throw new Error('findLatestActiveConversation: tenantId and contactId are required');
  }
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('contact_id', contactId)
    .eq('status', 'active')
    .order('last_message_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data || null;
}

/**
 * Create a new conversation
 * Handles race conditions with unique constraint on (contact_id) WHERE status='active'
 * @param {string} contactId - Contact UUID
 * @param {string|null} agentId - Agent UUID
 * @param {string|null} waPhoneNumberId - WhatsApp business phone number ID that received the inbound message
 * @returns {Promise<Object>} - Created conversation
 */
/**
 * 新版 createConversation：所有参数 named。tenantId 必填，会显式写到 conversations.tenant_id
 * 而不是依赖 DEFAULT 兜底。老调用方传位置参数会在内部规范化。
 */
export async function createConversation(opts, ...rest) {
  const { tenantId, contactId, agentId, waPhoneNumberId, metaAdId } = normalizeCreateConversationArgs(opts, rest);
  if (!tenantId) {
    throw new Error('createConversation: tenantId required');
  }

  const { data, error } = await supabase
    .from('conversations')
    .insert({
      tenant_id: tenantId,
      contact_id: contactId,
      agent_id: agentId,
      wa_phone_number_id: waPhoneNumberId,
      meta_ad_id: metaAdId,
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
      const existing = await findActiveConversation({ tenantId, contactId, agentId });
      if (existing) return existing;
    }
    throw error;
  }

  console.log(`Created new conversation ${data.id} for contact ${contactId}`);
  return data;
}

function normalizeCreateConversationArgs(first, rest) {
  // 新风格：单 object 参数
  if (first && typeof first === 'object' && !Array.isArray(first)) {
    return {
      tenantId: first.tenantId,
      contactId: first.contactId,
      agentId: first.agentId ?? null,
      waPhoneNumberId: first.waPhoneNumberId ?? null,
      metaAdId: first.metaAdId ?? null,
    };
  }
  // 老位置参数风格 (contactId, agentId, waPhoneNumberId, metaAdId) — 缺 tenantId
  return {
    tenantId: null,
    contactId: first,
    agentId: rest[0] ?? null,
    waPhoneNumberId: rest[1] ?? null,
    metaAdId: rest[2] ?? null,
  };
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
  // 原子自增 —— 走 increment_conversation_message_count RPC，避免和 operator
  // 通过 inbox 同时写时丢更新。详见 2026-05-18-conversations-message-count-rpc.sql。
  const { data, error } = await supabase.rpc('increment_conversation_message_count', {
    p_conversation_id: conversationId,
  });

  if (error) throw error;
  // RPC RETURN TABLE 返回数组，取第一行回传保持调用方 API 不变。
  return Array.isArray(data) ? data[0] : data;
}

/**
 * Update the WhatsApp business phone number ID on a conversation.
 * @param {string} conversationId - Conversation UUID
 * @param {string|null} waPhoneNumberId - WhatsApp business phone number ID
 * @returns {Promise<Object>} - Updated conversation
 */
export async function updateConversationPhoneNumberId(conversationId, waPhoneNumberId) {
  const { data, error } = await supabase
    .from('conversations')
    .update({
      wa_phone_number_id: waPhoneNumberId || null,
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
 * Update attribution fields on a conversation.
 * @param {string} conversationId - Conversation UUID
 * @param {Object} attributes
 * @param {string|null} [attributes.metaAdId] - Meta ad ID
 * @returns {Promise<Object>} - Updated conversation
 */
export async function updateConversationAttribution(conversationId, attributes = {}) {
  const updateData = {};

  if (attributes.metaAdId !== undefined) {
    updateData.meta_ad_id = attributes.metaAdId || null;
  }

  if (Object.keys(updateData).length === 0) {
    return findConversationById(conversationId);
  }

  const { data, error } = await supabase
    .from('conversations')
    .update(updateData)
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
 * @param {string|null} waPhoneNumberId - WhatsApp business phone number ID that received the inbound message
 * @returns {Promise<Object>} - Conversation object
 */
export async function getOrCreateConversation(arg, ...rest) {
  // 新风格：{ tenantId, contactId, agentId, waPhoneNumberId }
  // 老风格：(contactId, agentId, waPhoneNumberId) — 仅在 V1 founder-only 兼容路径
  const normalized = arg && typeof arg === 'object' && !Array.isArray(arg)
    ? {
        tenantId: arg.tenantId,
        contactId: arg.contactId,
        agentId: arg.agentId ?? null,
        waPhoneNumberId: arg.waPhoneNumberId ?? null,
      }
    : {
        tenantId: null,
        contactId: arg,
        agentId: rest[0] ?? null,
        waPhoneNumberId: rest[1] ?? null,
      };
  const { tenantId, contactId, agentId, waPhoneNumberId } = normalized;
  if (!tenantId) {
    throw new Error('getOrCreateConversation: tenantId required');
  }

  const existing = await findActiveConversation({ tenantId, contactId, agentId });

  if (existing) {
    const daysSinceLastMessage = daysDiff(existing.last_message_at, new Date());

    if (daysSinceLastMessage >= IDLE_THRESHOLD_DAYS) {
      console.log(`Conversation ${existing.id} timed out (${daysSinceLastMessage.toFixed(1)} days), creating new one`);
      await markConversationIdle(existing.id);
      return createConversation({ tenantId, contactId, agentId, waPhoneNumberId });
    }

    if (waPhoneNumberId && existing.wa_phone_number_id !== waPhoneNumberId) {
      return updateConversationPhoneNumberId(existing.id, waPhoneNumberId);
    }

    return existing;
  }

  return createConversation({ tenantId, contactId, agentId, waPhoneNumberId });
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
  // 接管周期结束 → 清掉飞书通知去重标记，让下一次 HUMAN_NOW 重新触发一条通知。
  const { data, error } = await supabase
    .from('conversations')
    .update({
      is_human_takeover: false,
      human_takeover_at: null,
      feishu_notified_at: null,
    })
    .eq('id', conversationId)
    .select()
    .single();

  if (error) throw error;
  console.log(`Human takeover ended for conversation ${conversationId}`);
  return data;
}

/**
 * Read the feishu-handoff notification timestamp for a conversation.
 * @param {string} conversationId
 * @returns {Promise<string|null>}
 */
export async function getFeishuNotifiedAt(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('feishu_notified_at')
    .eq('id', conversationId)
    .single();

  if (error) throw error;
  return data?.feishu_notified_at || null;
}

/**
 * Mark a conversation as having sent its handoff Feishu notification for the
 * current takeover cycle. No-op if the flag is already set.
 * @param {string} conversationId
 */
export async function markFeishuNotified(conversationId) {
  const { error } = await supabase
    .from('conversations')
    .update({ feishu_notified_at: new Date().toISOString() })
    .eq('id', conversationId)
    .is('feishu_notified_at', null);

  if (error) throw error;
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
 * 检查 conversation 是否处于 FAQ_END 静默状态。和 isHumanTakeover 对称：
 * queue-processor 命中后只入库不调 Medici，直到 webhook 检测到新 CTWA
 * referral 才会调用 clearFaqEnded 重新放开。
 */
export async function isFaqEnded(conversationId) {
  const { data, error } = await supabase
    .from('conversations')
    .select('faq_ended_at')
    .eq('id', conversationId)
    .single();
  if (error) throw error;
  return Boolean(data?.faq_ended_at);
}

/**
 * 在 executeConversationRouting 走到 FAQ_END 分支末尾时调用。已 set 的话
 * 多次写入只是更新时间戳，无副作用。
 */
export async function markFaqEnded(conversationId) {
  const { error } = await supabase
    .from('conversations')
    .update({ faq_ended_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (error) throw error;
}

/**
 * 新的 CTWA referral 进来 → 视为客户新意图，放开 FAQ_END 静默。WHERE 条件
 * 让没 set 的行不会触发 UPDATE，避免多余写。
 */
export async function clearFaqEnded(conversationId) {
  const { error } = await supabase
    .from('conversations')
    .update({ faq_ended_at: null })
    .eq('id', conversationId)
    .not('faq_ended_at', 'is', null);
  if (error) throw error;
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
