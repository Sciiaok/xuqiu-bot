/**
 * GET /api/ogilvy/sessions/metrics
 *
 * 一次性返回当前用户所有 Ogilvy session 的投放数据(展示 / 点击 / 转化 / 花费)。
 *
 * 卡片网格 UI 一次拿全，避免每张卡分别打 Meta 一次。Meta 是慢调用 (5~20s)，
 * 这里走 Redis 缓存 5 分钟。逻辑：
 *
 *   1. 拉用户的所有 session，收集 plan_json.meta_ad_ids（最准，避免再走一次
 *      /ads?filtering=campaign.id IN 查 ad_id 的回环）。
 *   2. 用 Meta insights（time_range = 全周期，37 月封顶）一次性按 ad_id 拉
 *      展示 / 点击 / 花费。
 *   3. 转化数(conversations)走本地 `ad_conversation_stats` RPC —— 跟成本分析
 *      的「WA 对话」是同一口径(我们的 webhook 收到的、带 referral.meta_ad_id
 *      归因的 conversation 数),不再用 Meta 自家的 messaging_conversation_started
 *      action,避免两边数据撕裂。
 *   4. 把每条 ad 的数据归并到所属 session。
 *
 * 返回:
 *   { metrics: { <session_id>: { impressions, clicks, conversations, spend, has_data } } }
 *
 * 没有 Meta 配置 / 没有任何 launched session 直接返回空对象,不报错 —— 调用方
 * (新建未投放的 session) 只是看不到数字而已。
 */
import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../../lib/tenant-context.js';
import { resolveMetaContextForTenant } from '../../../../../lib/meta-tenant-context.js';
import { getSupabaseAdmin } from '../../../../../lib/supabase-admin.js';
import { getRedis } from '../../../../../lib/redis.js';
import { listSessions } from '../../../../../lib/repositories/ogilvy.repository.js';
import {
  fetchAllPages,
  META_API_VERSION,
} from '../../../../../src/meta-ads.service.js';

const CACHE_TTL_SECONDS = 5 * 60;
// Meta caps time_range at ~37 months. We always pull lifetime (since launch) so
// cards mirror "since this campaign went live".
const LIFETIME_DAYS = 1100;

function normalizeAdAccountId(value) {
  return String(value || '').replace(/^act_/, '').trim();
}

function toInt(value) {
  const parsed = parseInt(value || '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNumber(value, decimals = 2) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(decimals));
}

function buildSinceDate() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - LIFETIME_DAYS);
  return d.toISOString().slice(0, 10);
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

// Build Meta insights URL for a chunk of ad IDs. Meta tops out around 50-100
// IDs in the `filtering` payload before erroring, so callers chunk for us.
function buildInsightsUrl({ adAccountId, accessToken, adIds }) {
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: 'ad_id,spend,impressions,clicks',
    level: 'ad',
    time_range: JSON.stringify({ since: buildSinceDate(), until: todayDate() }),
    limit: '500',
    filtering: JSON.stringify([
      { field: 'ad.id', operator: 'IN', value: adIds },
    ]),
  });
  return `https://graph.facebook.com/${META_API_VERSION}/act_${adAccountId}/insights?${params.toString()}`;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function GET() {
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const sessions = await listSessions({ tenantId: ctx.tenantId, userId: ctx.user.id });

    // Map: ad_id -> session_id（一个 ad 只会属于一个 session，多份 sessions 共享
    // ad 的情况不可能 —— 每个 session 自己 staged 自己的 campaign 树）。
    const adIdToSession = new Map();
    for (const sess of sessions) {
      const adIds = sess.plan_json?.meta_ad_ids;
      if (!Array.isArray(adIds)) continue;
      for (const adId of adIds) {
        if (adId) adIdToSession.set(String(adId), sess.id);
      }
    }

    if (adIdToSession.size === 0) {
      return NextResponse.json({ metrics: {} });
    }

    // Cache key derived from the set of ad_ids — if anything launches new
    // ads the key changes naturally.
    const adIds = Array.from(adIdToSession.keys()).sort();
    const cacheKey = `ogilvy:metrics:${ctx.tenantId}:${ctx.user.id}:${adIds.join(',')}`;

    try {
      const redis = getRedis();
      const cached = await redis.get(cacheKey);
      if (cached) return NextResponse.json(JSON.parse(cached));
    } catch { /* redis down — fall through */ }

    const metaCtx = await resolveMetaContextForTenant(ctx.tenantId);
    const adAccountId = metaCtx.adAccountId ? normalizeAdAccountId(metaCtx.adAccountId) : null;
    const accessToken = metaCtx.accessToken;
    if (!accessToken || !adAccountId) {
      // No Meta — cards just show "尚未投放" branch on the client.
      return NextResponse.json({ metrics: {} });
    }

    const metrics = {};
    for (const sess of sessions) metrics[sess.id] = emptyMetrics();

    // Chunk to 50 ad IDs per request to keep the filtering payload comfortable.
    for (const adChunk of chunk(adIds, 50)) {
      let rows = [];
      try {
        rows = await fetchAllPages(
          buildInsightsUrl({ adAccountId, accessToken, adIds: adChunk })
        );
      } catch (err) {
        // Don't fail the whole endpoint on a single chunk error — log and skip.
        // The next refresh (cache miss in 5 min) gets another shot.
        console.warn('[ogilvy/sessions/metrics] insights chunk failed:', err.message);
        continue;
      }
      for (const row of rows) {
        const adId = String(row.ad_id || '').trim();
        const sessionId = adIdToSession.get(adId);
        if (!sessionId) continue;
        const m = metrics[sessionId];
        m.impressions += toInt(row.impressions);
        m.clicks += toInt(row.clicks);
        m.spend += Number(row.spend || 0);
        m.has_data = m.has_data || (m.impressions > 0 || m.clicks > 0 || m.spend > 0);
      }
    }

    // 转化数走本地 ad_conversation_stats RPC —— 跟成本分析卡同源,统一口径。
    // RPC 按 tenant_id 过滤,内存里再按当前用户的 adIdToSession 过滤一遍。
    // lifetime 模式:from epoch 到现在,RPC 内部 `created_at <= to_ts` 比较
    // value <= NULL 永远 false,所以必须传具体时间戳,不能给 null。
    try {
      const admin = getSupabaseAdmin();
      const { data: convStats, error: convErr } = await admin.rpc('ad_conversation_stats', {
        p_tenant_id: ctx.tenantId,
        from_ts: '1970-01-01T00:00:00Z',
        to_ts: new Date().toISOString(),
      });
      if (convErr) {
        console.warn('[ogilvy/sessions/metrics] ad_conversation_stats failed:', convErr.message);
      } else {
        for (const row of convStats || []) {
          const sessionId = adIdToSession.get(String(row.meta_ad_id || ''));
          if (!sessionId) continue;
          const count = Number(row.conversation_count) || 0;
          const m = metrics[sessionId];
          m.conversations += count;
          m.has_data = m.has_data || count > 0;
        }
      }
    } catch (err) {
      console.warn('[ogilvy/sessions/metrics] conversation stats error:', err.message);
    }

    for (const id of Object.keys(metrics)) {
      metrics[id].spend = toNumber(metrics[id].spend);
    }

    const payload = { metrics, fetched_at: new Date().toISOString() };
    try {
      const redis = getRedis();
      await redis.set(cacheKey, JSON.stringify(payload), 'EX', CACHE_TTL_SECONDS);
    } catch { /* ignore */ }

    return NextResponse.json(payload);
  } catch (err) {
    console.error('[ogilvy/sessions/metrics GET]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function emptyMetrics() {
  return { impressions: 0, clicks: 0, conversations: 0, spend: 0, has_data: false };
}
