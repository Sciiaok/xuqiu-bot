import { resumeAfterFeedback } from '../../../../../../src/campaign-orchestrator.service.js';
import { getSession, getLatestSession } from '../../../../../../lib/repositories/orchestrator.repository.js';
import { streamSSE } from '../../../../../../lib/sse.js';

/**
 * POST /api/campaign/orchestrate/[id]/approve
 *
 * Approve execution plan and resume. Returns SSE stream.
 * Backward compat — delegates to resumeAfterFeedback.
 */
export async function POST(request, { params }) {
  const { id } = await params;

  let session = await getSession(id);
  if (!session) {
    session = await getLatestSession(id);
  }
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  return streamSSE(resumeAfterFeedback(session.id, '确认执行投放方案'));
}
