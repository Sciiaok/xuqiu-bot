/**
 * GET /api/ogilvy/sessions/metrics
 *
 * 一次性返回当前用户所有 Ogilvy session 的 Meta 投放数据(展示 / 点击 / 对话 / 花费)。
 *
 * 卡片网格 UI 一次拿全，避免每张卡分别打 Meta 一次。Meta 是慢调用 (5~20s)，
 * 这里走 Redis 缓存 5 分钟。逻辑：
 *
 *   1. 拉用户的所有 session，收集 plan_json.meta_ad_ids（最准，避免再走一次
 *      /ads?filtering=campaign.id IN 查 ad_id 的回环）。
 *   2. 用 Meta insights（time_range = 全周期，37 月封顶）一次性按 ad_id 拉数。
 *   3. 把每条 ad 的 spend/impressions/clicks/conversations 归并到所属 session。
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
import { getRedis } from '../../../../../lib/redis.js';
import { listSessions } from '../../../../../lib/repositories/ogilvy.repository.js';
import {
  fetchAllPages,
  META_API_VERSION,
} from '../../../../../src/meta-ads.service.js';

const CACHE_TTL_SECONDS = 5 * 60;
const MESSAGING_CONVERSATION_ACTION = 'onsite_conversion.messaging_conversation_started';
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

function extractConversations(actions) {
  if (!Array.isArray(actions)) return 0;
  return actions.reduce((total, action) => {
    if (action?.action_type !== MESSAGING_CONVERSATION_ACTION) return total;
    return total + toInt(action.value);
  }, 0);
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
    fields: 'ad_id,spend,impressions,clicks,actions',
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
        m.conversations += extractConversations(row.actions);
        m.has_data = m.has_data || (m.impressions > 0 || m.clicks > 0 || m.spend > 0);
      }
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
