import { getTenantContext } from '../../../../../../lib/tenant-context.js';
import { getSession } from '../../../../../../lib/repositories/ogilvy.repository.js';
import { fetchAdStatuses } from '../../../../../../src/agents/ogilvy/meta-launch.service.js';
import { reconcileSessionFromMeta } from '../../../../../../src/agents/ogilvy/reconcile.service.js';

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
    // Drift sync: if user paused/deleted entities in Meta UI, mirror that
    // back to our DB so /pause /resume gating doesn't get stuck. Best-effort:
    // any error inside reconcile is logged but doesn't affect the response.
    let reconcile = null;
    try {
      reconcile = await reconcileSessionFromMeta(session, ads);
    } catch (recErr) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        event: 'ogilvy.reconcile.failed',
        component: 'ogilvy/ad-status',
        session_id: id,
        error: recErr.message,
      }));
    }
    return Response.json({
      ads,
      fetched_at: new Date().toISOString(),
      ...(reconcile?.status_changed ? { status_synced_from_meta: reconcile.status_changed } : {}),
      ...(reconcile?.ids_stripped ? { ids_stripped: reconcile.ids_stripped } : {}),
      ...(reconcile?.archived ? { archived: true } : {}),
    });
  } catch (err) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'ogilvy.fetch_ad_statuses.failed',
      component: 'ogilvy/ad-status',
      session_id: id,
      tenant_id: ctx.tenantId,
      ad_count: adIds.length,
      meta_code: err.metaError?.code ?? null,
      fbtrace_id: err.metaError?.fbtrace_id || null,
      error: err.message,
    }));
    return Response.json({ error: err.message }, { status: 502 });
  }
}
