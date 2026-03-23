import { orchestrate, chatWithOrchestrator } from '../../../../../src/campaign-orchestrator.service.js';
import {
  createSession,
  getSession,
  getLatestSession,
  getMessages,
} from '../../../../../lib/repositories/orchestrator.repository.js';
import { getBrief } from '../../../../../lib/repositories/campaign-brief.repository.js';
import { streamSSE } from '../../../../../lib/sse.js';

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
  const { id } = await params;

  let body = {};
  try { body = await request.json(); } catch { /* empty body = run pipeline */ }

  // Resolve session: id could be session_id or brief_id
  let session = await getSession(id);
  if (!session) {
    // Try as brief_id — find or create session
    const brief = await getBrief(id);
    if (!brief) {
      return Response.json({ error: 'Brief or session not found' }, { status: 404 });
    }
    session = await getLatestSession(id);
    if (!session || session.status === 'completed' || session.status === 'failed') {
      session = await createSession(id);
    }
  }

  // Chat mode: user sends a message
  if (body.message) {
    return streamSSE(chatWithOrchestrator(session.id, body.message));
  }

  // Pipeline mode: run orchestration
  return streamSSE(orchestrate(session.id));
}

/**
 * GET /api/campaign/orchestrate/[id]
 *
 * Get orchestration status + message history.
 * Query: ?phase=research → filter messages by phase (omit for all)
 *        ?phase=chat     → user conversation only (phase IS NULL)
 */
export async function GET(request, { params }) {
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

  return Response.json({
    session_id: session.id,
    brief_id: session.brief_id,
    status: session.status,
    current_phase: session.current_phase,
    phase_results_keys: Object.keys(session.phase_results || {}),
    messages: messages.map(m => ({
      id: m.id,
      phase: m.phase,
      role: m.role,
      content: m.content,
      tool_name: m.tool_name,
      tool_result: m.tool_result,
      created_at: m.created_at,
    })),
  });
}

