import { getTenantContext } from '../../../../../../lib/tenant-context.js';
import {
  getSession,
  updateSession,
  transitionSessionStatus,
} from '../../../../../../lib/repositories/ogilvy.repository.js';
import { setCampaignsStatus } from '../../../../../../src/agents/ogilvy/meta-launch.service.js';
import { reconcileForAction } from '../../../../../../src/agents/ogilvy/reconcile.service.js';

/**
 * POST /api/ogilvy/conversations/[id]/pause
 *
 * Flip a launched session's campaigns / adsets / ads to PAUSED on Meta and
 * mark session.status = 'paused'. Reversible via /resume.
 *
 * Atomic claim: only sessions in `launched` may transition to `paused`. If a
 * pause call fails on Meta we revert the status so the user can retry instead
 * of being stuck in a half-state where the UI claims paused but campaigns are
 * still serving.
 */
export async function POST(_request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const session = await getSession(id);
  if (!session || session.tenant_id !== ctx.tenantId) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  // Pre-action drift sync: pull Meta state once and reconcile DB before
  // gating on session.status. If the user already paused everything in Meta
  // Ads Manager, our DB still says 'launched' until something talks to Meta —
  // without this, /pause would proceed and burn N Meta calls just to confirm
  // the entities are already PAUSED. After reconcile, three outcomes:
  //   - DB now says 'paused' → user's request is already satisfied, return OK
  //   - DB now says 'archived' → entities are gone, action no longer applies
  //   - DB still 'launched' → proceed with the normal pause flow
  const { result: reconcileResult, effectiveStatus } = await reconcileForAction(session, { userId: ctx.user.id });
  if (effectiveStatus === 'paused') {
    return Response.json({
      ok: true,
      message: 'Meta 上已是暂停状态,已同步 DB,无需再操作',
      reconciled_from_meta: reconcileResult.status_changed || true,
    });
  }
  if (effectiveStatus === 'archived') {
    return Response.json(
      {
        error: 'Meta 上的实体已被全部删除,session 已自动归档',
        reconciled_from_meta: reconcileResult,
      },
      { status: 409 },
    );
  }

  // Re-read plan after reconcile in case meta_ad_ids was pruned for missing
  // entities. campaignIds / adsetIds rarely drift in Phase 1 reconcile (only
  // ad-level cleanup is implemented) but read fresh anyway for safety.
  const freshSession = await getSession(id);
  const plan = freshSession?.plan_json || {};
  const campaignIds = plan.meta_campaign_ids || freshSession?.meta_campaign_ids || [];
  const adsetIds = plan.meta_adset_ids || [];
  const adIds = plan.meta_ad_ids || [];
  if (campaignIds.length === 0) {
    return Response.json({ error: '该会话没有已上线的 campaign,无法暂停' }, { status: 400 });
  }

  const claim = await transitionSessionStatus(id, {
    from: ['launched'],
    to: 'paused',
  });
  if (claim?.conflict) {
    const cur = claim.conflict.current_status;
    return Response.json(
      { error: `当前状态 ${cur} 无法暂停(只能暂停 launched 会话)` },
      { status: 409 },
    );
  }

  let results;
  try {
    results = await setCampaignsStatus(
      { campaign_ids: campaignIds, adset_ids: adsetIds, ad_ids: adIds },
      'PAUSED',
      { userId: ctx.user.id },
    );
  } catch (err) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'ogilvy.pause_campaigns.failed',
      component: 'ogilvy/pause',
      session_id: id,
      tenant_id: ctx.tenantId,
      user_id: ctx.user.id,
      campaign_count: campaignIds.length,
      adset_count: adsetIds.length,
      ad_count: adIds.length,
      reverted: true,
      step: err.step || null,
      meta_code: err.metaError?.code ?? null,
      fbtrace_id: err.metaError?.fbtrace_id || null,
      error: err.message,
    }));
    await transitionSessionStatus(id, { from: ['paused'], to: 'launched' });
    return Response.json({ error: err.message }, { status: 500 });
  }

  const failed = results.filter((r) => r.error);
  if (failed.length > 0) {
    // Best-effort reverse (P0-4): some entities did go to PAUSED on Meta.
    // Reverting only DB status leaves Meta in a half-paused state — UI says
    // "launched" but a chunk of the tree is dead, with no visible signal.
    // Flip the successful ones back to ACTIVE so Meta state matches DB state.
    // The reverse can itself fail (rate limit, transient blip); we surface
    // that as `reverse_failures` so the user sees the residual drift.
    const succeeded = results.filter((r) => !r.error);
    let reverseResults = [];
    if (succeeded.length > 0) {
      try {
        reverseResults = await setCampaignsStatus(
          {
            campaign_ids: succeeded.filter(r => r.level === 'campaign').map(r => r.id),
            adset_ids: succeeded.filter(r => r.level === 'adset').map(r => r.id),
            ad_ids: succeeded.filter(r => r.level === 'ad').map(r => r.id),
          },
          'ACTIVE',
          { userId: ctx.user.id },
        );
      } catch (revErr) {
        reverseResults = succeeded.map(s => ({ ...s, error: `reverse threw: ${revErr.message}` }));
      }
    }
    const reverseFailed = reverseResults.filter(r => r.error);

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'ogilvy.pause_campaigns.partial_failed',
      component: 'ogilvy/pause',
      session_id: id,
      tenant_id: ctx.tenantId,
      user_id: ctx.user.id,
      total: results.length,
      failed_count: failed.length,
      reverse_attempted: succeeded.length,
      reverse_failed_count: reverseFailed.length,
      failed_entities: failed.map(r => ({ level: r.level, id: r.id, error: r.error })),
      reverse_failed_entities: reverseFailed.map(r => ({ level: r.level, id: r.id, error: r.error })),
      reverted: true,
      drift: reverseFailed.length > 0,
    }));
    await transitionSessionStatus(id, { from: ['paused'], to: 'launched' });
    return Response.json(
      {
        error: reverseFailed.length > 0
          ? '部分实体暂停失败,反向回滚也未全部成功 — Meta 上仍有部分实体处于 PAUSED 状态,需人工 fix'
          : '部分实体暂停失败,已成功回滚到 ACTIVE',
        failed,
        reverse_failures: reverseFailed,
      },
      { status: 500 },
    );
  }

  await updateSession(id, {
    plan_json: { ...plan, status: 'paused', paused_at: new Date().toISOString() },
  });
  return Response.json({ ok: true, results });
}
