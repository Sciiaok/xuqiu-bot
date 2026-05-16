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
 * 写入策略：medici 主路径走 replaceConversationLeads（删旧批 + 插新批），它
 * 由 lib/session.js 在每次 medici 输出后调用。createLead / updateLead /
 * updateLeadFields 仅给手动审批 / 测试脚本 / 旧 cron 用，主流程不走。
 *
 * `incoterm` 在写入处归一（normalizeIncoterm），既接受 `incoterm` 也接受
 * `international_commercial_term` 命名 —— 两个名字业内通用，前端/LLM 输出
 * 哪个都行。
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
 * Create a new lead
 * @param {Object} leadData - Lead data
 * @returns {Promise<Object>} - Created lead
 */
export async function createLead(leadData) {
  const { data, error } = await supabase
    .from('leads')
    .insert({
      conversation_id: leadData.conversationId,
      contact_id: leadData.contactId,
      meta_ad_id: leadData.metaAdId || null,
      score: leadData.score || 0,
      route: leadData.route || 'CONTINUE',
      inquiry_quality: leadData.inquiryQuality || 'GOOD',
      business_value: leadData.businessValue || 'LOW',
      conversation_intent: leadData.conversationIntent || null,
      destination_country: leadData.destinationCountry || null,
      destination_port: leadData.destinationPort || null,
      car_model: leadData.carModel || null,
      qty_bucket: leadData.qtyBucket || null,
      buyer_type: leadData.buyerType || null,
      timeline: leadData.timeline || null,
      incoterm: normalizeIncoterm(leadData.incoterm),
      loading_port: leadData.loadingPort || null,
      extra_data: leadData.extraData || {},
      handoff_summary: leadData.handoffSummary || null,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  console.log(`Created new lead ${data.id} for conversation ${leadData.conversationId}`);
  return data;
}

/**
 * Update lead
 * @param {string} leadId - Lead UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Updated lead
 */
export async function updateLead(leadId, updates) {
  const updateData = {
    updated_at: new Date().toISOString(),
  };

  // Map camelCase to snake_case
  if (updates.score !== undefined) updateData.score = updates.score;
  if (updates.route !== undefined) updateData.route = updates.route;
  if (updates.brand !== undefined) updateData.brand = updates.brand;
  // New inquiry_quality schema fields
  if (updates.inquiry_quality !== undefined) updateData.inquiry_quality = updates.inquiry_quality;
  if (updates.business_value !== undefined) updateData.business_value = updates.business_value;
  if (updates.conversation_intent !== undefined) updateData.conversation_intent = updates.conversation_intent;
  if (updates.conversation_intent_summary !== undefined) updateData.conversation_intent_summary = updates.conversation_intent_summary;
  if (updates.destinationCountry !== undefined) updateData.destination_country = updates.destinationCountry;
  if (updates.destinationPort !== undefined) updateData.destination_port = updates.destinationPort;
  if (updates.carModel !== undefined) updateData.car_model = updates.carModel;
  if (updates.qtyBucket !== undefined) updateData.qty_bucket = updates.qtyBucket;
  if (updates.buyerType !== undefined) updateData.buyer_type = updates.buyerType;
  if (updates.timeline !== undefined) updateData.timeline = updates.timeline;
  if (updates.incoterm !== undefined) updateData.incoterm = normalizeIncoterm(updates.incoterm);
  if (updates.loadingPort !== undefined) updateData.loading_port = updates.loadingPort;
  if (updates.international_commercial_term !== undefined) {
    updateData.incoterm = normalizeIncoterm(updates.international_commercial_term);
  }
  if (updates.extraData !== undefined) updateData.extra_data = updates.extraData;
  if (updates.handoffSummary !== undefined) updateData.handoff_summary = updates.handoffSummary;
  if (updates.colorQuantity !== undefined) updateData.color_quantity = updates.colorQuantity;
  if (updates.leadKey !== undefined) updateData.lead_key = updates.leadKey;
  if (updates.metaAdId !== undefined) updateData.meta_ad_id = updates.metaAdId;
  if (updates.meta_ad_id !== undefined) updateData.meta_ad_id = updates.meta_ad_id;

  const { data, error } = await supabase
    .from('leads')
    .update(updateData)
    .eq('id', leadId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Get all leads with pagination
 * @param {Object} options - Query options
 * @returns {Promise<Array>} - Array of leads with related data
 */
export async function getLeadsWithDetails(options = {}) {
  const { limit = 50, offset = 0, minScore, maxScore } = options;

  let query = supabase
    .from('leads')
    .select(`
      *,
      contact:contacts(wa_id, company_name),
      conversation:conversations(status, last_message_at, message_count)
    `)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (minScore !== undefined) {
    query = query.gte('score', minScore);
  }

  if (maxScore !== undefined) {
    query = query.lte('score', maxScore);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  return data || [];
}

/**
 * Get lead data formatted like old session.lead_data
 * For backward compatibility with UI components
 * @param {Object} lead - Lead object
 * @returns {Object} - lead_data formatted object
 */
export function formatLeadDataForUI(lead) {
  return {
    destination_country: lead.destination_country || '',
    destination_port: lead.destination_port || '',
    qty_bucket: lead.qty_bucket || '',
    car_model: lead.car_model || '',
    company_name: lead.contact?.company_name || '',
    loading_port: lead.loading_port || '',
    buyer_type: lead.buyer_type || '',
    timeline: lead.timeline || '',
    budget_indication: lead.extra_data?.budget_indication || '',
    international_commercial_term: lead.incoterm || '',
    // New inquiry_quality schema fields
    inquiry_quality: lead.inquiry_quality || 'GOOD',
    business_value: lead.business_value || 'LOW',
    conversation_intent: lead.conversation_intent || '',
  };
}

/**
 * Approve a lead
 * @param {string} leadId
 * @param {string} approvedBy - 'auto' or 'manual'
 * @returns {Promise<Object>}
 */
export async function approveLead(leadId, approvedBy = 'manual') {
  const { data, error } = await supabase
    .from('leads')
    .update({
      approved: true,
      approved_at: new Date().toISOString(),
      approved_by: approvedBy,
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Batch approve leads
 * @param {string[]} leadIds
 * @param {string} approvedBy
 * @returns {Promise<number>} - Count of approved leads
 */
export async function batchApproveLeads(leadIds, approvedBy = 'manual') {
  const { data, error } = await supabase
    .from('leads')
    .update({
      approved: true,
      approved_at: new Date().toISOString(),
      approved_by: approvedBy,
      updated_at: new Date().toISOString(),
    })
    .in('id', leadIds)
    .eq('approved', false)
    .select('id');

  if (error) throw error;
  return data?.length || 0;
}

/**
 * Get approved leads that need sync (last 24h, no successful sync)
 * @returns {Promise<Array>}
 */
export async function getLeadsNeedingSync({ tenantId } = {}) {
  if (!tenantId) throw new Error('getLeadsNeedingSync: tenantId required');
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('leads')
    .select(`
      *,
      contact:contacts(wa_id, company_name, name)
    `)
    .eq('tenant_id', tenantId)
    .eq('approved', true)
    .gte('approved_at', twentyFourHoursAgo)
    .order('approved_at', { ascending: true });

  if (error) throw error;
  return data || [];
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
 * Update lead fields
 * @param {string} leadId
 * @param {Object} fields
 * @returns {Promise<Object>}
 */
export async function updateLeadFields(leadId, fields) {
  const updateData = {
    updated_at: new Date().toISOString(),
  };

  // Map all supported fields
  const fieldMap = {
    brand: 'brand',
    carModel: 'car_model',
    destinationCountry: 'destination_country',
    destinationPort: 'destination_port',
    qtyBucket: 'qty_bucket',
    buyerType: 'buyer_type',
    timeline: 'timeline',
    incoterm: 'incoterm',
    loadingPort: 'loading_port',
    approved: 'approved',
    score: 'score',
    route: 'route',
    handoffSummary: 'handoff_summary',
    metaAdId: 'meta_ad_id',
    // New inquiry_quality schema fields
    inquiryQuality: 'inquiry_quality',
    businessValue: 'business_value',
    conversationIntent: 'conversation_intent',
  };

  for (const [camelKey, snakeKey] of Object.entries(fieldMap)) {
    if (fields[camelKey] !== undefined) {
      updateData[snakeKey] = fields[camelKey];
    }
    // Also check snake_case keys from API
    if (fields[snakeKey] !== undefined) {
      updateData[snakeKey] = fields[snakeKey];
    }
  }

  // Handle approval timestamp
  if (fields.approved === true) {
    updateData.approved_at = new Date().toISOString();
    updateData.approved_by = 'manual';
  }

  if (updateData.incoterm !== undefined) {
    updateData.incoterm = normalizeIncoterm(updateData.incoterm);
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
 * Replace all leads for a conversation with new leads from Claude
 *
 * ⚠️ TODO: 潜在事务问题
 * 当前实现先删除后插入，非原子操作。如果插入失败，会导致数据丢失。
 * 后续可考虑：
 * 1. 使用软删除 (replaced_at 字段) 实现回滚
 * 2. 使用 Supabase RPC 事务函数
 * 3. 使用 Postgres 存储过程
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

  // Step 1: 删除该会话所有现有 leads
  // ⚠️ 注意：此处与下方插入不在同一事务中
  const { error: deleteError } = await supabase
    .from('leads')
    .delete()
    .eq('conversation_id', conversationId);

  if (deleteError) {
    console.error('Error deleting leads:', deleteError);
    throw deleteError;
  }

  // Step 2: 如果没有新 leads，直接返回空数组
  if (!newLeads || newLeads.length === 0) {
    console.log(`Deleted all leads for conversation ${conversationId}, no new leads to insert`);
    return [];
  }

  // Step 3: 批量插入新 leads
  const leadsToInsert = newLeads.map(lead => {
    // 双写阶段：details 与硬编码 incoterm 列必须同源（normalizer 保留 LLM 原值，
    // 这里把 details 中对应字段也归一化，避免出现 "FOB, CIF" vs "FOB,CIF" 这种脏数据）
    const normalizedIncoterm = normalizeIncoterm(lead.international_commercial_term || lead.incoterm);
    const detailsObj = { ...(lead.details || {}) };
    if (detailsObj.international_commercial_term !== undefined) {
      if (normalizedIncoterm) detailsObj.international_commercial_term = normalizedIncoterm;
      else delete detailsObj.international_commercial_term;
    }

    return {
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: contactId,
      meta_ad_id: lead.meta_ad_id || lead.metaAdId || null,
      car_model: lead.car_model || null,
      destination_country: lead.destination_country || null,
      destination_port: lead.destination_port || null,
      color_quantity: lead.color_quantity || [],
      inquiry_quality: lead.inquiry_quality || 'GOOD',
      business_value: lead.business_value || 'LOW',
      conversation_intent: lead.conversation_intent || null,
      conversation_intent_summary: lead.conversation_intent_summary || null,
      route: lead.route || 'CONTINUE',
      brand: lead.brand || null,
      incoterm: normalizedIncoterm,
      timeline: lead.timeline || null,
      company_name: lead.company_name || null,
      loading_port: lead.loading_port || null,
      buyer_type: lead.buyer_type || null,
      qty_bucket: lead.qty_bucket || null,
      agent_id: lead.agent_id || null,
      product_name: lead.product_name || null,
      sku_description: lead.sku_description || null,
      details: detailsObj,
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

  console.log(`Replaced leads for conversation ${conversationId}: deleted old, inserted ${data.length} new`);
  return data;
}
