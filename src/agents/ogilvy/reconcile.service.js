/**
 * Reconcile session state with what Meta actually shows.
 *
 * Background: our `autopilot_sessions.status` and `plan_json.meta_*_ids` are
 * snapshots of what we did when the user clicked launch / pause / resume.
 * If the user goes to Meta Ads Manager and manually pauses / resumes / deletes
 * the entities we created, our DB never finds out — leaving DB and Meta out
 * of sync. The UI's `deriveSessionStatus` already overlays Meta's
 * effective_status when available, so the *displayed* label is honest. But
 * the action paths (/pause, /resume) gate on `session.status`, which is
 * stale — leading to the "I can see it's paused but the resume button won't
 * work" class of bugs.
 *
 * This reconciler runs after any successful `fetchAdStatuses` call:
 *
 *   1. If every ad is in a PAUSED-class bucket and DB says `launched`,
 *      flip DB to `paused`. (User paused on Meta.)
 *   2. If every ad is ACTIVE and DB says `paused`, flip DB to `launched`.
 *   3. If some ads are missing from Meta's response (deleted there), strip
 *      those IDs from `plan_json.meta_ad_ids` and record what was removed
 *      under `plan_json.meta_drift`.
 *   4. If ALL ads are gone (the whole campaign tree was deleted), move the
 *      session to `archived` so subsequent action calls get a clean
 *      "this session is no longer on Meta" rather than 404ing inside Meta.
 *
 * Mixed buckets (some paused / some active / some under review) leave DB
 * status alone — that's a legitimate mid-state, not drift.
 *
 * All DB writes use CAS-style transitions so concurrent reconciles from grid
 * + modal don't fight. Never moves out of terminal states (failed/archived).
 */
import { transitionSessionStatus, updateSession } from '../../../lib/repositories/ogilvy.repository.js';
import { fetchAdStatuses } from './meta-launch.service.js';

// Mirror of `app/(app)/ogilvy/lib/session-status.js` META_STATUS_BUCKET +
// `app/api/ogilvy/sessions/ad-status/route.js`. P2-7 in the audit flagged
// this duplication — three copies now. Keep all in sync until we extract
// the shared map to lib/.
const META_STATUS_BUCKET = {
  ACTIVE: 'active',
  IN_PROCESS: 'review', PENDING_REVIEW: 'review',
  DISAPPROVED: 'rejected', WITH_ISSUES: 'issue', PENDING_BILLING_INFO: 'issue',
  ADSET_PAUSED: 'paused', CAMPAIGN_PAUSED: 'paused', PAUSED: 'paused',
  ARCHIVED: 'paused', DELETED: 'paused',
};

const RECONCILABLE_STATUSES = new Set(['launched', 'paused']);

/**
 * @param {object} session — full row from autopilot_sessions
 * @param {Array<{id, name, effective_status}>} fetchedAds — return value of fetchAdStatuses
 * @returns {Promise<{
 *   status_changed: { from: string, to: string } | null,
 *   ids_stripped: number,
 *   archived: boolean,
 *   reason: string | null,
 * }>}
 */
export async function reconcileSessionFromMeta(session, fetchedAds) {
  const result = { status_changed: null, ids_stripped: 0, archived: false, reason: null };
  if (!session) return result;
  if (!RECONCILABLE_STATUSES.has(session.status)) return result;

  const plan = session.plan_json || {};
  const expectedAdIds = Array.isArray(plan.meta_ad_ids) ? plan.meta_ad_ids : [];
  if (expectedAdIds.length === 0) return result;

  const ads = Array.isArray(fetchedAds) ? fetchedAds : [];
  const foundIds = new Set(ads.map(a => a.id));
  const missingIds = expectedAdIds.filter(id => !foundIds.has(id));

  // ── Case A: all ads vanished → archive the session ──
  // Meta returns nothing for IDs that have been deleted. Empty response with
  // a non-empty expected list means the whole campaign tree is gone.
  if (ads.length === 0) {
    const claim = await transitionSessionStatus(session.id, {
      from: ['launched', 'paused'],
      to: 'archived',
      extraUpdates: {
        plan_json: {
          ...plan,
          status: 'archived',
          archived_at: new Date().toISOString(),
          meta_drift: {
            reason: 'all_meta_entities_deleted',
            detected_at: new Date().toISOString(),
            last_seen_ad_ids: expectedAdIds,
          },
        },
      },
    });
    if (!claim?.conflict) {
      result.status_changed = { from: session.status, to: 'archived' };
      result.archived = true;
      result.reason = 'all_meta_entities_deleted';
      logReconcile(session, result);
    }
    return result;
  }

  // ── Case B: some ads missing → strip + record drift ──
  // Don't return early; status drift below may also apply on the remaining ads.
  let workingPlan = plan;
  if (missingIds.length > 0) {
    const remaining = expectedAdIds.filter(id => !missingIds.includes(id));
    workingPlan = {
      ...plan,
      meta_ad_ids: remaining,
      meta_drift: {
        last_detected_at: new Date().toISOString(),
        removed_ad_ids: [
          ...(plan.meta_drift?.removed_ad_ids || []),
          ...missingIds,
        ],
      },
    };
    await updateSession(session.id, { plan_json: workingPlan });
    result.ids_stripped = missingIds.length;
  }

  // ── Case C: status drift ──
  const buckets = ads.map(a => META_STATUS_BUCKET[a.effective_status] || 'paused');
  const allPaused = buckets.every(b => b === 'paused');
  const allActive = buckets.every(b => b === 'active');

  let desiredStatus = null;
  if (allActive && session.status === 'paused') desiredStatus = 'launched';
  if (allPaused && session.status === 'launched') desiredStatus = 'paused';

  if (desiredStatus) {
    const claim = await transitionSessionStatus(session.id, {
      from: [session.status],
      to: desiredStatus,
      extraUpdates: {
        plan_json: { ...workingPlan, status: desiredStatus },
      },
    });
    if (!claim?.conflict) {
      result.status_changed = { from: session.status, to: desiredStatus };
    }
  }

  if (result.status_changed || result.ids_stripped > 0) {
    logReconcile(session, result);
  }
  return result;
}

/**
 * Pre-action variant for /pause /resume: fetch Meta state, reconcile, return
 * the (possibly updated) session.status and reconcile result. Callers use
 * the post-reconcile status to decide whether the user's requested action
 * is still needed.
 */
export async function reconcileForAction(session, { userId }) {
  const adIds = Array.isArray(session.plan_json?.meta_ad_ids)
    ? session.plan_json.meta_ad_ids
    : [];
  if (adIds.length === 0) return { result: empty(), effectiveStatus: session.status };

  let ads = [];
  try {
    ads = await fetchAdStatuses(adIds, { userId });
  } catch (err) {
    // Don't block the action on a reconcile-only failure. Log and proceed
    // with whatever DB.status says.
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'warn',
      event: 'ogilvy.reconcile.fetch_failed',
      component: 'ogilvy/reconcile',
      session_id: session.id,
      error: err.message,
    }));
    return { result: empty(), effectiveStatus: session.status };
  }

  const result = await reconcileSessionFromMeta(session, ads);
  const effectiveStatus = result.status_changed?.to || session.status;
  return { result, effectiveStatus };
}

function empty() {
  return { status_changed: null, ids_stripped: 0, archived: false, reason: null };
}

function logReconcile(session, result) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    event: 'ogilvy.session.reconciled',
    component: 'ogilvy/reconcile',
    session_id: session.id,
    tenant_id: session.tenant_id,
    from_status: result.status_changed?.from || null,
    to_status: result.status_changed?.to || null,
    ids_stripped: result.ids_stripped,
    archived: result.archived,
    reason: result.reason,
  }));
}
