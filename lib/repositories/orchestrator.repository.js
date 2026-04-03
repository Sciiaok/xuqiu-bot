import supabase from '../supabase.js';

/**
 * Download image from URL and return Anthropic-compatible base64 image block.
 * Falls back to URL source if download fails.
 */
async function attachmentToImageBlock(att) {
  try {
    const res = await fetch(att.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const base64 = buffer.toString('base64');
    const mediaType = att.content_type || res.headers.get('content-type') || 'image/jpeg';
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: base64 },
    };
  } catch (err) {
    console.warn('[attachmentToImageBlock] Failed to download, falling back to URL:', att.url, err.message);
    return {
      type: 'image',
      source: { type: 'url', url: att.url },
    };
  }
}

/**
 * Convert attachments array to Claude multimodal content blocks.
 * Downloads each image and encodes as base64 for reliable LLM ingestion.
 */
export async function attachmentsToContentBlocks(attachments) {
  if (!attachments?.length) return [];
  return Promise.all(attachments.map(attachmentToImageBlock));
}

// ── Session CRUD ───────────────────────────────────────────────────────

export async function createSession(briefId, initial = {}) {
  const row = { brief_id: briefId };
  if (initial.status !== undefined) row.status = initial.status;
  if (initial.current_phase !== undefined) row.current_phase = initial.current_phase;
  if (initial.phase_results !== undefined) row.phase_results = initial.phase_results;
  if (initial.orchestrator_state !== undefined) row.orchestrator_state = initial.orchestrator_state;
  if (initial.fix_log !== undefined) row.fix_log = initial.fix_log;

  const { data, error } = await supabase
    .from('orchestrator_sessions')
    .insert(row)
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
  if (updates.fix_log !== undefined) allowed.fix_log = updates.fix_log;

  const { data, error } = await supabase
    .from('orchestrator_sessions')
    .update(allowed)
    .eq('id', sessionId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Conditionally update session status only if it matches the expected status.
 * Prevents race conditions where two concurrent requests try to update the same session.
 * 
 * @param {string} sessionId - Session ID
 * @param {string} expectedStatus - The status the session must have for update to succeed
 * @param {Object} updates - Fields to update
 * @returns {Promise<{updated: boolean, data: Object|null}>} - Whether update succeeded and the updated row
 */
export async function updateSessionIfStatus(sessionId, expectedStatus, updates) {
  const allowed = {};
  if (updates.status !== undefined) allowed.status = updates.status;
  if (updates.current_phase !== undefined) allowed.current_phase = updates.current_phase;
  if (updates.phase_results !== undefined) allowed.phase_results = updates.phase_results;
  if (updates.orchestrator_state !== undefined) allowed.orchestrator_state = updates.orchestrator_state;

  const { data, error } = await supabase
    .from('orchestrator_sessions')
    .update(allowed)
    .eq('id', sessionId)
    .eq('status', expectedStatus)  // Atomic conditional: only update if status matches
    .select()
    .single();

  // PGRST116 = "no rows returned" — means the status didn't match (race lost)
  if (error && error.code !== 'PGRST116') throw error;
  return { updated: data !== null, data };
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
  attachments,
}) {
  const row = {
    session_id: sessionId,
    phase,
    role,
    content,
    tool_name,
    tool_use_id,
    tool_input,
    tool_result,
    message_index,
  };
  if (attachments?.length) row.attachments = attachments;

  const { data, error } = await supabase
    .from('orchestrator_messages')
    .insert(row)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function addMessages(sessionId, messages) {
  const rows = messages.map(msg => {
    const row = {
      session_id: sessionId,
      phase: msg.phase || null,
      role: msg.role,
      content: msg.content,
      tool_name: msg.tool_name,
      tool_use_id: msg.tool_use_id,
      tool_input: msg.tool_input,
      tool_result: msg.tool_result,
      message_index: msg.message_index,
    };
    if (msg.attachments?.length) row.attachments = msg.attachments;
    return row;
  });

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
  return await rowsToClaudeMessages(rows);
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

async function rowsToClaudeMessages(rows) {
  const result = [];
  // Collect rows that need async image download
  const asyncTasks = [];

  for (const row of rows) {
    // Skip event rows — they are trace/progress records, not Claude API messages
    if (row.role === 'event') continue;

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
      // Build multimodal content if attachments exist
      if (row.role === 'user' && row.attachments?.length) {
        // Placeholder — will be filled by async task
        const msg = { role: 'user', content: [] };
        result.push(msg);
        asyncTasks.push({ msg, attachments: row.attachments, text: row.content });
      } else {
        result.push({ role: row.role, content: row.content });
      }
    }
  }

  // Download and encode images in parallel
  if (asyncTasks.length > 0) {
    await Promise.all(asyncTasks.map(async (task) => {
      const imageBlocks = await attachmentsToContentBlocks(task.attachments);
      task.msg.content = [...imageBlocks];
      if (task.text) task.msg.content.push({ type: 'text', text: task.text });
    }));
  }

  return result;
}
