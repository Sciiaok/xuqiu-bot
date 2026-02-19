import supabase from '../supabase.js';

/**
 * Merge color_quantity arrays
 * - Same color: update qty (overwrite)
 * - Different color: append to array
 * @param {Array} existing - Existing color_quantity array
 * @param {Array} incoming - New color_quantity array from Claude
 * @returns {Array} - Merged color_quantity array
 */
function mergeColorQuantity(existing, incoming) {
  if (!incoming || incoming.length === 0) return existing || [];
  if (!existing || existing.length === 0) return incoming;

  const merged = [...existing];

  for (const newItem of incoming) {
    if (!newItem.color) continue;

    const existingIndex = merged.findIndex(
      item => item.color?.toLowerCase() === newItem.color?.toLowerCase()
    );

    if (existingIndex >= 0) {
      // Same color: update qty
      merged[existingIndex] = { ...merged[existingIndex], qty: newItem.qty };
    } else {
      // Different color: append
      merged.push(newItem);
    }
  }

  return merged;
}

/**
 * Check if lead_key contains destination
 * @param {string} leadKey - Lead key string
 * @returns {boolean}
 */
function leadKeyHasDestination(leadKey) {
  return leadKey && leadKey.includes('dest:');
}

/**
 * Extract car_model part only from lead_key
 * "model:seal|dest:uae" → "model:seal"
 * @param {string} leadKey - Lead key string
 * @returns {string|null}
 */
function extractCarModelKey(leadKey) {
  if (!leadKey) return null;
  const parts = leadKey.split('|');
  const modelPart = parts.find(p => p.startsWith('model:'));
  return modelPart || null;
}

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
      stage: leadData.stage || 'GREET',
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
      incoterm: leadData.incoterm || null,
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
  if (updates.stage !== undefined) updateData.stage = updates.stage;
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
  if (updates.incoterm !== undefined) updateData.incoterm = updates.incoterm;
  if (updates.loadingPort !== undefined) updateData.loading_port = updates.loadingPort;
  if (updates.extraData !== undefined) updateData.extra_data = updates.extraData;
  if (updates.handoffSummary !== undefined) updateData.handoff_summary = updates.handoffSummary;
  if (updates.colorQuantity !== undefined) updateData.color_quantity = updates.colorQuantity;
  if (updates.leadKey !== undefined) updateData.lead_key = updates.leadKey;

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
 * Find or create lead for a conversation
 * Uses find-first pattern to avoid upsert issues with multi-lead support
 * @param {string} conversationId - Conversation UUID
 * @param {string} contactId - Contact UUID
 * @returns {Promise<Object>} - Lead object
 */
export async function findOrCreateLead(conversationId, contactId) {
  // First, try to find existing lead for this conversation
  const existing = await findLeadByConversation(conversationId);
  if (existing) {
    return existing;
  }

  // Not found, create new lead
  const { data, error } = await supabase
    .from('leads')
    .insert({
      conversation_id: conversationId,
      contact_id: contactId,
      stage: 'GREET',
      score: 0,
      route: 'CONTINUE',
      inquiry_quality: 'GOOD',
      business_value: 'LOW',
    })
    .select()
    .single();

  if (error) {
    // Race condition: another request may have created the lead
    if (error.code === '23505') {
      const existing2 = await findLeadByConversation(conversationId);
      if (existing2) return existing2;
    }
    throw error;
  }

  return data;
}

/**
 * Update lead from Claude response
 * @param {string} leadId - Lead UUID
 * @param {Object} claudeResponse - Claude API response
 * @param {number} newScore - New total score
 * @param {string} newStage - New stage (optional)
 * @returns {Promise<Object>} - Updated lead
 */
export async function updateLeadFromClaude(leadId, claudeResponse, newScore, newStage) {
  const extracted = claudeResponse.extracted_fields || {};

  const updates = {
    score: newScore,
    route: claudeResponse.route,
  };

  // Map extracted fields
  if (extracted.destination_country) updates.destinationCountry = extracted.destination_country;
  if (extracted.destination_port) updates.destinationPort = extracted.destination_port;
  if (extracted.car_model) updates.carModel = extracted.car_model;
  if (extracted.qty_bucket) updates.qtyBucket = extracted.qty_bucket;
  if (extracted.buyer_type) updates.buyerType = extracted.buyer_type;
  if (extracted.timeline) updates.timeline = extracted.timeline;
  if (extracted.international_commercial_term) updates.incoterm = extracted.international_commercial_term;
  if (extracted.loading_port) updates.loadingPort = extracted.loading_port;
  if (extracted.brand) updates.brand = extracted.brand;
  if (claudeResponse.handoff_summary) updates.handoffSummary = claudeResponse.handoff_summary;

  // Handle color_quantity merging (append new colors, update existing)
  if (extracted.color_quantity && extracted.color_quantity.length > 0) {
    const currentLead = await findLeadById(leadId);
    const existingColorQty = currentLead?.color_quantity || [];
    updates.colorQuantity = mergeColorQuantity(existingColorQty, extracted.color_quantity);
    console.log(`Merged color_quantity: ${JSON.stringify(updates.colorQuantity)}`);
  }

  // Update stage if provided
  if (newStage) {
    updates.stage = newStage;

    // Auto-approve when reaching PROOF stage
    if (newStage === 'PROOF') {
      const updateData = {
        updated_at: new Date().toISOString(),
        stage: newStage,
        approved: true,
        approved_at: new Date().toISOString(),
        approved_by: 'auto',
      };

      // Also apply other updates
      if (updates.score !== undefined) updateData.score = updates.score;
      if (updates.route !== undefined) updateData.route = updates.route;
      if (updates.destinationCountry) updateData.destination_country = updates.destinationCountry;
      if (updates.destinationPort) updateData.destination_port = updates.destinationPort;
      if (updates.carModel) updateData.car_model = updates.carModel;
      if (updates.qtyBucket) updateData.qty_bucket = updates.qtyBucket;
      if (updates.buyerType) updateData.buyer_type = updates.buyerType;
      if (updates.timeline) updateData.timeline = updates.timeline;
      if (updates.incoterm) updateData.incoterm = updates.incoterm;
      if (updates.loadingPort) updateData.loading_port = updates.loadingPort;
      if (updates.brand) updateData.brand = updates.brand;
      if (updates.handoffSummary) updateData.handoff_summary = updates.handoffSummary;

      const { data, error } = await supabase
        .from('leads')
        .update(updateData)
        .eq('id', leadId)
        .select()
        .single();

      if (error) throw error;
      console.log(`Lead ${leadId} auto-approved on reaching PROOF stage`);
      return data;
    }
  }

  return updateLead(leadId, updates);
}

/**
 * Get all leads with pagination
 * @param {Object} options - Query options
 * @returns {Promise<Array>} - Array of leads with related data
 */
export async function getLeadsWithDetails(options = {}) {
  const { limit = 50, offset = 0, stage, minScore, maxScore } = options;

  let query = supabase
    .from('leads')
    .select(`
      *,
      contact:contacts(wa_id, company_name),
      conversation:conversations(status, last_message_at, message_count)
    `)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (stage) {
    query = query.eq('stage', stage);
  }

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
export async function getLeadsNeedingSync() {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('leads')
    .select(`
      *,
      contact:contacts(wa_id, company_name, name)
    `)
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
 * Find or create lead by lead_key within a conversation
 * Uses lead_key for multi-lead support within same conversation
 * Supports merging: if new lead has destination and existing lead has same car_model but no destination, merge them
 * @param {string} conversationId - Conversation UUID
 * @param {string} contactId - Contact UUID
 * @param {string|null} leadKey - Lead identifier key (e.g., "model:byd seal|dest:uae")
 * @returns {Promise<Object>} - Lead object
 */
export async function findOrCreateLeadByKey(conversationId, contactId, leadKey) {
  // If no leadKey, use the default lead (backward compatibility)
  if (!leadKey) {
    return findOrCreateLead(conversationId, contactId);
  }

  // 1. Try to find existing active lead with exact key match
  const { data: exactMatch, error: findError } = await supabase
    .from('leads')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('lead_key', leadKey)
    .eq('route', 'CONTINUE')
    .maybeSingle();

  if (findError) {
    throw findError;
  }

  if (exactMatch) {
    return exactMatch;
  }

  // 2. Try merge: if new lead has destination, find lead with same car_model but no destination
  if (leadKeyHasDestination(leadKey)) {
    const carModelKey = extractCarModelKey(leadKey);
    if (carModelKey) {
      const { data: mergeable, error: mergeError } = await supabase
        .from('leads')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('lead_key', carModelKey)
        .eq('route', 'CONTINUE')
        .maybeSingle();

      if (mergeError) {
        throw mergeError;
      }

      if (mergeable) {
        // Update the existing lead's key to include destination
        console.log(`Merging lead ${mergeable.id}: ${carModelKey} → ${leadKey}`);
        await updateLead(mergeable.id, { leadKey: leadKey });
        return { ...mergeable, lead_key: leadKey };
      }
    }
  }

  // 3. Create new lead with lead_key
  const { data, error } = await supabase
    .from('leads')
    .insert({
      conversation_id: conversationId,
      contact_id: contactId,
      lead_key: leadKey,
      stage: 'GREET',
      score: 0,
      route: 'CONTINUE',
      inquiry_quality: 'GOOD',
      business_value: 'LOW',
    })
    .select()
    .single();

  if (error) {
    // Handle race condition: another request may have created the lead
    if (error.code === '23505') { // unique_violation
      const { data: existing2 } = await supabase
        .from('leads')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('lead_key', leadKey)
        .eq('route', 'CONTINUE')
        .single();
      if (existing2) return existing2;
    }
    throw error;
  }

  console.log(`Created new lead ${data.id} with key: ${leadKey}`);
  return data;
}

/**
 * Get all active leads for a conversation (route='CONTINUE' means active)
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Array>} - Array of lead objects
 */
export async function getLeadsByConversation(conversationId) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('route', 'CONTINUE')
    .order('created_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

/**
 * Update lead from individual lead data (for multi-lead processing)
 * @param {string} leadId - Lead UUID
 * @param {Object} leadData - Extracted lead fields from Claude
 * @param {number} newScore - New total score
 * @returns {Promise<Object>} - Updated lead
 */
export async function updateLeadFromClaudeFields(leadId, leadData, newScore) {
  const updates = { score: newScore };

  if (leadData.destination_country) updates.destinationCountry = leadData.destination_country;
  if (leadData.destination_port) updates.destinationPort = leadData.destination_port;
  if (leadData.car_model) updates.carModel = leadData.car_model;
  if (leadData.qty_bucket) updates.qtyBucket = leadData.qty_bucket;
  if (leadData.buyer_type) updates.buyerType = leadData.buyer_type;
  if (leadData.timeline) updates.timeline = leadData.timeline;
  if (leadData.international_commercial_term) updates.incoterm = leadData.international_commercial_term;
  if (leadData.loading_port) updates.loadingPort = leadData.loading_port;
  if (leadData.brand) updates.brand = leadData.brand;

  // color_quantity uses merge logic
  if (leadData.color_quantity && leadData.color_quantity.length > 0) {
    const currentLead = await findLeadById(leadId);
    const existingColorQty = currentLead?.color_quantity || [];
    updates.colorQuantity = mergeColorQuantity(existingColorQty, leadData.color_quantity);
    console.log(`Merged color_quantity: ${JSON.stringify(updates.colorQuantity)}`);
  }

  return updateLead(leadId, updates);
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
    stage: 'stage',
    score: 'score',
    route: 'route',
    handoffSummary: 'handoff_summary',
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
export async function replaceConversationLeads(conversationId, contactId, newLeads) {
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
  const leadsToInsert = newLeads.map(lead => ({
    conversation_id: conversationId,
    contact_id: contactId,
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
    incoterm: lead.international_commercial_term || lead.incoterm || null,
    timeline: lead.timeline || null,
    company_name: lead.company_name || null,
    loading_port: lead.loading_port || null,
    buyer_type: lead.buyer_type || null,
  }));

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
