import { getTenantContext } from '../../../../../../lib/tenant-context.js';
import { getSession } from '../../../../../../lib/repositories/ogilvy.repository.js';
import { fetchAdStatuses } from '../../../../../../src/agents/ogilvy/meta-launch.service.js';

/**
 * GET /api/ogilvy/conversations/[id]/ad-status
 *
 * Returns the live effective_status for every ad on Meta. `configured_status`
 * (what /pause /resume set) only says what we asked for; effective_status is
 * what Meta is actually doing — IN_PROCESS while reviewing, ACTIVE only after
 * the review passes, DISAPPROVED if rejected.
 *
 * Empty `ads` list means the session has no Meta ad IDs (either not launched
 * or all ad creates failed during stage).
 */
export async function GET(_request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const session = await getSession(id);
  if (!session || session.tenant_id !== ctx.tenantId) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const plan = session.plan_json || {};
  const adIds = Array.isArray(plan.meta_ad_ids) ? plan.meta_ad_ids : [];
  if (adIds.length === 0) {
    return Response.json({ ads: [], fetched_at: new Date().toISOString() });
  }

  try {
    const ads = await fetchAdStatuses(adIds, { userId: ctx.user.id });
    return Response.json({ ads, fetched_at: new Date().toISOString() });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
}
