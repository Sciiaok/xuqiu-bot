import { createClient } from '../../../../../../lib/supabase-server.js';
import { getRedis, stopKey } from '../../../../../../lib/redis.js';
import { resolveSession, updateSessionIfStatus } from '../../../../../../lib/repositories/orchestrator.repository.js';

/**
 * POST /api/campaign/orchestrate/[id]/stop
 *
 * Signal the running generator to stop. Sets a Redis flag that
 * drainToRedis and the intake/orchestrator loops check each iteration.
 */
export async function POST(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const session = await resolveSession(id);
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  // Set stop signal in Redis (TTL 60s — enough for any in-flight iteration to see it)
  const redis = getRedis();
  await redis.set(stopKey(session.id), '1', 'EX', 60);

  // Mark session as interrupted so it can be resumed later
  await updateSessionIfStatus(session.id, 'running', { status: 'interrupted' });

  return Response.json({ stopped: true });
}

