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
 * Get all agents with aggregated stats (conversation count + PROOF lead count).
 *
 * Uses Supabase's embedded count aggregate for conversations/leads (single
 * round-trip) plus one extra query for PROOF-filtered lead counts — avoids
 * the N+1 client-side pattern.
 *
 * @param {boolean} [activeOnly=false]
 * @returns {Promise<Array>} agents array; each entry has `stats: { conv_count, lead_count, proof_count }`
 */
export async function getAllAgentsWithStats(activeOnly = false) {
  let agentsQuery = supabase
    .from('agents')
    .select('*, conversations(count), leads(count)')
    .order('created_at', { ascending: true });

  if (activeOnly) {
    agentsQuery = agentsQuery.eq('is_active', true);
  }

  const { data: agents, error: agentsError } = await agentsQuery;
  if (agentsError) throw agentsError;
  if (!agents || agents.length === 0) return [];

  // Supabase can't filter inside an embedded count aggregate, so fetch the
  // PROOF lead rows separately and group client-side.
  const agentIds = agents.map((a) => a.id);
  const { data: proofRows, error: proofError } = await supabase
    .from('leads')
    .select('agent_id')
    .eq('inquiry_quality', 'PROOF')
    .in('agent_id', agentIds);
  if (proofError) throw proofError;

  const proofByAgent = new Map();
  for (const row of proofRows || []) {
    proofByAgent.set(row.agent_id, (proofByAgent.get(row.agent_id) || 0) + 1);
  }

  return agents.map((agent) => {
    const { conversations, leads, ...rest } = agent;
    return {
      ...rest,
      stats: {
        conv_count: conversations?.[0]?.count ?? 0,
        lead_count: leads?.[0]?.count ?? 0,
        proof_count: proofByAgent.get(agent.id) ?? 0,
      },
    };
  });
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
      qualification_config: agentData.qualificationConfig || {},
      ad_context_map: agentData.adContextMap || {},
    })
    .select()
    .single();

  if (error) throw error;
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
  if (updates.qualificationConfig !== undefined) {
    updateData.qualification_config = updates.qualificationConfig;
  }
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
