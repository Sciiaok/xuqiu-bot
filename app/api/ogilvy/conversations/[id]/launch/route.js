import { getTenantContext } from '../../../../../../lib/tenant-context.js';
import {
  getSession,
  updateSession,
  transitionSessionStatus,
} from '../../../../../../lib/repositories/ogilvy.repository.js';
import { stageCampaigns, activateCampaigns } from '../../../../../../src/agents/ogilvy/meta-launch.service.js';
import { streamSSE } from '../../../../../../lib/sse.js';

/**
 * POST /api/ogilvy/conversations/[id]/launch
 *
 * Launches the session's current plan_json. Two phases, streamed as SSE:
 *   1. stage — create campaign / adset / creative / ad in PAUSED status on Meta
 *   2. activate — flip each campaign to ACTIVE
 *
 * Session status transitions: active → staging → launched (or failed).
 * Populates session.meta_campaign_ids on success so the UI can link out.
 *
 * This endpoint is deliberately independent from the Agent chat loop — the
 * user's button click is the consent, no LLM in the loop.
 */

// `staging` is a transient state held only while runLaunch is actively
// executing. If a client disconnects (browser close, network drop, serverless
// instance recycle) mid-flight, the row gets stuck in `staging` and the
// normal `from:['active','failed']` retry gate locks the user out forever.
// We treat staging older than this as abandoned and allow re-claiming it.
// Full launches take 30-90s in practice; 5 min is a 3-6x safety margin.
const STAGING_STALE_MS = 5 * 60 * 1000;

export async function POST(_request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const session = await getSession(id);
  if (!session || session.tenant_id !== ctx.tenantId) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }
  if (!session.plan_json) return Response.json({ error: 'No plan to launch' }, { status: 400 });

  // Atomic claim: only sessions in `active` or `failed` may transition to
  // `staging`. The `active` source is the normal first-launch path. The
  // `failed` source is the retry path — we previously rejected retries
  // wholesale (theory: prior failure left PAUSED Meta resources), but
  // in practice we now persist partial IDs (P0-2), so the user can clean
  // those up via Ads Manager and retry. Doubling up means a few extra
  // PAUSED rows to delete manually, which is far less painful than
  // rebuilding a plan from scratch.
  //
  // Stale-staging recovery (P0-1): if the row is stuck in `staging` past
  // STAGING_STALE_MS — only possible when a prior runLaunch died without
  // landing a terminal status — allow this request to re-claim it. The
  // race-condition rationale (two POSTs in flight) is preserved because
  // an in-flight launch refreshes updated_at on every step, so a truly
  // active launch is never stale.
  const stagingStale =
    session.status === 'staging' &&
    session.updated_at &&
    Date.now() - new Date(session.updated_at).getTime() > STAGING_STALE_MS;

  // Strip the previous-attempt failure tombstone before re-staging. Every
  // downstream update uses `{ ...plan, ... }`, so without this purge any
  // failed_* field set on the previous attempt would survive the entire
  // staging → staged → launched lifecycle and end up on a "successfully
  // launched" plan_json — confusing in the UI and a noisy false positive
  // for anyone reading the row later.
  const {
    failed_reason: _fr,
    failed_at: _fa,
    failed_phase: _fp,
    activate_partial_failures: _apf,
    ...planClean
  } = session.plan_json || {};
  const plan = planClean;

  const fromStatuses = ['active', 'failed', ...(stagingStale ? ['staging'] : [])];
  const claim = await transitionSessionStatus(id, {
    from: fromStatuses,
    to: 'staging',
    extraUpdates: { plan_json: { ...plan, status: 'staging' } },
  });
  if (claim?.conflict) {
    const cur = claim.conflict.current_status;
    if (cur === 'launched') return Response.json({ error: 'Already launched' }, { status: 400 });
    if (cur === 'staging' || cur === 'staged') {
      return Response.json({ error: 'Launch already in progress' }, { status: 409 });
    }
    return Response.json({ error: `Session not in launchable state (status=${cur})` }, { status: 409 });
  }

  if (stagingStale) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'warn',
      event: 'ogilvy.launch.staging_reclaimed',
      component: 'ogilvy/launch',
      session_id: id,
      tenant_id: ctx.tenantId,
      user_id: ctx.user.id,
      previous_updated_at: session.updated_at,
      stale_ms: Date.now() - new Date(session.updated_at).getTime(),
    }));
  }

  async function* runLaunch() {
    yield { event: 'status', data: { status: 'staging' } };

    // ── Phase 1: stage (PAUSED) ──
    // Accumulate IDs from progress events so partial Meta resources are
    // recoverable if stage throws midway (P0-2). Pre-fix, the stageCampaigns
    // generator's `out` object was only readable via its `return` value, so
    // any throw lost everything created up to that point — leaving orphan
    // PAUSED entities on Meta with no IDs in our DB.
    const partialIds = { campaign_ids: [], adset_ids: [], creative_ids: [], ad_ids: [] };
    let stageResult = null;
    try {
      const stageGen = stageCampaigns(plan, { userId: ctx.user.id });
      while (true) {
        const { value, done } = await stageGen.next();
        if (done) { stageResult = value; break; }
        if (value?.type === 'campaign_created' && value.id) partialIds.campaign_ids.push(value.id);
        else if (value?.type === 'adset_created' && value.id) partialIds.adset_ids.push(value.id);
        else if (value?.type === 'creative_created' && value.id) partialIds.creative_ids.push(value.id);
        else if (value?.type === 'ad_created' && value.id) partialIds.ad_ids.push(value.id);
        yield { event: 'stage_progress', data: value };
      }
    } catch (err) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        event: 'ogilvy.stage_campaigns.failed',
        component: 'ogilvy/launch',
        session_id: id,
        tenant_id: ctx.tenantId,
        user_id: ctx.user.id,
        step: err.step || null,
        http_status: err.metaStatus || null,
        meta_code: err.metaError?.code ?? null,
        meta_error_subcode: err.metaError?.error_subcode ?? null,
        fbtrace_id: err.metaError?.fbtrace_id || null,
        partial_campaigns: partialIds.campaign_ids.length,
        partial_adsets: partialIds.adset_ids.length,
        partial_creatives: partialIds.creative_ids.length,
        partial_ads: partialIds.ad_ids.length,
        error: err.message,
      }));
      await updateSession(id, {
        status: 'failed',
        // Persist the column too, so the UI doesn't have to dig into plan_json.
        meta_campaign_ids: partialIds.campaign_ids,
        plan_json: {
          ...plan,
          status: 'failed',
          failed_reason: err.message,
          failed_at: new Date().toISOString(),
          meta_campaign_ids: partialIds.campaign_ids,
          meta_adset_ids: partialIds.adset_ids,
          meta_creative_ids: partialIds.creative_ids,
          meta_ad_ids: partialIds.ad_ids,
        },
      });
      yield {
        event: 'error',
        data: {
          phase: 'stage',
          message: err.message,
          partial_ids: partialIds,
        },
      };
      return;
    }

    const campaignIds = stageResult?.campaign_ids || [];
    if (campaignIds.length === 0) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        event: 'ogilvy.stage_campaigns.empty',
        component: 'ogilvy/launch',
        session_id: id,
        tenant_id: ctx.tenantId,
        user_id: ctx.user.id,
        plan_campaign_count: (plan.campaigns || []).length,
      }));
      await updateSession(id, {
        status: 'failed',
        plan_json: { ...plan, status: 'failed', failed_reason: 'stage_produced_no_campaigns' },
      });
      yield { event: 'error', data: { phase: 'stage', message: '没有创建任何 campaign，请检查 plan_json' } };
      return;
    }

    // Persist the IDs immediately so even if activate crashes, the UI can show
    // the user what was created on Meta.
    await updateSession(id, {
      meta_campaign_ids: campaignIds,
      plan_json: {
        ...plan,
        status: 'staged',
        meta_campaign_ids: campaignIds,
        meta_adset_ids: stageResult.adset_ids,
        meta_ad_ids: stageResult.ad_ids,
      },
    });
    yield { event: 'staged', data: { campaign_ids: campaignIds, adset_ids: stageResult.adset_ids, ad_ids: stageResult.ad_ids } };

    // ── Phase 2: activate (campaigns + adsets + ads — all 3 levels) ──
    // Meta only serves an entity when every ancestor is ACTIVE, so flipping
    // just the campaign is not enough; Ads Manager will show the ad set as
    // "广告组已关闭" even though the campaign is live.
    const activateResults = [];
    try {
      const actGen = activateCampaigns({
        campaign_ids: campaignIds,
        adset_ids: stageResult.adset_ids,
        ad_ids: stageResult.ad_ids,
      }, { userId: ctx.user.id });
      while (true) {
        const { value, done } = await actGen.next();
        if (done) { Array.isArray(value) && activateResults.push(...value); break; }
        yield { event: 'activate_progress', data: value };
      }
    } catch (err) {
      // Generator threw outright (e.g. token error before any flip ran).
      // Adset/ad IDs from the just-finished stage step are preserved so the
      // user (or a follow-up cleanup) can still find the orphaned PAUSED
      // resources on Meta.
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        event: 'ogilvy.activate_campaigns.failed',
        component: 'ogilvy/launch',
        session_id: id,
        tenant_id: ctx.tenantId,
        user_id: ctx.user.id,
        campaign_count: campaignIds.length,
        adset_count: stageResult.adset_ids?.length || 0,
        ad_count: stageResult.ad_ids?.length || 0,
        partial_activations: activateResults.length,
        step: err.step || null,
        http_status: err.metaStatus || null,
        meta_code: err.metaError?.code ?? null,
        meta_error_subcode: err.metaError?.error_subcode ?? null,
        fbtrace_id: err.metaError?.fbtrace_id || null,
        error: err.message,
      }));
      await updateSession(id, {
        status: 'failed',
        plan_json: {
          ...plan,
          status: 'failed',
          failed_reason: err.message,
          failed_at: new Date().toISOString(),
          meta_campaign_ids: campaignIds,
          meta_adset_ids: stageResult.adset_ids,
          meta_ad_ids: stageResult.ad_ids,
        },
      });
      yield { event: 'error', data: { phase: 'activate', message: err.message } };
      return;
    }

    // Partial-failure semantics (P0-3): if ANY entity activated, the user
    // is now spending money on Meta. We cannot mark the whole launch
    // `failed` — that locks /pause out (its guard only allows
    // from:['launched']) and leaves the user with no in-app way to stop
    // the burn. Three outcomes:
    //
    //   - 0 succeeded            → 'failed' (clean abort, no spend)
    //   - all succeeded          → 'launched' (happy path)
    //   - some succeeded, some failed → 'launched' (so /pause works),
    //                              + activate_partial_failures field
    //                              + activate_partial event for the UI banner
    //
    // The UI must show a warning when activate_partial_failures is non-empty
    // so the user knows part of their tree is dead and can decide whether
    // to keep, fix, or pause everything.
    const activateFailed = activateResults.filter(r => r.error);
    const activateSucceeded = activateResults.filter(r => !r.error);
    const allFailed = activateSucceeded.length === 0;
    const partialFailed = !allFailed && activateFailed.length > 0;
    const finalStatus = allFailed ? 'failed' : 'launched';

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: activateFailed.length > 0 ? 'error' : 'info',
      event: allFailed
        ? 'ogilvy.launch.all_failed'
        : partialFailed
          ? 'ogilvy.launch.partial_failed'
          : 'ogilvy.launch.completed',
      component: 'ogilvy/launch',
      session_id: id,
      tenant_id: ctx.tenantId,
      user_id: ctx.user.id,
      campaign_ids: campaignIds,
      adset_count: stageResult.adset_ids?.length || 0,
      ad_count: stageResult.ad_ids?.length || 0,
      activate_total: activateResults.length,
      activate_succeeded: activateSucceeded.length,
      activate_failed: activateFailed.length,
      failed_entities: activateFailed.map(r => ({ level: r.level, id: r.id, error: r.error })),
    }));

    await updateSession(id, {
      status: finalStatus,
      plan_json: {
        ...plan,
        status: finalStatus,
        meta_campaign_ids: campaignIds,
        meta_adset_ids: stageResult.adset_ids,
        meta_ad_ids: stageResult.ad_ids,
        ...(finalStatus === 'launched'
          ? { launched_at: new Date().toISOString() }
          : { failed_reason: 'activate_all_failed', failed_at: new Date().toISOString() }),
        ...(partialFailed
          ? {
              activate_partial_failures: activateFailed.map(r => ({
                level: r.level,
                id: r.id,
                error: r.error,
              })),
            }
          : {}),
      },
    });

    yield {
      event: 'launched',
      data: {
        status: finalStatus,
        partial: partialFailed,
        campaign_ids: campaignIds,
        activate_results: activateResults,
        activate_succeeded: activateSucceeded.length,
        activate_failed: activateFailed.length,
      },
    };
  }

  return streamSSE(runLaunch(), { heartbeatIntervalMs: 15_000 });
}
