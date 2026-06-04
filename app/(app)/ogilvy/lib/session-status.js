/**
 * Single source of truth for "what status do I show for this Ogilvy session?".
 *
 * Used by 3 surfaces — they MUST agree on tone + label for the same session:
 *   - SessionGridCard          (网格卡片)
 *   - SessionWorkspace header  (模态顶部)
 *   - AdPlanCard footer        (方案卡底部)
 *
 * ── Design rule: Meta-effective state wins over configured DB state. ────
 *
 * If we configured the session as launched/paused AND we have Meta's per-ad
 * `effective_status`, the **primary label reflects what Meta is actually
 * doing**, not what we asked for. A DISAPPROVED ad is not "投放中" no matter
 * what our DB says — surface the truth so a scan of the grid catches Meta-
 * side problems instantly (rejection, billing block, all paused etc.).
 *
 * Earlier iterations tried "DB primary + Meta as a small chip" — that hid
 * critical Meta state behind a chip the user couldn't see on the grid (we
 * don't fetch per-card Meta state with chips, and even when we did, the chip
 * sat below the headline and got missed). User feedback was unambiguous:
 * the headline should reflect Meta reality.
 *
 * For grid card to mirror this, OgilvyApp fetches a per-session ad-status
 * summary in bulk (/api/ogilvy/sessions/ad-status) and passes it down.
 */

// Meta `effective_status` → coarse 5-bucket map. Long Meta enum collapsed
// so the UI has finite labels. Source:
// https://developers.facebook.com/docs/marketing-api/reference/ad-account/ads
const META_STATUS_BUCKET = {
  ACTIVE:                'active',
  IN_PROCESS:            'review',
  PENDING_REVIEW:        'review',
  DISAPPROVED:           'rejected',
  WITH_ISSUES:           'issue',
  PENDING_BILLING_INFO:  'issue',
  ADSET_PAUSED:          'paused',
  CAMPAIGN_PAUSED:       'paused',
  PAUSED:                'paused',
  ARCHIVED:              'paused',
  DELETED:               'paused',
};
// Worst-wins severity for picking the bucket that drives the headline.
const BUCKET_SEVERITY = { rejected: 4, issue: 3, review: 2, paused: 1, active: 0 };

export function summarizeAdStatuses(ads = []) {
  if (!Array.isArray(ads) || ads.length === 0) return null;
  const counts = { active: 0, review: 0, rejected: 0, issue: 0, paused: 0 };
  for (const ad of ads) {
    const b = META_STATUS_BUCKET[ad?.effective_status] || 'paused';
    counts[b] += 1;
  }
  const worst = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => BUCKET_SEVERITY[b[0]] - BUCKET_SEVERITY[a[0]])[0]?.[0] || 'active';
  return { counts, worst, total: ads.length };
}

// Bucket → primary (tone + label) the UI renders.
// Tone keys map to CSS variants `.gridCardTone_*`, `.statusDot_*`, etc.
const BUCKET_TO_STATE = {
  active:   { tone: 'launched', label: '投放中' },
  review:   { tone: 'busy',     label: '审核中' },
  rejected: { tone: 'failed',   label: '被拒' },
  issue:    { tone: 'failed',   label: '有问题' },
  paused:   { tone: 'paused',   label: '已暂停' },
};

// Mirrors STAGING_STALE_MS in
// app/api/ogilvy/conversations/[id]/launch/route.js. A `staging`/`staged` row
// older than this — with no in-flight launch SSE refreshing updated_at — is an
// abandoned launch (client disconnect / instance recycle), not active progress.
// The backend already lets such a row be re-claimed; the UI must agree, or the
// launch button shows "启动中…" forever and the user is locked out. Keep the
// two constants in sync.
export const STAGING_STALE_MS = 5 * 60 * 1000;

export function isStagingStale(status, updatedAt) {
  if (status !== 'staging' && status !== 'staged') return false;
  if (!updatedAt) return false;
  return Date.now() - new Date(updatedAt).getTime() > STAGING_STALE_MS;
}

/**
 * Derive what to render for a session's status. See file header for design
 * rule (Meta state primary, DB state fallback).
 *
 * Inputs (each surface passes what it has):
 *   - sessionStatus  — `session.status` from DB
 *   - planStatus     — `plan_json.status` from DB (only meaningful with plan)
 *   - hasPlan        — true when plan_json is non-null. Distinguishes
 *                      "no plan yet" (draft) from "plan ready, not launched" (ready)
 *   - adStatuses     — { summary } from /ad-status; OVERRIDES configured state
 *                      when session is launched/paused on Meta
 *   - launchProgress — { phase } during in-flight launch SSE (modal-only)
 *   - streaming      — true while draft_ad_plan streams (modal-only)
 *   - updatedAt      — `session.updated_at`; used to detect an abandoned
 *                      staging/staged launch (see isStagingStale)
 *
 * Returns: { tone, label }
 *
 * Tones:
 *   draft | ready | busy | launched | paused | failed | archived | streaming
 */
export function deriveSessionStatus({
  sessionStatus = null,
  planStatus = null,
  hasPlan = false,
  adStatuses = null,
  launchProgress = null,
  streaming = false,
  updatedAt = null,
} = {}) {
  // Ephemeral states win — DB is stale mid-stream by definition.
  if (streaming) return { tone: 'streaming', label: '生成中…' };
  if (launchProgress?.phase) return { tone: 'busy', label: '启动中…' };

  // Configured-state flags from DB. Session.status leads; plan.status echoes
  // it but can be slightly ahead during transitions.
  const isLaunched  = sessionStatus === 'launched' || planStatus === 'launched';
  const isPaused    = sessionStatus === 'paused'   || planStatus === 'paused';
  const isStaged    = sessionStatus === 'staged'   || planStatus === 'staged';
  const isStaging   = sessionStatus === 'staging'  || planStatus === 'staging';
  const isFailed    = sessionStatus === 'failed'   || planStatus === 'failed';
  const isArchived  = sessionStatus === 'archived';

  // Meta override:while session is live on Meta(launched/paused), the
  // user-visible state is whatever Meta is actually doing — not our intent.
  // Examples this catches:
  //   - DB launched, all ads DISAPPROVED on Meta → "被拒"(红)
  //   - DB launched, ads still IN_PROCESS → "审核中"(琥珀)
  //   - DB launched, user paused on Meta UI → "已暂停"
  //   - Any of the above with mixed buckets → worst-wins
  if ((isLaunched || isPaused) && adStatuses?.summary) {
    const mapped = BUCKET_TO_STATE[adStatuses.summary.worst];
    if (mapped) return mapped;
  }

  if (isLaunched)      return { tone: 'launched', label: '投放中' };
  if (isPaused)        return { tone: 'paused',   label: '已暂停' };

  // Abandoned-launch recovery: a staging/staged row that's gone stale — no
  // in-flight SSE refreshing updated_at — is a dead launch, not progress. The
  // streaming / launchProgress guards above already shield a live in-modal
  // launch. Surface it as recoverable (same threshold the backend uses to
  // allow re-claiming the row) so the launch CTA flips back to a retry instead
  // of a forever-spinning "启动中…".
  if ((isStaged || isStaging) &&
      (isStagingStale(sessionStatus, updatedAt) || isStagingStale(planStatus, updatedAt))) {
    return { tone: 'failed', label: '启动中断' };
  }

  if (isStaged)        return { tone: 'busy',     label: '激活中…' };
  if (isStaging)       return { tone: 'busy',     label: '启动中…' };
  if (isFailed)        return { tone: 'failed',   label: '启动失败' };
  if (isArchived)      return { tone: 'archived', label: '已归档' };
  if (hasPlan)         return { tone: 'ready',    label: '方案就绪' };
  return                       { tone: 'draft',   label: '草稿' };
}
