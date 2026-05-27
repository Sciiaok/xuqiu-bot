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
  // `failed` source is the retry path — historically blocked on the theory
  // that "previous failure created PAUSED Meta resources, don't double-stage";
  // in practice we never persisted the partial IDs (stage catch dropped them
  // before the IDs reached plan_json), so the guard had nothing to compare
  // against and just blanket-rejected retries. Users had to delete + recreate
  // for any failure cause, even transient ones. Cleanup of partial Meta
  // resources is the user's responsibility (Ads Manager filter by campaign
  // name); doubling up means a few extra PAUSED rows to delete manually,
  // which is far less painful than rebuilding a plan from scratch.
  //
  // The race-condition rationale (two POSTs in flight) is preserved by the
  // single allowed `staging` target — the second POST sees status=staging
  // and bounces below.
  const plan = session.plan_json;
  const claim = await transitionSessionStatus(id, {
    from: ['active', 'failed'],
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

  async function* runLaunch() {
    yield { event: 'status', data: { status: 'staging' } };

    // ── Phase 1: stage (PAUSED) ──
    let stageResult = null;
    try {
      const stageGen = stageCampaigns(plan, { userId: ctx.user.id });
      while (true) {
        const { value, done } = await stageGen.next();
        if (done) { stageResult = value; break; }
        yield { event: 'stage_progress', data: value };
      }
    } catch (err) {
      // Stage failed — mark failed, keep any partial plan_json (debugging aid).
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
        error: err.message,
      }));
      await updateSession(id, {
        status: 'failed',
        plan_json: { ...plan, status: 'failed', failed_reason: err.message, failed_at: new Date().toISOString() },
      });
      yield { event: 'error', data: { phase: 'stage', message: err.message } };
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
      // Preserve adset/ad IDs from the just-finished stage step so the user
      // (or a follow-up cleanup) can still find the orphaned PAUSED resources
      // on Meta. Without these, only campaign IDs survive and cleanup has to
      // crawl down from each campaign.
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
          meta_campaign_ids: campaignIds,
          meta_adset_ids: stageResult.adset_ids,
          meta_ad_ids: stageResult.ad_ids,
        },
      });
      yield { event: 'error', data: { phase: 'activate', message: err.message } };
      return;
    }

    const anyFailed = activateResults.some(r => r.error);
    const finalStatus = anyFailed ? 'failed' : 'launched';
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: anyFailed ? 'error' : 'info',
      event: anyFailed ? 'ogilvy.launch.partial_failed' : 'ogilvy.launch.completed',
      component: 'ogilvy/launch',
      session_id: id,
      tenant_id: ctx.tenantId,
      user_id: ctx.user.id,
      campaign_ids: campaignIds,
      adset_count: stageResult.adset_ids?.length || 0,
      ad_count: stageResult.ad_ids?.length || 0,
      activate_total: activateResults.length,
      activate_failed: activateResults.filter(r => r.error).length,
      failed_entities: activateResults.filter(r => r.error).map(r => ({ level: r.level, id: r.id, error: r.error })),
    }));
    await updateSession(id, {
      status: finalStatus,
      plan_json: {
        ...plan,
        status: finalStatus,
        meta_campaign_ids: campaignIds,
        meta_adset_ids: stageResult.adset_ids,
        meta_ad_ids: stageResult.ad_ids,
        launched_at: finalStatus === 'launched' ? new Date().toISOString() : undefined,
      },
    });
    yield { event: 'launched', data: { status: finalStatus, campaign_ids: campaignIds, activate_results: activateResults } };
  }

  return streamSSE(runLaunch(), { heartbeatIntervalMs: 15_000 });
}
