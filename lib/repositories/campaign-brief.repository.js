import supabase from '../supabase.js';

// ── Brief CRUD ──────────────────────────────────────────────────────────

/**
 * Create a new campaign brief
 * @param {string|null} id - Optional custom UUID
 * @returns {Promise<Object>} - Created brief
 */
export async function createBrief(id = null) {
  const row = {};
  if (id) row.id = id;

  const { data, error } = await supabase
    .from('campaign_briefs')
    .insert(row)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Get a campaign brief by ID
 * @param {string} briefId - Brief UUID
 * @returns {Promise<Object|null>} - Brief object or null
 */
export async function getBrief(briefId) {
  const { data, error } = await supabase
    .from('campaign_briefs')
    .select('*')
    .eq('id', briefId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/**
 * Update a campaign brief (top-level columns)
 * @param {string} briefId - Brief UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Updated brief
 */
export async function updateBrief(briefId, { status, brief, completion, expires_at }) {
  const updateData = {};
  if (status !== undefined) updateData.status = status;
  if (brief !== undefined) updateData.brief = brief;
  if (completion !== undefined) updateData.completion = completion;
  if (expires_at !== undefined) updateData.expires_at = expires_at;

  const { data, error } = await supabase
    .from('campaign_briefs')
    .update(updateData)
    .eq('id', briefId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Merge fields into the existing brief JSONB column
 * @param {string} briefId - Brief UUID
 * @param {Object} fields - Key/value pairs to merge into brief
 * @returns {Promise<Object>} - Updated brief
 */
export async function updateBriefFields(briefId, fields) {
  const existing = await getBrief(briefId);
  if (!existing) throw new Error(`Brief ${briefId} not found`);

  const merged = { ...existing.brief, ...fields };

  const { data, error } = await supabase
    .from('campaign_briefs')
    .update({ brief: merged })
    .eq('id', briefId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Update the completion JSONB column
 * @param {string} briefId - Brief UUID
 * @param {Object} completion - Completion object
 * @returns {Promise<Object>} - Updated brief
 */
export async function updateCompletion(briefId, completion) {
  const { data, error } = await supabase
    .from('campaign_briefs')
    .update({ completion })
    .eq('id', briefId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

