import supabase from '../supabase.js';

const INCOTERM_ORDER = ['FOB', 'CIF', 'EXW', 'DDP'];
const ALLOWED_INCOTERMS = new Set(INCOTERM_ORDER);

function normalizeIncoterm(value) {
  if (value === null || value === undefined) return null;

  const raw = String(value).trim().toUpperCase();
  if (!raw) return null;

  // Normalize separators and conjunctions into comma.
  const normalized = raw
    .replace(/\bAND\b/g, ',')
    .replace(/[|/&;+，、]+/g, ',')
    .replace(/\s+/g, '');

  const tokenSet = new Set();
  for (const token of normalized.split(',').filter(Boolean)) {
    if (token === 'BOTH') {
      tokenSet.add('FOB');
      tokenSet.add('CIF');
      continue;
    }
    if (ALLOWED_INCOTERMS.has(token)) tokenSet.add(token);
  }

  const ordered = INCOTERM_ORDER.filter((term) => tokenSet.has(term));
  return ordered.length > 0 ? ordered.join(',') : null;
}

/**
 * Lead Repository — leads 表读写。
 *
 * 写入策略：medici 主路径走 replaceConversationLeads（删旧批 + 插新批），由
 * lib/session.js 在每次 medici 输出后调用。updateLead 给路由层（routing.service）
 * 改 route 用；updateLeadFields 给 /api/leads/[id] PATCH 用。
 *
 * 业务字段（brand / car_model / destination_* / 等）全部存 details JSONB；
 * leads 表的 13 个硬编码业务列已 DEPRECATED，不再写入（仍保留以备回滚，阶段 3 drop）。
 *
 * `international_commercial_term` 在写入处归一（normalizeIncoterm），存到
 * details.international_commercial_term。
 */

/**
 * Find lead by ID
 * @param {string} leadId - Lead UUID
 * @returns {Promise<Object|null>} - Lead object or null
 */
export async function findLeadById(leadId) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('id', leadId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data;
}

/**
 * Find first lead by conversation ID
 * Returns the earliest created lead (default lead)
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object|null>} - Lead object or null
 */
export async function findLeadByConversation(conversationId) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (error) {
    throw error;
  }

  return data && data.length > 0 ? data[0] : null;
}

/**
 * Update lead — 仅支持评分元数据 + 系统字段。业务字段编辑请用 updateLeadFields
 * （走 details JSONB）。
 */
export async function updateLead(leadId, updates) {
  const updateData = { updated_at: new Date().toISOString() };

  if (updates.route !== undefined) updateData.route = updates.route;
  if (updates.inquiry_quality !== undefined) updateData.inquiry_quality = updates.inquiry_quality;
  if (updates.business_value !== undefined) updateData.business_value = updates.business_value;
  if (updates.conversation_intent !== undefined) updateData.conversation_intent = updates.conversation_intent;
  if (updates.conversation_intent_summary !== undefined) updateData.conversation_intent_summary = updates.conversation_intent_summary;
  if (updates.handoffSummary !== undefined) updateData.handoff_summary = updates.handoffSummary;
  if (updates.metaAdId !== undefined) updateData.meta_ad_id = updates.metaAdId;
  if (updates.meta_ad_id !== undefined) updateData.meta_ad_id = updates.meta_ad_id;

  const { data, error } = await supabase
    .from('leads')
    .update(updateData)
    .eq('id', leadId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get lead data formatted like old session.lead_data
 * For backward compatibility with UI components
 * @param {Object} lead - Lead object
 * @returns {Object} - lead_data formatted object
 */
export function formatLeadDataForUI(lead) {
  const d = lead.details || {};
  return {
    destination_country: d.destination_country || '',
    destination_port: d.destination_port || '',
    qty_bucket: d.qty_bucket || '',
    car_model: d.car_model || '',
    company_name: lead.contact?.company_name || '',
    loading_port: d.loading_port || '',
    buyer_type: d.buyer_type || '',
    timeline: d.timeline || '',
    international_commercial_term: d.international_commercial_term || '',
    // 评分类元数据继续从顶层列读（不在通用化迁移范围）
    inquiry_quality: lead.inquiry_quality || 'GOOD',
    business_value: lead.business_value || 'LOW',
    conversation_intent: lead.conversation_intent || '',
  };
}

/**
 * Get lead by ID with contact info
 * @param {string} leadId
 * @returns {Promise<Object|null>}
 */
export async function getLeadById(leadId) {
  const { data, error } = await supabase
    .from('leads')
    .select(`
      *,
      contact:contacts(wa_id, company_name, name)
    `)
    .eq('id', leadId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/**
 * Get leads for a conversation filtered by route
 * @param {string} conversationId - Conversation UUID
 * @param {string} [route='CONTINUE'] - Route to filter by
 * @returns {Promise<Array>} - Array of lead objects
 */
export async function getLeadsByConversation(conversationId, route = 'CONTINUE') {
  const { data, error } = await supabase
    .from('leads')
    .select('*, contact:contacts(wa_id, name, company_name)')
    .eq('conversation_id', conversationId)
    .eq('route', route)
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

/**
 * Update lead fields.
 *
 * 业务字段（brand / car_model / destination_* / 等）走 details JSONB 的
 * read-modify-write；评分/系统字段直接写顶层列。
 *
 * @param {string} leadId
 * @param {Object} fields  接受 camelCase 或 snake_case key。incoterm /
 *                         international_commercial_term 都接受，统一存到
 *                         details.international_commercial_term。
 */
export async function updateLeadFields(leadId, fields) {
  // 业务字段（camelKey → details 里的 key 名）
  const DETAILS_FIELDS = {
    brand: 'brand',
    carModel: 'car_model',
    destinationCountry: 'destination_country',
    destinationPort: 'destination_port',
    loadingPort: 'loading_port',
    qtyBucket: 'qty_bucket',
    buyerType: 'buyer_type',
    timeline: 'timeline',
    colorQuantity: 'color_quantity',
    productName: 'product_name',
    skuDescription: 'sku_description',
    companyName: 'company_name',
    incoterm: 'international_commercial_term',  // alias
  };

  // 评分元数据 / 系统字段（camelKey → 顶层列名）
  const SCALAR_FIELDS = {
    route: 'route',
    handoffSummary: 'handoff_summary',
    metaAdId: 'meta_ad_id',
    inquiryQuality: 'inquiry_quality',
    businessValue: 'business_value',
    conversationIntent: 'conversation_intent',
  };

  // 1. 收集 details 字段更新
  const detailsPatches = {};
  for (const [camelKey, detailsKey] of Object.entries(DETAILS_FIELDS)) {
    let value = fields[camelKey];
    if (value === undefined) value = fields[detailsKey];
    // incoterm 还接受 'incoterm' 作为 snake_case 输入
    if (value === undefined && camelKey === 'incoterm') value = fields.incoterm;
    if (value === undefined) continue;
    detailsPatches[detailsKey] = camelKey === 'incoterm' ? normalizeIncoterm(value) : value;
  }

  // 2. 收集顶层字段更新
  const updateData = { updated_at: new Date().toISOString() };
  for (const [camelKey, snakeKey] of Object.entries(SCALAR_FIELDS)) {
    if (fields[camelKey] !== undefined) updateData[snakeKey] = fields[camelKey];
    else if (fields[snakeKey] !== undefined) updateData[snakeKey] = fields[snakeKey];
  }

  // 3. 如有 details 改动，read-modify-write
  if (Object.keys(detailsPatches).length > 0) {
    const { data: cur, error: getErr } = await supabase
      .from('leads').select('details').eq('id', leadId).single();
    if (getErr) throw getErr;
    const merged = { ...(cur?.details || {}) };
    for (const [k, v] of Object.entries(detailsPatches)) {
      if (v === null || v === '' || v === undefined) delete merged[k];
      else merged[k] = v;
    }
    updateData.details = merged;
  }

  const { data, error } = await supabase
    .from('leads')
    .update(updateData)
    .eq('id', leadId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Replace all leads for a conversation with new leads from Claude.
 *
 * ⚠️ TODO: 潜在事务问题
 * 当前实现先删除后插入，非原子操作。如果插入失败，会导致数据丢失。
 * 后续可考虑：
 * 1. 使用软删除 (replaced_at 字段) 实现回滚
 * 2. 使用 Supabase RPC 事务函数
 * 3. 使用 Postgres 存储过程
 *
 * **Details merge（2026-05-29 加）**：
 * 单 lead 会话时，把旧 lead.details 作为底，新 lead.details 上叠 ——
 * 旧 schema 已删的 key 保留在 details 里（不被覆盖也不被删）。这是为
 * 了让"线上改 product_lines.lead_fields"操作不会把历史信息永久抹掉
 * （CLAUDE.md "forward compatibility"）。多 lead 场景没有稳定的"哪
 * 条对应哪条"匹配键，退化到不 merge（多 lead 跨产品线场景罕见，且
 * Medici 下一轮通常能从对话上下文重建）。
 *
 * @param {string} conversationId - Conversation UUID
 * @param {string} contactId - Contact UUID
 * @param {Array} newLeads - Array of lead objects from Claude
 * @returns {Promise<Array>} - Array of created leads
 */
export async function replaceConversationLeads(conversationId, contactId, newLeads, { tenantId } = {}) {
  if (!tenantId) {
    throw new Error('replaceConversationLeads: tenantId required');
  }

  // Step 1: 取旧批 details 用于 merge（单 lead 才用得上）
  const { data: existingLeads, error: fetchError } = await supabase
    .from('leads')
    .select('id, details')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });
  if (fetchError) {
    console.error('Error fetching existing leads:', fetchError);
    throw fetchError;
  }

  // Step 2: 删除该会话所有现有 leads
  // ⚠️ 注意：此处与下方插入不在同一事务中
  const { error: deleteError } = await supabase
    .from('leads')
    .delete()
    .eq('conversation_id', conversationId);

  if (deleteError) {
    console.error('Error deleting leads:', deleteError);
    throw deleteError;
  }

  // Step 3: 如果没有新 leads，直接返回空数组
  if (!newLeads || newLeads.length === 0) {
    console.log(`Deleted all leads for conversation ${conversationId}, no new leads to insert`);
    return [];
  }

  // 单 lead → 1:1 merge；多 lead 不 merge（见函数 doc）。
  const canMerge = existingLeads?.length === 1 && newLeads.length === 1;
  const priorDetailsForMerge = canMerge ? (existingLeads[0].details || {}) : null;

  // Step 4: 批量插入新 leads。业务字段全部走 details JSONB；硬编码业务列已
  // DEPRECATED 不再写入。仅对 details.international_commercial_term 归一化
  // (FOB, CIF → FOB,CIF) 保证落库格式稳定。
  const leadsToInsert = newLeads.map(lead => {
    const newDetails = { ...(lead.details || {}) };
    if (newDetails.international_commercial_term !== undefined) {
      const normalized = normalizeIncoterm(newDetails.international_commercial_term);
      if (normalized) newDetails.international_commercial_term = normalized;
      else delete newDetails.international_commercial_term;
    }
    const mergedDetails = priorDetailsForMerge
      ? { ...priorDetailsForMerge, ...newDetails }
      : newDetails;

    return {
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: contactId,
      meta_ad_id: lead.meta_ad_id || lead.metaAdId || null,
      inquiry_quality: lead.inquiry_quality || 'GOOD',
      business_value: lead.business_value || 'LOW',
      conversation_intent: lead.conversation_intent || null,
      conversation_intent_summary: lead.conversation_intent_summary || null,
      route: lead.route || 'CONTINUE',
      product_line: lead.product_line || null,
      details: mergedDetails,
    };
  });

  const { data, error: insertError } = await supabase
    .from('leads')
    .insert(leadsToInsert)
    .select();

  if (insertError) {
    console.error('Error inserting leads:', insertError);
    throw insertError;
  }

  console.log(`Replaced leads for conversation ${conversationId}: deleted ${existingLeads?.length || 0}, inserted ${data.length} (merged=${canMerge})`);
  return data;
}
