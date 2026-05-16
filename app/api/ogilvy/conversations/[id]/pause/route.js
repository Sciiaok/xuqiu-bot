import { getTenantContext } from '../../../../../../lib/tenant-context.js';
import {
  getSession,
  updateSession,
  transitionSessionStatus,
} from '../../../../../../lib/repositories/ogilvy.repository.js';
import { setCampaignsStatus } from '../../../../../../src/agents/ogilvy/meta-launch.service.js';

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

  const plan = session.plan_json || {};
  const campaignIds = plan.meta_campaign_ids || session.meta_campaign_ids || [];
  const adsetIds = plan.meta_adset_ids || [];
  const adIds = plan.meta_ad_ids || [];
  if (campaignIds.length === 0) {
    return Response.json({ error: '该会话没有已上线的 campaign，无法暂停' }, { status: 400 });
  }

  const claim = await transitionSessionStatus(id, {
    from: ['launched'],
    to: 'paused',
  });
  if (claim?.conflict) {
    const cur = claim.conflict.current_status;
    return Response.json(
      { error: `当前状态 ${cur} 无法暂停（只能暂停 launched 会话）` },
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
    await transitionSessionStatus(id, { from: ['paused'], to: 'launched' });
    return Response.json({ error: err.message }, { status: 500 });
  }

  const failed = results.filter((r) => r.error);
  if (failed.length > 0) {
    // Any failure → revert. Partial pause is worse than no pause (user thinks
    // it's stopped, money still burning).
    await transitionSessionStatus(id, { from: ['paused'], to: 'launched' });
    return Response.json(
      { error: '部分实体暂停失败，已回滚', failed },
      { status: 500 },
    );
  }

  await updateSession(id, {
    plan_json: { ...plan, status: 'paused', paused_at: new Date().toISOString() },
  });
  return Response.json({ ok: true, results });
}
