import { getTenantContext } from '../../../../../../lib/tenant-context.js';
import { getSession } from '../../../../../../lib/repositories/autopilot.repository.js';
import { runOgilvy } from '../../../../../../src/agents/ogilvy/index.js';
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
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;

  const session = await getSession(id);
  if (!session || session.tenant_id !== ctx.tenantId) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }

  const { message = '', attachments = [] } = body;
  if (!message && !attachments.length) {
    return Response.json({ error: 'Message or attachments required' }, { status: 400 });
  }

  const generator = runOgilvy(id, message, attachments, ctx.user.id);
  return streamSSE(generator, { heartbeatIntervalMs: 15_000 });
}
