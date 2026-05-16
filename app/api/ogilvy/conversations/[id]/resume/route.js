import { getTenantContext } from '../../../../../../lib/tenant-context.js';
import {
  getSession,
  updateSession,
  transitionSessionStatus,
} from '../../../../../../lib/repositories/ogilvy.repository.js';
import { setCampaignsStatus } from '../../../../../../src/agents/ogilvy/meta-launch.service.js';

/**
 * POST /api/ogilvy/conversations/[id]/resume
 *
 * Inverse of /pause. Flip a paused session's campaigns / adsets / ads back to
 * ACTIVE on Meta and mark session.status = 'launched'.
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
    return Response.json({ error: '该会话没有 campaign 可恢复' }, { status: 400 });
  }

  const claim = await transitionSessionStatus(id, {
    from: ['paused'],
    to: 'launched',
  });
  if (claim?.conflict) {
    const cur = claim.conflict.current_status;
    return Response.json(
      { error: `当前状态 ${cur} 无法恢复（只能恢复 paused 会话）` },
      { status: 409 },
    );
  }

  let results;
  try {
    results = await setCampaignsStatus(
      { campaign_ids: campaignIds, adset_ids: adsetIds, ad_ids: adIds },
      'ACTIVE',
      { userId: ctx.user.id },
    );
  } catch (err) {
    await transitionSessionStatus(id, { from: ['launched'], to: 'paused' });
    return Response.json({ error: err.message }, { status: 500 });
  }

  const failed = results.filter((r) => r.error);
  if (failed.length > 0) {
    await transitionSessionStatus(id, { from: ['launched'], to: 'paused' });
    return Response.json(
      { error: '部分实体恢复失败，已回滚', failed },
      { status: 500 },
    );
  }

  await updateSession(id, {
    plan_json: { ...plan, status: 'launched', resumed_at: new Date().toISOString() },
  });
  return Response.json({ ok: true, results });
}
