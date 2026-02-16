import supabase from '../supabase.js';

/**
 * Find lead by conversation ID
 * @param {string} conversationId - Conversation UUID
 * @returns {Promise<Object|null>} - Lead object or null
 */
export async function findLeadByConversation(conversationId) {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('conversation_id', conversationId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data;
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
 * @param {string} conversationId - Conversation UUID
 * @param {string} contactId - Contact UUID
 * @returns {Promise<Object>} - Lead object
 */
export async function findOrCreateLead(conversationId, contactId) {
  let lead = await findLeadByConversation(conversationId);

  if (!lead) {
    lead = await createLead({ conversationId, contactId });
  }

  return lead;
}

/**
 * Update lead from Claude response
 * @param {string} leadId - Lead UUID
 * @param {Object} claudeResponse - Claude API response
 * @param {number} newScore - New total score
 * @returns {Promise<Object>} - Updated lead
 */
export async function updateLeadFromClaude(leadId, claudeResponse, newScore) {
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
  if (claudeResponse.handoff_summary) updates.handoffSummary = claudeResponse.handoff_summary;

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
  };
}
