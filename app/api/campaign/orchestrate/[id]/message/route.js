import { createClient } from '../../../../../../lib/supabase-server.js';
import { getSession, getLatestSession, addMessages, getNextMessageIndex } from '../../../../../../lib/repositories/orchestrator.repository.js';
import { getRedis, userInputKey, USER_INPUT_TTL_SECONDS } from '../../../../../../lib/redis.js';

/**
 * POST /api/campaign/orchestrate/[id]/message
 *
 * Push a user message into the running pipeline's input queue.
 * The orchestrator picks it up at the next natural breakpoint.
 *
 * Body: { message: "…", attachments?: [] }
 */
export async function POST(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.message && !body.attachments?.length) {
    return Response.json({ error: 'Message or attachments required' }, { status: 400 });
  }

  let session = await getSession(id);
  if (!session) {
    session = await getLatestSession(id);
  }
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  // Persist to Supabase (permanent record)
  const messageIndex = await getNextMessageIndex(session.id);
  await addMessages(session.id, [{
    phase: null,
    role: 'user',
    content: body.message || '',
    message_index: messageIndex,
    attachments: body.attachments?.length ? body.attachments : undefined,
  }]);

  // Push to Redis queue (ephemeral, consumed by task runner)
  const redis = getRedis();
  const key = userInputKey(session.id);
  try {
    await redis.lpush(key, JSON.stringify({
      content: body.message || '',
      attachments: body.attachments || [],
      timestamp: Date.now(),
    }));
    await redis.expire(key, USER_INPUT_TTL_SECONDS);
  } catch (err) {
    console.warn('[message] Redis LPUSH failed:', err.message);
  }

  return Response.json({ ok: true, session_id: session.id });
}
