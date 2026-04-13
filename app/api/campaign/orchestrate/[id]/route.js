import { createClient } from '../../../../../lib/supabase-server.js';
import { chatWithOrchestrator } from '../../../../../src/campaign-orchestrator.service.js';
import { processIntakeMessage } from '../../../../../src/campaign-intake.service.js';
import {
  createSession,
  resolveSession,
  updateSessionIfStatus,
  getMessages,
} from '../../../../../lib/repositories/orchestrator.repository.js';
import { getBrief } from '../../../../../lib/repositories/campaign-brief.repository.js';
import { after } from 'next/server';
import { drainToRedis } from '../../../../../lib/sse.js';
import { streamKey, stopKey, getRedis } from '../../../../../lib/redis.js';

/**
 * POST /api/campaign/orchestrate/[id]
 *
 * [id] can be a brief_id or session_id.
 * Unified entry: all requests go through chatWithOrchestrator.
 * The LLM decides whether to answer a question or run pipeline phases.
 *
 * Body: {message: "…"}  → user message (LLM decides action)
 * Body: {}              → auto-start (LLM sees brief + state, starts phases)
 */
export async function POST(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }

  // Resolve session + brief in parallel (allSettled to avoid one failure killing both)
  const [sessionResult, briefResult] = await Promise.allSettled([
    resolveSession(id),
    getBrief(id),
  ]);
  let session = sessionResult.status === 'fulfilled' ? sessionResult.value : null;
  let brief = briefResult.status === 'fulfilled' ? briefResult.value : null;

  if (!session && !brief) {
    return Response.json({ error: 'Brief or session not found' }, { status: 404 });
  }

  if (!session && brief) {
    session = await createSession(brief.id, { status: 'intake', current_phase: 'intake' });
  }

  if (!brief) {
    brief = await getBrief(session.brief_id);
  }
  if (!brief) {
    return Response.json({ error: 'Brief not found' }, { status: 404 });
  }

  // Intake phase: dedicated intake agent (web_search, confidence checks, etc.)
  if (session.status === 'intake' && session.current_phase === 'intake' && (body.message || body.attachments)) {
    const key = streamKey(brief.id);
    // Clear any stale stop signal from a previous abort
    await getRedis().del(stopKey(session.id));
    const generator = processIntakeMessage(brief.id, body.message || '', { attachments: body.attachments });
    after(async () => {
      try {
        await drainToRedis(generator, key, { sessionId: session.id });
      } catch (err) {
        console.error('[orchestrate POST] intake drainToRedis failed:', err.message);
      }
    });
    return Response.json({ session_id: session.id, brief_id: brief.id, stream_key: key });
  }

  // Require a message
  if (!body.message && !body.attachments?.length) {
    return Response.json({ error: 'Message or attachments required' }, { status: 400 });
  }

  // Unified orchestrator: fire-and-forget via after() + drainToRedis
  // Clear any stale stop signal from a previous abort
  await getRedis().del(stopKey(session.id));
  const generator = chatWithOrchestrator(session.id, body.message || '', { attachments: body.attachments });
  const key = streamKey(brief.id);
  after(async () => {
    try {
      await drainToRedis(generator, key, { sessionId: session.id });
    } catch (err) {
      console.error('[orchestrate POST] drainToRedis failed:', err.message);
      await updateSessionIfStatus(session.id, 'running', { status: 'interrupted' });
    }
  });
  return Response.json({ session_id: session.id, brief_id: brief.id, stream_key: key });
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
  const debug = searchParams.get('debug') !== null;

  try {
    const session = await resolveSession(id);
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
      messages: messages.filter(m => debug || !(m.role === 'event' && !m.tool_name)).map(m => ({
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
  } catch (err) {
    const msg = typeof err?.message === 'string' && err.message.length > 200
      ? `Upstream error (${err.code || 'unknown'})`
      : err?.message || 'Internal error';
    console.error('[orchestrate/GET] Error:', err.code || '', msg);
    const status = err?.message?.includes('502') || err?.message?.includes('Bad gateway') ? 502 : 500;
    return Response.json({ error: msg }, { status });
  }
}
