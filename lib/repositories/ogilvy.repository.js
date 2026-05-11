/**
 * Ogilvy repository — CRUD for the autopilot_sessions + autopilot_messages
 * tables (table names predate the rename and are intentionally preserved for
 * backwards-compatible storage).
 *
 * Scope is intentionally narrower than the legacy orchestrator.repository.js:
 * no phase_results, no feedback gates. A session holds a chat transcript and
 * (once drafted) a single plan_json blob.
 */
import supabase from '../supabase.js';

// ── Sessions ────────────────────────────────────────────────────────────

export async function createSession({ tenantId, userId = null, title = null }) {
  if (!tenantId) throw new Error('createSession: tenantId required');
  const { data, error } = await supabase
    .from('autopilot_sessions')
    .insert({ tenant_id: tenantId, user_id: userId, title, status: 'active' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Soft-deleted sessions (`deleted_at IS NOT NULL`) are hidden from all reads
// here — getSession returns null, listSessions skips them. The route layer
// treats a missing session as 404, which is what we want post-delete.
//
// If you need to inspect or restore a soft-deleted row, query the table
// directly via supabase-admin; there's deliberately no `includeDeleted`
// flag in this repo since every business code path should see the
// post-delete state.
export async function getSession(sessionId) {
  const { data, error } = await supabase
    .from('autopilot_sessions')
    .select('*')
    .eq('id', sessionId)
    .is('deleted_at', null)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

export async function listSessions({ tenantId, userId = null, limit = 50 }) {
  if (!tenantId) throw new Error('listSessions: tenantId required');
  let query = supabase
    .from('autopilot_sessions')
    .select('id, title, status, plan_json, meta_campaign_ids, created_at, updated_at')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .neq('status', 'archived')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

export async function updateSession(sessionId, updates) {
  const allowed = {};
  for (const key of ['title', 'status', 'plan_json', 'meta_campaign_ids']) {
    if (updates[key] !== undefined) allowed[key] = updates[key];
  }
  const { data, error } = await supabase
    .from('autopilot_sessions')
    .update(allowed)
    .eq('id', sessionId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Soft-delete: flag the session as deleted instead of removing the row.
// Cascading hard-deletes were the original behaviour, but an accidental bulk
// DELETE on 2026-05-11 wiped every message in the table via the FK cascade
// — see supabase/migrations/2026-05-12-autopilot-soft-delete.sql for the
// full incident note. The row (plus its messages and plan_json) stays in
// place; reads filter on deleted_at IS NULL so the user sees the same
// "gone" UX as before.
export async function deleteSession(sessionId) {
  const { error } = await supabase
    .from('autopilot_sessions')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', sessionId)
    .is('deleted_at', null);  // idempotent: don't bump deleted_at on re-deletes
  if (error) throw error;
}

// ── Messages ────────────────────────────────────────────────────────────

export async function addMessage(sessionId, msg) {
  const row = {
    session_id: sessionId,
    message_index: msg.message_index,
    role: msg.role,
    content: msg.content ?? null,
    tool_name: msg.tool_name ?? null,
    tool_use_id: msg.tool_use_id ?? null,
    tool_input: msg.tool_input ?? null,
    tool_result: msg.tool_result ?? null,
    attachments: msg.attachments?.length ? msg.attachments : null,
  };
  const { data, error } = await supabase
    .from('autopilot_messages')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function addMessages(sessionId, messages) {
  if (!messages.length) return [];
  const rows = messages.map(msg => ({
    session_id: sessionId,
    message_index: msg.message_index,
    role: msg.role,
    content: msg.content ?? null,
    tool_name: msg.tool_name ?? null,
    tool_use_id: msg.tool_use_id ?? null,
    tool_input: msg.tool_input ?? null,
    tool_result: msg.tool_result ?? null,
    attachments: msg.attachments?.length ? msg.attachments : null,
  }));
  const { data, error } = await supabase
    .from('autopilot_messages')
    .insert(rows)
    .select();
  if (error) throw error;
  return data || [];
}

export async function getMessages(sessionId) {
  const { data, error } = await supabase
    .from('autopilot_messages')
    .select('*')
    .eq('session_id', sessionId)
    .order('message_index', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getNextMessageIndex(sessionId) {
  const { data, error } = await supabase
    .from('autopilot_messages')
    .select('message_index')
    .eq('session_id', sessionId)
    .order('message_index', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0]?.message_index != null ? data[0].message_index + 1 : 0;
}

// ── OpenAI message reconstruction ───────────────────────────────────────
// Reuses the same contract as the legacy orchestrator repo: each stored row
// maps back to an OpenAI /chat/completions message. Handles multi-tool-call
// turns and image attachments.

function attachmentToImageBlock(att) {
  if (!att?.url) return null;
  const ct = att.content_type || '';
  if (!ct.startsWith('image/')) return null;
  return { type: 'image_url', image_url: { url: att.url } };
}

export async function getMessagesForLLM(sessionId) {
  const rows = await getMessages(sessionId);
  const result = [];

  for (const row of rows) {
    if (row.role === 'assistant' && row.tool_use_id) {
      // Merge consecutive assistant rows with tool_use_id into one message
      const toolCall = {
        id: row.tool_use_id,
        type: 'function',
        function: { name: row.tool_name, arguments: JSON.stringify(row.tool_input || {}) },
      };
      const last = result[result.length - 1];
      if (last && last.role === 'assistant' && Array.isArray(last.tool_calls)) {
        last.tool_calls.push(toolCall);
      } else {
        result.push({ role: 'assistant', content: row.content || null, tool_calls: [toolCall] });
      }
    } else if (row.role === 'tool') {
      const content = row.tool_result != null ? JSON.stringify(row.tool_result)
        : (row.content || '[no result]');
      result.push({ role: 'tool', tool_call_id: row.tool_use_id, content });
    } else if (row.role === 'user') {
      const imageBlocks = (row.attachments || []).map(attachmentToImageBlock).filter(Boolean);
      if (imageBlocks.length) {
        const content = [];
        if (row.content) content.push({ type: 'text', text: row.content });
        content.push(...imageBlocks);
        result.push({ role: 'user', content });
      } else if (row.content) {
        result.push({ role: 'user', content: row.content });
      }
    } else if (row.role === 'assistant' && row.content) {
      result.push({ role: 'assistant', content: row.content });
    }
    // Rows with empty content + no tool_use_id are skipped (OpenAI rejects them).
  }

  return sanitizeToolCallPairs(result);
}

// Ensure every assistant tool_call has a matching {role:'tool'} follow-up.
// Crashes mid-execution can leave orphaned tool_use rows in the DB; this
// patches both directions so the next LLM call doesn't 400.
function sanitizeToolCallPairs(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    out.push(msg);
    if (msg.role !== 'assistant' || !Array.isArray(msg.tool_calls) || !msg.tool_calls.length) continue;

    const callIds = new Set(msg.tool_calls.map(tc => tc.id));
    let j = i + 1;
    const followingToolIdxs = [];
    while (j < messages.length && messages[j].role === 'tool') {
      followingToolIdxs.push(j);
      j++;
    }
    const existingResultIds = new Set(followingToolIdxs.map(k => messages[k].tool_call_id));

    for (const id of callIds) {
      if (!existingResultIds.has(id)) {
        out.push({ role: 'tool', tool_call_id: id, content: '[error: execution interrupted]' });
      }
    }
    for (const k of followingToolIdxs) {
      if (callIds.has(messages[k].tool_call_id)) out.push(messages[k]);
    }
    i = j - 1;
  }
  return out;
}
