import { createClient } from '../../../../../../lib/supabase-server.js';
import { resumeAfterFeedback } from '../../../../../../src/campaign-orchestrator.service.js';
import { getSession, getLatestSession } from '../../../../../../lib/repositories/orchestrator.repository.js';
import { streamSSE } from '../../../../../../lib/sse.js';
import { streamKey } from '../../../../../../lib/redis.js';
import { getBrief } from '../../../../../../lib/repositories/campaign-brief.repository.js';

/**
 * POST /api/campaign/orchestrate/[id]/approve
 *
 * Approve execution plan and resume. Returns SSE stream.
 * Backward compat — delegates to resumeAfterFeedback.
 */
export async function POST(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let session = await getSession(id);
  if (!session) {
    session = await getLatestSession(id);
  }
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const brief = await getBrief(session.brief_id);

  return streamSSE(resumeAfterFeedback(session.id, '确认执行投放方案'), {
    heartbeatIntervalMs: 5000,
    streamKey: brief ? streamKey(brief.id) : undefined,
  });
}
