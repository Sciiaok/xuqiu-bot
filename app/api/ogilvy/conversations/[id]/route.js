import { getTenantContext } from '../../../../../lib/tenant-context.js';
import {
  getSession,
  getMessages,
  deleteSession,
} from '../../../../../lib/repositories/ogilvy.repository.js';

async function loadSessionInTenant(sessionId, tenantId) {
  const session = await getSession(sessionId);
  if (!session || session.tenant_id !== tenantId) return null;
  return session;
}

/**
 * GET /api/ogilvy/conversations/[id]
 *
 * Return session metadata + the full message history. Used on page load to
 * restore a conversation.
 */
export async function GET(_request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;

  try {
    const session = await loadSessionInTenant(id, ctx.tenantId);
    if (!session) return Response.json({ error: 'Not found' }, { status: 404 });

    const messages = await getMessages(id);
    return Response.json({
      session,
      messages: messages.map(m => ({
        id: m.id,
        message_index: m.message_index,
        role: m.role,
        content: m.content,
        tool_name: m.tool_name,
        tool_use_id: m.tool_use_id,
        tool_input: m.tool_input,
        tool_result: m.tool_result,
        attachments: m.attachments,
        created_at: m.created_at,
      })),
    });
  } catch (err) {
    console.error('[ogilvy/conversations/[id] GET]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

/**
 * DELETE /api/ogilvy/conversations/[id]
 *
 * Soft delete — sets autopilot_sessions.deleted_at to now(). The row and its
 * messages stay in the database; subsequent reads filter on
 * deleted_at IS NULL so the user sees the same "gone" UX as before.
 *
 * Changed from a hard DELETE on 2026-05-12 after an accidental bulk delete
 * cascaded into autopilot_messages and wiped a user's full chat history with
 * no recovery path. See supabase/migrations/2026-05-12-autopilot-soft-delete.sql.
 */
export async function DELETE(_request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;

  try {
    if (!(await loadSessionInTenant(id, ctx.tenantId))) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    await deleteSession(id);
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[ogilvy/conversations/[id] DELETE]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
