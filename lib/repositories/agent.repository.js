import supabase from '../supabase.js';

/**
 * Find agent by ID
 * @param {string} agentId
 * @returns {Promise<Object|null>}
 */
export async function findAgentById(agentId) {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('id', agentId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/**
 * Get all agents
 * @param {boolean} [activeOnly=false]
 * @returns {Promise<Array>}
 */
export async function getAllAgents(activeOnly = false) {
  let query = supabase
    .from('agents')
    .select('*')
    .order('created_at', { ascending: true });

  if (activeOnly) {
    query = query.eq('is_active', true);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Create a new agent
 * @param {Object} agentData
 * @returns {Promise<Object>}
 */
export async function createAgent(agentData) {
  const { data, error } = await supabase
    .from('agents')
    .insert({
      name: agentData.name,
      product_line: agentData.productLine,
      system_prompt: agentData.systemPrompt,
      output_schema: agentData.outputSchema,
      ad_context_map: agentData.adContextMap || {},
      is_active: agentData.isActive ?? true,
    })
    .select()
    .single();

  if (error) throw error;
  console.log(`Created agent ${data.id}: ${data.name}`);
  return data;
}

/**
 * Update an agent
 * @param {string} agentId
 * @param {Object} updates
 * @returns {Promise<Object>}
 */
export async function updateAgent(agentId, updates) {
  const updateData = { updated_at: new Date().toISOString() };

  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.productLine !== undefined) updateData.product_line = updates.productLine;
  if (updates.systemPrompt !== undefined) updateData.system_prompt = updates.systemPrompt;
  if (updates.outputSchema !== undefined) updateData.output_schema = updates.outputSchema;
  if (updates.adContextMap !== undefined) updateData.ad_context_map = updates.adContextMap;
  if (updates.isActive !== undefined) updateData.is_active = updates.isActive;

  const { data, error } = await supabase
    .from('agents')
    .update(updateData)
    .eq('id', agentId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Deactivate agent (soft delete)
 * Prevents deactivating the last active agent
 * @param {string} agentId
 * @returns {Promise<Object>}
 */
export async function deactivateAgent(agentId) {
  const { data: activeAgents } = await supabase
    .from('agents')
    .select('id')
    .eq('is_active', true);

  if (activeAgents && activeAgents.length <= 1) {
    throw new Error('Cannot deactivate the last active agent');
  }

  return updateAgent(agentId, { isActive: false });
}
