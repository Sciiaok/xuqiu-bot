import { createClient } from '../../../../../lib/supabase-server.js';
import { orchestrate, chatWithOrchestrator } from '../../../../../src/campaign-orchestrator.service.js';
import {
  createSession,
  getSession,
  getLatestSession,
  updateSessionIfStatus,
  getMessages,
} from '../../../../../lib/repositories/orchestrator.repository.js';
import { getBrief } from '../../../../../lib/repositories/campaign-brief.repository.js';
import { streamSSE } from '../../../../../lib/sse.js';

function isBriefReadyForOrchestration(brief) {
  const briefData = brief?.brief || {};
  return Boolean(briefData.company_name && briefData.industry);
}

/**
 * POST /api/campaign/orchestrate/[id]
 *
 * [id] can be a brief_id or session_id.
 *
 * Body: {}             → start/resume orchestration pipeline (SSE stream)
 * Body: {message: "…"} → chat with orchestrator about current results (SSE stream)
 *
 * Query: ?start_phase=research → resume from specific phase
 */
export async function POST(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let body = {};
  try { body = await request.json(); } catch { /* empty body = run pipeline */ }
  const isChatMode = Boolean(body.message);

  // Resolve session: id could be session_id or brief_id
  let session = await getSession(id);
  let brief = null;
  if (!session) {
    // Try as brief_id — find or create session
    brief = await getBrief(id);
    if (!brief) {
      return Response.json({ error: 'Brief or session not found' }, { status: 404 });
    }
    session = await getLatestSession(id);

    if (isChatMode) {
      if (!session) {
        session = await createSession(id, { status: 'intake', current_phase: 'intake' });
      }
    } else if (!session || session.status === 'completed' || session.status === 'failed') {
      session = await createSession(id, {
        status: isBriefReadyForOrchestration(brief) ? 'brief_completed' : 'intake',
        current_phase: 'intake',
      });
    } else if (session.status === 'running') {
      const { data } = await updateSessionIfStatus(session.id, 'running', { status: 'interrupted' });
      session = data || await getSession(session.id);
    }
  }

  if (!brief) {
    brief = await getBrief(session.brief_id);
  }
  if (!brief) {
    return Response.json({ error: 'Brief not found' }, { status: 404 });
  }

  // Chat mode: user sends a message — always goes through orchestrator chat
  if (body.message) {
    return streamSSE(
      chatWithOrchestrator(session.id, body.message, { attachments: body.attachments }),
      { heartbeatIntervalMs: 5000 },
    );
  }

  // Pipeline mode: run orchestration (heartbeat keeps connection alive during long phases)
  const sessionId = session.id;
  return streamSSE(orchestrate(sessionId, { phases: body.phases }), {
    heartbeatIntervalMs: 5000,
    onAbort: async () => {
      await updateSessionIfStatus(sessionId, 'running', { status: 'interrupted' });
    },
  });
}

/**
 * GET /api/campaign/orchestrate/[id]
 *
 * Get orchestration status + message history.
 * Query: ?phase=research → filter messages by phase (omit for all)
 *        ?phase=chat     → user conversation only (phase IS NULL)
 */
export async function GET(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const phaseFilter = searchParams.get('phase');

  // Resolve session
  let session = await getSession(id);
  if (!session) {
    session = await getLatestSession(id);
  }
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const msgOpts = {};
  if (phaseFilter === 'chat') {
    msgOpts.phase = null;
  } else if (phaseFilter) {
    msgOpts.phase = phaseFilter;
  }

  const messages = await getMessages(session.id, msgOpts);

  // Include brief data so frontend doesn't need a separate intake endpoint
  const briefData = await getBrief(session.brief_id);

  return Response.json({
    session_id: session.id,
    brief_id: session.brief_id,
    status: session.status,
    current_phase: session.current_phase,
    phase_results_keys: Object.keys(session.phase_results || {}),
    phase_results: session.phase_results || {},
    brief: briefData?.brief || {},
    completion: briefData?.completion || {},
    messages: messages.map(m => ({
      id: m.id,
      phase: m.phase,
      role: m.role,
      content: m.content,
      tool_name: m.tool_name,
      tool_result: m.tool_result,
      attachments: m.attachments || null,
      created_at: m.created_at,
    })),
  });
}
