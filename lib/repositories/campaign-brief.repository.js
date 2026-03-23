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

// ── Message CRUD ────────────────────────────────────────────────────────

/**
 * Add a single message to a campaign brief
 * @param {string} briefId - Brief UUID
 * @param {Object} msg - Message data
 * @returns {Promise<Object>} - Created message
 */
export async function addMessage(briefId, { role, content, tool_name, tool_use_id, tool_input, tool_result, message_index }) {
  const { data, error } = await supabase
    .from('campaign_messages')
    .insert({
      brief_id: briefId,
      role,
      content,
      tool_name,
      tool_use_id,
      tool_input,
      tool_result,
      message_index,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Batch insert multiple messages for a campaign brief
 * @param {string} briefId - Brief UUID
 * @param {Array<Object>} messages - Array of message data
 * @returns {Promise<Array>} - Created messages
 */
export async function addMessages(briefId, messages) {
  const rows = messages.map(msg => ({
    brief_id: briefId,
    role: msg.role,
    content: msg.content,
    tool_name: msg.tool_name,
    tool_use_id: msg.tool_use_id,
    tool_input: msg.tool_input,
    tool_result: msg.tool_result,
    message_index: msg.message_index,
  }));

  const { data, error } = await supabase
    .from('campaign_messages')
    .insert(rows)
    .select();

  if (error) throw error;
  return data || [];
}

/**
 * Get all messages for a campaign brief, ordered by message_index
 * @param {string} briefId - Brief UUID
 * @returns {Promise<Array>} - Array of messages
 */
export async function getMessages(briefId) {
  const { data, error } = await supabase
    .from('campaign_messages')
    .select('*')
    .eq('brief_id', briefId)
    .order('message_index', { ascending: true });

  if (error) throw error;
  return data || [];
}

/**
 * Reconstruct Claude Messages API-compatible message array from stored rows.
 *
 * Rules:
 * - assistant rows with tool_use_id → merged into assistant message with tool_use content blocks
 * - tool rows → converted to user message with tool_result content blocks
 * - user/assistant rows without tool_use_id → normal {role, content} messages
 * - Adjacent assistant tool_use blocks are merged into the same assistant message
 *
 * @param {string} briefId - Brief UUID
 * @returns {Promise<Array>} - Claude-compatible messages array
 */
export async function getMessagesForClaude(briefId) {
  const rows = await getMessages(briefId);
  const result = [];

  for (const row of rows) {
    if (row.role === 'assistant' && row.tool_use_id) {
      // Assistant with tool_use — merge into the last assistant message if it
      // already has tool_use content blocks, otherwise create a new one.
      const block = {
        type: 'tool_use',
        id: row.tool_use_id,
        name: row.tool_name,
        input: row.tool_input || {},
      };

      const last = result[result.length - 1];
      if (last && last.role === 'assistant' && Array.isArray(last.content)) {
        // Adjacent assistant tool_use — merge
        last.content.push(block);
      } else {
        // New assistant message with content blocks
        const content = [];
        if (row.content) {
          content.push({ type: 'text', text: row.content });
        }
        content.push(block);
        result.push({ role: 'assistant', content });
      }
    } else if (row.role === 'tool') {
      // Tool result → user message with tool_result content block
      const block = {
        type: 'tool_result',
        tool_use_id: row.tool_use_id,
        content: row.tool_result != null ? JSON.stringify(row.tool_result) : (row.content || ''),
      };

      const last = result[result.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)
          && last.content.length > 0 && last.content[0].type === 'tool_result') {
        // Adjacent tool results — merge into same user message
        last.content.push(block);
      } else {
        result.push({ role: 'user', content: [block] });
      }
    } else {
      // Normal user or assistant text message
      result.push({ role: row.role, content: row.content });
    }
  }

  return result;
}

// ── Utility ─────────────────────────────────────────────────────────────

/**
 * Get the next message_index for a brief (max + 1, or 0 if none)
 * @param {string} briefId - Brief UUID
 * @returns {Promise<number>} - Next message index
 */
export async function getNextMessageIndex(briefId) {
  const { data, error } = await supabase
    .from('campaign_messages')
    .select('message_index')
    .eq('brief_id', briefId)
    .order('message_index', { ascending: false })
    .limit(1);

  if (error) throw error;

  if (!data || data.length === 0) return 0;
  return data[0].message_index + 1;
}
