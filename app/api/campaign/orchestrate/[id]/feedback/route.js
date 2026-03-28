import { createClient } from '../../../../../../lib/supabase-server.js';
import { resumeAfterFeedback } from '../../../../../../src/campaign-orchestrator.service.js';
import { getSession, getLatestSession, updateSessionIfStatus } from '../../../../../../lib/repositories/orchestrator.repository.js';
import { streamSSE } from '../../../../../../lib/sse.js';

/**
 * POST /api/campaign/orchestrate/[id]/feedback
 *
 * Resume orchestration after user feedback.
 * Body: { response: "用户回应" }
 * Returns: SSE stream
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

  if (!body.response) {
    return Response.json({ error: 'Missing response field' }, { status: 400 });
  }

  let session = await getSession(id);
  if (!session) {
    session = await getLatestSession(id);
  }
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const sessionId = session.id;
  return streamSSE(resumeAfterFeedback(sessionId, body.response), {
    heartbeatIntervalMs: 5000,
    onAbort: async () => {
      await updateSessionIfStatus(sessionId, 'running', { status: 'interrupted' });
    },
  });
}
