import { NextResponse } from 'next/server';
import { ProxyAgent } from 'undici';
import { demoGuard } from '../../../../lib/demo-mode.js';
import { createClient } from '../../../../lib/supabase-server.js';
import { config } from '../../../../src/config.js';
import { getRedis } from '../../../../lib/redis.js';

const META_API_VERSION = 'v21.0';
const META_API_TIMEOUT_MS = config.meta.apiTimeoutMs;
const CACHE_TTL_SECONDS = 10 * 60; // 10 minutes
const MESSAGING_CONVERSATION_ACTION = 'onsite_conversion.messaging_conversation_started';
const META_PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const META_PROXY_AGENT = META_PROXY_URL ? new ProxyAgent(META_PROXY_URL) : null;

function createEmptyTotals() {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    avgCtr: 0,
    avgCpc: 0,
  };
}

function parseDays(searchParams) {
  const parsedDays = parseInt(searchParams.get('days') || '30', 10);
  return Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 30;
}

function parseAdIds(searchParams) {
  return Array.from(
    new Set(
      (searchParams.get('adIds') || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

// Meta Ads API caps time_range at 37 months (~1100 days).
const META_MAX_DAYS = 1100;

function buildTimeRange(days, { startDate, endDate } = {}) {
  if (startDate && endDate) {
    return { since: startDate, until: endDate };
  }
  const capped = Math.min(days, META_MAX_DAYS);
  const until = new Date();
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - capped + 1);
  return { since: formatDate(since), until: formatDate(until) };
}

function normalizeAdAccountId(value) {
  return String(value || '').replace(/^act_/, '').trim();
}

function toNumber(value, decimals = 2) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed)) return 0;
  return Number(parsed.toFixed(decimals));
}

function toInteger(value) {
  const parsed = parseInt(value || '0', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function extractConversations(actions) {
  if (!Array.isArray(actions)) return 0;

  return actions.reduce((total, action) => {
    if (action?.action_type !== MESSAGING_CONVERSATION_ACTION) {
      return total;
    }

    return total + toInteger(action.value);
  }, 0);
}

function buildInsightsUrl({ adAccountId, accessToken, days, adIds, timeIncrement, startDate, endDate }) {
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: 'ad_id,ad_name,spend,impressions,clicks,ctr,cpc,cpm,actions',
    level: 'ad',
    time_range: JSON.stringify(buildTimeRange(days, { startDate, endDate })),
    limit: '500',
  });

  if (timeIncrement) {
    params.set('time_increment', String(timeIncrement));
  }

  if (adIds.length > 0) {
    params.set(
      'filtering',
      JSON.stringify([
        {
          field: 'ad.id',
          operator: 'IN',
          value: adIds,
        },
      ])
    );
  }

  return `https://graph.facebook.com/${META_API_VERSION}/act_${adAccountId}/insights?${params.toString()}`;
}

async function fetchMetaInsights({ adAccountId, accessToken, days, adIds, timeIncrement, startDate, endDate }) {
  const rows = [];
  let nextUrl = buildInsightsUrl({ adAccountId, accessToken, days, adIds, timeIncrement, startDate, endDate });

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(META_API_TIMEOUT_MS),
      dispatcher: META_PROXY_AGENT || undefined,
    });

    const data = await response.json();

    if (!response.ok || data?.error) {
      throw new Error(
        data?.error?.message || `Meta API request failed with status ${response.status}`
      );
    }

    rows.push(...(data.data || []));
    nextUrl = data.paging?.next || null;
  }

  return rows;
}

function buildMetrics(rows, adIds) {
  const metrics = rows
    .map((row) => ({
      adId: String(row.ad_id || '').trim(),
      adName: row.ad_name || '',
      spend: toNumber(row.spend),
      impressions: toInteger(row.impressions),
      clicks: toInteger(row.clicks),
      ctr: toNumber(row.ctr),
      cpc: toNumber(row.cpc),
      cpm: toNumber(row.cpm),
      conversations: extractConversations(row.actions),
    }))
    .filter((item) => item.adId)
    .filter((item) => adIds.length === 0 || adIds.includes(item.adId))
    .sort((a, b) => {
      if (b.spend !== a.spend) {
        return b.spend - a.spend;
      }
      return a.adId.localeCompare(b.adId);
    });

  const totals = metrics.reduce((acc, item) => {
    acc.spend += item.spend;
    acc.impressions += item.impressions;
    acc.clicks += item.clicks;
    return acc;
  }, createEmptyTotals());

  totals.spend = toNumber(totals.spend);
  totals.avgCtr = totals.impressions > 0
    ? toNumber((totals.clicks / totals.impressions) * 100)
    : 0;
  totals.avgCpc = totals.clicks > 0
    ? toNumber(totals.spend / totals.clicks)
    : 0;

  return { metrics, totals };
}

function buildCacheKey(days, adIds, startDate, endDate) {
  const idsPart = adIds.length > 0 ? adIds.sort().join(',') : 'all';
  const datePart = startDate && endDate ? `${startDate}_${endDate}` : `${days}d`;
  return `ads:metrics:${datePart}:${idsPart}`;
}

async function getFromCache(key) {
  try {
    const redis = getRedis();
    const cached = await redis.get(key);
    return cached ? JSON.parse(cached) : null;
  } catch { return null; }
}

async function setToCache(key, data) {
  try {
    const redis = getRedis();
    await redis.set(key, JSON.stringify(data), 'EX', CACHE_TTL_SECONDS);
  } catch {}
}

export async function GET(request) {
  const demoResponse = demoGuard({
    metrics: [],
    totals: createEmptyTotals(),
    warning: 'Demo mode - Meta ad metrics unavailable',
  });
  if (demoResponse) return demoResponse;

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const days = parseDays(searchParams);
    const adIds = parseAdIds(searchParams);
    const startDate = searchParams.get('startDate') || '';
    const endDate = searchParams.get('endDate') || '';
    const totalsOnly = searchParams.get('totalsOnly') === 'true';
    const adAccountId = normalizeAdAccountId(process.env.META_AD_ACCOUNT_ID);
    const accessToken = process.env.META_SYSTEM_TOKEN || process.env.META_ACCESS_TOKEN;

    // Redis cache — skip the 20s+ Meta API call when identical params hit recently
    const cacheKey = buildCacheKey(days, adIds, startDate, endDate);
    const cached = await getFromCache(cacheKey);
    if (cached) {
      if (totalsOnly) return NextResponse.json({ totals: cached.totals });
      return NextResponse.json(cached);
    }

    if (!accessToken) {
      return NextResponse.json({
        metrics: [],
        totals: createEmptyTotals(),
        warning: 'META_SYSTEM_TOKEN / META_ACCESS_TOKEN is not configured',
      });
    }

    if (!adAccountId) {
      return NextResponse.json({
        metrics: [],
        totals: createEmptyTotals(),
        warning: 'META_AD_ACCOUNT_ID is not configured',
      });
    }

    // Fetch aggregated metrics (full period)
    const rows = await fetchMetaInsights({
      adAccountId,
      accessToken,
      days,
      adIds,
      startDate,
      endDate,
    });

    const { metrics, totals } = buildMetrics(rows, adIds);

    // totalsOnly mode: analytics page only needs spend, skip the expensive daily call
    if (totalsOnly) {
      // Cache the aggregated result (without daily) so full callers also benefit
      setToCache(cacheKey, { metrics, totals, dailyMetrics: {} });
      return NextResponse.json({ totals });
    }

    // Fetch daily breakdown (time_increment=1) for per-day display
    const dailyRows = await fetchMetaInsights({
      adAccountId,
      accessToken,
      days,
      adIds,
      timeIncrement: 1,
      startDate,
      endDate,
    });

    // Build daily metrics keyed by date → adId → metrics
    const dailyMetrics = {};
    for (const row of dailyRows) {
      const adId = String(row.ad_id || '').trim();
      const date = row.date_start ? row.date_start.split('T')[0] : null;
      if (!adId || !date) continue;

      if (!dailyMetrics[date]) dailyMetrics[date] = {};
      dailyMetrics[date][adId] = {
        adId,
        spend: toNumber(row.spend),
        impressions: toInteger(row.impressions),
        clicks: toInteger(row.clicks),
        ctr: toNumber(row.ctr),
        conversations: extractConversations(row.actions),
      };
    }

    const result = { metrics, totals, dailyMetrics };
    setToCache(cacheKey, result);
    return NextResponse.json(result);
  } catch (error) {
    console.error('Error fetching ad metrics:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch ad metrics' },
      { status: 500 }
    );
  }
}
