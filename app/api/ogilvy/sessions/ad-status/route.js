/**
 * GET /api/ogilvy/sessions/ad-status
 *
 * 给网格卡片用的批量 Meta effective_status 拉取。每个 launched/paused 的
 * session 返回一个 { worst, counts, total } summary —— 跟单 session 端点
 * (/api/ogilvy/conversations/[id]/ad-status) 用同一套 summarize 算法,所以
 * 网格卡和模态内的状态一致。
 *
 * Meta 一次 batch 调用就能查任意数量的 ad_id(GET /?ids=A,B,C&fields=…),
 * 所以即便几十个 session 也只是一次 Meta 调用。Redis 缓存 3 分钟 —— 比 metrics
 * 的 5 分钟短,因为审核/暂停状态变化更快,但仍能压住网格反复打 Meta。
 */
import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../../lib/tenant-context.js';
import { getRedis } from '../../../../../lib/redis.js';
import { listSessions } from '../../../../../lib/repositories/ogilvy.repository.js';
import { fetchAdStatuses } from '../../../../../src/agents/ogilvy/meta-launch.service.js';

const CACHE_TTL_SECONDS = 3 * 60;

// Inlined to avoid importing UI-layer code from API. Keep in sync with
// app/(app)/ogilvy/lib/session-status.js — if you tweak the bucket map there,
// reflect it here too. Both are small; full move-to-shared-lib is overkill.
const META_STATUS_BUCKET = {
  ACTIVE: 'active', IN_PROCESS: 'review', PENDING_REVIEW: 'review',
  DISAPPROVED: 'rejected', WITH_ISSUES: 'issue', PENDING_BILLING_INFO: 'issue',
  ADSET_PAUSED: 'paused', CAMPAIGN_PAUSED: 'paused', PAUSED: 'paused',
  ARCHIVED: 'paused', DELETED: 'paused',
};
const BUCKET_SEVERITY = { rejected: 4, issue: 3, review: 2, paused: 1, active: 0 };
function summarizeAdStatuses(ads) {
  if (!Array.isArray(ads) || ads.length === 0) return null;
  const counts = { active: 0, review: 0, rejected: 0, issue: 0, paused: 0 };
  for (const ad of ads) {
    const b = META_STATUS_BUCKET[ad?.effective_status] || 'paused';
    counts[b] += 1;
  }
  const worst = Object.entries(counts).filter(([, n]) => n > 0)
    .sort((a, b) => BUCKET_SEVERITY[b[0]] - BUCKET_SEVERITY[a[0]])[0]?.[0] || 'active';
  return { counts, worst, total: ads.length };
}

export async function GET() {
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const sessions = await listSessions({ tenantId: ctx.tenantId, userId: ctx.user.id });

    // 只查 launched / paused 的 session(其他状态没 Meta 实体可查)
    const adIdToSession = new Map();
    for (const sess of sessions) {
      if (sess.status !== 'launched' && sess.status !== 'paused') continue;
      const adIds = sess.plan_json?.meta_ad_ids;
      if (!Array.isArray(adIds)) continue;
      for (const adId of adIds) {
        if (adId) adIdToSession.set(String(adId), sess.id);
      }
    }
    if (adIdToSession.size === 0) {
      return NextResponse.json({ statuses: {} });
    }

    const adIds = Array.from(adIdToSession.keys()).sort();
    const cacheKey = `ogilvy:ad-status:${ctx.tenantId}:${ctx.user.id}:${adIds.join(',')}`;
    try {
      const cached = await getRedis().get(cacheKey);
      if (cached) return NextResponse.json(JSON.parse(cached));
    } catch { /* redis down — fall through */ }

    let ads = [];
    try {
      // 一次 batch 拿全部 effective_status。Meta 这接口对未配置 Meta 的 tenant
      // 会抛"Meta 未连接",在网格场景下直接返回空 statuses,卡片继续显示 DB 态。
      ads = await fetchAdStatuses(adIds, { userId: ctx.user.id });
    } catch (err) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'warn',
        event: 'ogilvy.batch_fetch_ad_statuses.failed',
        component: 'ogilvy/sessions-ad-status',
        tenant_id: ctx.tenantId,
        ad_count: adIds.length,
        meta_code: err.metaError?.code ?? null,
        fbtrace_id: err.metaError?.fbtrace_id || null,
        error: err.message,
      }));
      return NextResponse.json({ statuses: {}, warning: err.message });
    }

    // 按 session 分组
    const adsBySession = {};
    for (const ad of ads) {
      const sId = adIdToSession.get(String(ad.id));
      if (!sId) continue;
      (adsBySession[sId] ||= []).push(ad);
    }

    // summarize 每个 session
    const statuses = {};
    for (const [sId, ads] of Object.entries(adsBySession)) {
      const summary = summarizeAdStatuses(ads);
      if (summary) statuses[sId] = { summary };
    }

    const payload = { statuses, fetched_at: new Date().toISOString() };
    try {
      await getRedis().set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS);
    } catch { /* ignore */ }

    return NextResponse.json(payload);
  } catch (err) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'ogilvy.sessions_ad_status.unhandled_error',
      component: 'ogilvy/sessions-ad-status',
      tenant_id: ctx.tenantId,
      error: err.message,
    }));
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
