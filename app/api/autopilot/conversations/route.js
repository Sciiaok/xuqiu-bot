import { getTenantContext } from '../../../../lib/tenant-context.js';
import {
  createSession,
  listSessions,
} from '../../../../lib/repositories/autopilot.repository.js';
import { prewarmWhatsAppAccountsForUser } from '../../../../src/agents/ogilvy/whatsapp-accounts.service.js';

/**
 * GET /api/autopilot/conversations
 *
 * List the user's autopilot conversations, newest first. This powers the
 * left-sidebar history in the /ai-automation page.
 */
export async function GET() {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const sessions = await listSessions({ tenantId: ctx.tenantId, userId: ctx.user.id });
    return Response.json({ data: sessions });
  } catch (err) {
    console.error('[autopilot/conversations GET]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/autopilot/conversations
 *
 * Create a new conversation. Frontend calls this from the "新项目" button.
 */
export async function POST() {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const session = await createSession({ tenantId: ctx.tenantId, userId: ctx.user.id });
    // Fire-and-forget: pre-warm the WhatsApp gate cache so the user's first
    // message doesn't pay the 4-6s Graph API round-trip again. If it fails,
    // the in-agent listWhatsAppAccountsForUser call will just do it for real.
    prewarmWhatsAppAccountsForUser(ctx.user.id);
    return Response.json(session, { status: 201 });
  } catch (err) {
    console.error('[autopilot/conversations POST]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
