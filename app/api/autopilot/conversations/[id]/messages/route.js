import { createClient } from '../../../../../../lib/supabase-server.js';
import { getSession } from '../../../../../../lib/repositories/autopilot.repository.js';
import { runAutopilotAgent } from '../../../../../../src/autopilot/agent.service.js';
import { streamSSE } from '../../../../../../lib/sse.js';

/**
 * POST /api/autopilot/conversations/[id]/messages
 *
 * Send a user message and stream back the Agent's response as SSE. The
 * response lives for the duration of the Agent run (up to MAX_ITERATIONS
 * tool cycles). Client reconnects are not supported yet (PR 1 keeps it
 * simple; if the user refreshes mid-run, the in-DB messages replay but any
 * delta mid-flight is lost).
 *
 * Body: { message: string, attachments?: [{url, content_type, filename}] }
 */
export async function POST(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;

  const session = await getSession(id);
  if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });

  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }

  const { message = '', attachments = [] } = body;
  if (!message && !attachments.length) {
    return Response.json({ error: 'Message or attachments required' }, { status: 400 });
  }

  const generator = runAutopilotAgent(id, message, attachments, user.id);
  return streamSSE(generator, { heartbeatIntervalMs: 15_000 });
}
