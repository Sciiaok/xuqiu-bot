import supabase from '../supabase.js';

// ── Session CRUD ───────────────────────────────────────────────────────

export async function createSession(briefId) {
  const { data, error } = await supabase
    .from('orchestrator_sessions')
    .insert({ brief_id: briefId })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getSession(sessionId) {
  const { data, error } = await supabase
    .from('orchestrator_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

export async function getLatestSession(briefId) {
  const { data, error } = await supabase
    .from('orchestrator_sessions')
    .select('*')
    .eq('brief_id', briefId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

export async function updateSession(sessionId, updates) {
  const allowed = {};
  if (updates.status !== undefined) allowed.status = updates.status;
  if (updates.current_phase !== undefined) allowed.current_phase = updates.current_phase;
  if (updates.phase_results !== undefined) allowed.phase_results = updates.phase_results;
  if (updates.orchestrator_state !== undefined) allowed.orchestrator_state = updates.orchestrator_state;

  const { data, error } = await supabase
    .from('orchestrator_sessions')
    .update(allowed)
    .eq('id', sessionId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ── Message CRUD ───────────────────────────────────────────────────────

export async function addMessage(sessionId, {
  phase = null,
  role,
  content,
  tool_name,
  tool_use_id,
  tool_input,
  tool_result,
  message_index,
}) {
  const { data, error } = await supabase
    .from('orchestrator_messages')
    .insert({
      session_id: sessionId,
      phase,
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

export async function addMessages(sessionId, messages) {
  const rows = messages.map(msg => ({
    session_id: sessionId,
    phase: msg.phase || null,
    role: msg.role,
    content: msg.content,
    tool_name: msg.tool_name,
    tool_use_id: msg.tool_use_id,
    tool_input: msg.tool_input,
    tool_result: msg.tool_result,
    message_index: msg.message_index,
  }));

  const { data, error } = await supabase
    .from('orchestrator_messages')
    .insert(rows)
    .select();

  if (error) throw error;
  return data || [];
}

/**
 * Get all messages for a session, optionally filtered by phase.
 * @param {string} sessionId
 * @param {Object} [opts]
 * @param {string|null} [opts.phase] - Filter by phase (null = user chat only)
 * @returns {Promise<Array>}
 */
export async function getMessages(sessionId, { phase } = {}) {
  let query = supabase
    .from('orchestrator_messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('message_index', { ascending: true });

  if (phase !== undefined) {
    if (phase === null) {
      query = query.is('phase', null);
    } else {
      query = query.eq('phase', phase);
    }
  }

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

/**
 * Reconstruct Claude Messages API-compatible array from stored rows.
 * Same merging logic as campaign-brief.repository.js.
 */
export async function getMessagesForClaude(sessionId, { phase } = {}) {
  const rows = await getMessages(sessionId, { phase });
  return rowsToClaudeMessages(rows);
}

/**
 * Get the next message_index for a session.
 */
export async function getNextMessageIndex(sessionId) {
  const { data, error } = await supabase
    .from('orchestrator_messages')
    .select('message_index')
    .eq('session_id', sessionId)
    .order('message_index', { ascending: false })
    .limit(1);

  if (error) throw error;
  if (!data || data.length === 0) return 0;
  return data[0].message_index + 1;
}

// ── Claude message reconstruction ──────────────────────────────────────

function rowsToClaudeMessages(rows) {
  const result = [];

  for (const row of rows) {
    if (row.role === 'assistant' && row.tool_use_id) {
      const block = {
        type: 'tool_use',
        id: row.tool_use_id,
        name: row.tool_name,
        input: row.tool_input || {},
      };

      const last = result[result.length - 1];
      if (last && last.role === 'assistant' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        const content = [];
        if (row.content) content.push({ type: 'text', text: row.content });
        content.push(block);
        result.push({ role: 'assistant', content });
      }
    } else if (row.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: row.tool_use_id,
        content: row.tool_result != null ? JSON.stringify(row.tool_result) : (row.content || ''),
      };

      const last = result[result.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)
          && last.content.length > 0 && last.content[0].type === 'tool_result') {
        last.content.push(block);
      } else {
        result.push({ role: 'user', content: [block] });
      }
    } else {
      result.push({ role: row.role, content: row.content });
    }
  }

  return result;
}
