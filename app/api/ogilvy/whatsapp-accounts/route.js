import { getTenantContext } from '../../../../lib/tenant-context.js';
import { listWhatsAppAccountsForUser } from '../../../../src/agents/ogilvy/whatsapp-accounts.service.js';

/**
 * GET /api/ogilvy/whatsapp-accounts
 *
 * Returns the list of Click-to-WhatsApp-eligible phone numbers for the
 * currently authenticated user, plus a gate status the UI uses to decide
 * whether to render the chat or a "set up first" blocker.
 *
 * Note: 这条路径目前是 per-user 拉 Meta token，本身就按 user 维度隔离；
 * V1 "1 user = 1 tenant" 假设下等价于 tenant 隔离。等 Phase 2 接入
 * meta_connections 后这里要改成按 tenant 拉 token。
 */
export async function GET(request) {
  const ctx = await getTenantContext();
  if (!ctx) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // ?force=1 bypasses the in-process cache — used by the gate's
  // "我已完成绑定，重新检查" button so the user doesn't wait out the TTL.
  const url = new URL(request.url);
  const force = url.searchParams.get('force') === '1';

  try {
    const result = await listWhatsAppAccountsForUser(ctx.user.id, { force });
    return Response.json(result);
  } catch (err) {
    console.error('[ogilvy/whatsapp-accounts] fetch failed:', err.message);
    return Response.json(
      { status: 'token_error', numbers: [], all_numbers: [], error: err.message },
      { status: 500 },
    );
  }
}
