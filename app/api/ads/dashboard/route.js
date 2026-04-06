import { NextResponse } from 'next/server';
import { ProxyAgent } from 'undici';
import { demoGuard } from '../../../../lib/demo-mode.js';
import { createClient } from '../../../../lib/supabase-server.js';

const META_API_VERSION = 'v21.0';
const META_API_TIMEOUT_MS = 30_000;
const META_PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
const META_PROXY_AGENT = META_PROXY_URL ? new ProxyAgent(META_PROXY_URL) : null;
const STATUS_ACTIVE = 'ACTIVE';
const DEFAULT_LOOKBACK_DAYS = 30;
const MAX_PAGE_SIZE = 1000;
const CONVERSATION_CHUNK_SIZE = 50;
const META_IMAGE_HASH_CHUNK_SIZE = 40;
const META_VIDEO_ID_CHUNK_SIZE = 25;

const PRODUCT_LINE_LABELS = {
  all: '全部',
  vehicle: '整车',
  auto_parts: '汽配',
  agri_machinery: '农机',
  unclassified: '未分类',
};

const QUALITY_RANK = {
  BAD: 1,
  GOOD: 2,
  QUALIFY: 3,
  PROOF: 4,
};
const META_LIFETIME_LOOKBACK_MONTHS = 36;
const DASHBOARD_CACHE_TTL_MS = 60_000;
const dashboardCache = new Map();

const NAME_RULES = [
  {
    productLine: 'agri_machinery',
    keywords: ['农业机械', '农机', 'tractor', 'harvester', 'agri', 'farm', 'model2004e'],
  },
  {
    productLine: 'auto_parts',
    keywords: ['汽车配件', '汽配', 'auto parts', 'autoparts', 'brake', 'dp-brake', 'parts'],
  },
  {
    productLine: 'vehicle',
    keywords: ['整车', 'vehicle', '新能源汽车', 'byd', 'tai7', 'sedan', 'suv', 'pickup', 'ev'],
  },
];

function parseProductLine(searchParams) {
  const value = String(searchParams.get('productLine') || 'all').trim();
  return PRODUCT_LINE_LABELS[value] ? value : 'all';
}

function parseDateRange(searchParams) {
  const preset = String(searchParams.get('preset') || '').trim();
  const startDate = String(searchParams.get('startDate') || '').trim();
  const endDate = String(searchParams.get('endDate') || '').trim();
  const explicitDays = parseInt(searchParams.get('days') || '', 10);
  const now = new Date();

  let fromDate;
  let toDate;
  let effectivePreset = preset || '30d';
  let days;

  if (startDate && endDate) {
    fromDate = new Date(`${startDate}T00:00:00.000Z`);
    toDate = new Date(`${endDate}T23:59:59.999Z`);
    effectivePreset = 'custom';
    days = Math.max(1, Math.round((toDate - fromDate) / 86400000) + 1);
  } else {
    switch (preset) {
      case 'today':
        days = 1;
        break;
      case 'yesterday':
        days = 1;
        now.setUTCDate(now.getUTCDate() - 1);
        break;
      case '7d':
        days = 7;
        break;
      case '30d':
        days = 30;
        break;
      default:
        days = Number.isFinite(explicitDays) && explicitDays > 0 ? explicitDays : DEFAULT_LOOKBACK_DAYS;
        effectivePreset = `${days}d`;
        break;
    }

    toDate = new Date(now);
    toDate.setUTCHours(23, 59, 59, 999);
    fromDate = new Date(toDate);
    fromDate.setUTCDate(fromDate.getUTCDate() - days + 1);
    fromDate.setUTCHours(0, 0, 0, 0);
  }

  return {
    preset: effectivePreset,
    days,
    fromDate,
    toDate,
    fromISO: fromDate.toISOString(),
    toISO: toDate.toISOString(),
    isSingleDay: fromDate.toISOString().slice(0, 10) === toDate.toISOString().slice(0, 10),
  };
}

function createEmptyMetaMetrics() {
  return {
    spend: 0,
    impressions: 0,
    clicks: 0,
    ctr: 0,
    cpc: 0,
    cpm: 0,
  };
}

function createEmptyConversationMetrics() {
  return {
    waConversations: 0,
    qualifyConversations: 0,
    proofConversations: 0,
    qualifyRate: 0,
    proofRate: 0,
    cpa: 0,
    lastConversationAt: null,
    daily: [],
  };
}

function createEmptyStatBlock() {
  return {
    ...createEmptyMetaMetrics(),
    ...createEmptyConversationMetrics(),
  };
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

function formatDateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function normalizeAdAccountId(value) {
  return String(value || '').replace(/^act_/, '').trim();
}

function buildInsightsUrl({ adAccountId, accessToken, adIds, timeRange, timeIncrement }) {
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: 'ad_id,ad_name,spend,impressions,clicks,ctr,cpc,cpm',
    level: 'ad',
    time_range: JSON.stringify(timeRange),
    limit: '500',
  });

  if (timeIncrement) {
    params.set('time_increment', String(timeIncrement));
  }

  if (adIds?.length) {
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

function buildAdsUrl({ adAccountId, accessToken, adIds, fields }) {
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: fields || 'id,name,effective_status,configured_status,campaign{id,name},adset{id,name},creative{thumbnail_url}',
    limit: '500',
  });

  if (adIds?.length) {
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

  return `https://graph.facebook.com/${META_API_VERSION}/act_${adAccountId}/ads?${params.toString()}`;
}

function buildAdImagesUrl({ adAccountId, accessToken, hashes }) {
  const params = new URLSearchParams({
    access_token: accessToken,
    fields: 'hash,url,permalink_url,width,height,original_width,original_height',
    hashes: JSON.stringify(hashes),
  });

  return `https://graph.facebook.com/${META_API_VERSION}/act_${adAccountId}/adimages?${params.toString()}`;
}

function buildVideoLookupUrl({ accessToken, videoIds }) {
  const params = new URLSearchParams({
    access_token: accessToken,
    ids: videoIds.join(','),
    fields: 'thumbnails,picture,length,title',
  });

  return `https://graph.facebook.com/${META_API_VERSION}/?${params.toString()}`;
}

async function fetchAllPages(url) {
  const rows = [];
  let nextUrl = url;

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(META_API_TIMEOUT_MS),
      dispatcher: META_PROXY_AGENT || undefined,
    });

    const data = await response.json();

    if (!response.ok || data?.error) {
      throw new Error(data?.error?.message || `Meta API request failed with status ${response.status}`);
    }

    rows.push(...(data.data || []));
    nextUrl = data.paging?.next || null;
  }

  return rows;
}

async function fetchMetaAds({ adAccountId, accessToken, adIds, fields }) {
  return fetchAllPages(buildAdsUrl({ adAccountId, accessToken, adIds, fields }));
}

async function fetchMetaInsights({ adAccountId, accessToken, adIds, timeRange, timeIncrement }) {
  return fetchAllPages(buildInsightsUrl({ adAccountId, accessToken, adIds, timeRange, timeIncrement }));
}

async function fetchMetaAdImages({ adAccountId, accessToken, hashes }) {
  if (!hashes?.length) return [];

  const rows = [];
  for (const chunk of chunkArray(hashes, META_IMAGE_HASH_CHUNK_SIZE)) {
    const data = await fetchAllPages(buildAdImagesUrl({ adAccountId, accessToken, hashes: chunk }));
    rows.push(...data);
  }

  return rows;
}

async function fetchMetaVideoAssets({ accessToken, videoIds }) {
  if (!videoIds?.length) return new Map();

  const result = new Map();
  for (const chunk of chunkArray(videoIds, META_VIDEO_ID_CHUNK_SIZE)) {
    const response = await fetch(buildVideoLookupUrl({ accessToken, videoIds: chunk }), {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(META_API_TIMEOUT_MS),
      dispatcher: META_PROXY_AGENT || undefined,
    });

    const data = await response.json();
    if (!response.ok || data?.error) {
      throw new Error(data?.error?.message || `Meta API request failed with status ${response.status}`);
    }

    for (const [videoId, payload] of Object.entries(data || {})) {
      if (!payload || typeof payload !== 'object') continue;
      result.set(videoId, payload);
    }
  }

  return result;
}

function isMetaPermissionError(error) {
  return /does not have permission/i.test(String(error?.message || ''));
}

function isMetaRateLimitError(error) {
  return /too many calls|rate.limit|rate-limiting|user request limit reached/i.test(String(error?.message || ''));
}

function getDashboardCacheKey({ userId, range, productLine }) {
  return JSON.stringify({
    userId,
    preset: range.preset,
    from: range.fromISO,
    to: range.toISO,
    productLine,
  });
}

function getCachedDashboard(cacheKey) {
  const cached = dashboardCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > DASHBOARD_CACHE_TTL_MS) return null;
  return cached.payload;
}

function setCachedDashboard(cacheKey, payload) {
  dashboardCache.set(cacheKey, {
    createdAt: Date.now(),
    payload,
  });
}

function buildMetaMetricsMap(rows) {
  const metricsMap = new Map();
  for (const row of rows || []) {
    const adId = String(row.ad_id || '').trim();
    if (!adId) continue;
    metricsMap.set(adId, {
      spend: toNumber(row.spend),
      impressions: toInteger(row.impressions),
      clicks: toInteger(row.clicks),
      ctr: toNumber(row.ctr),
      cpc: toNumber(row.cpc),
      cpm: toNumber(row.cpm),
    });
  }
  return metricsMap;
}

function buildDailyMetaMap(rows) {
  const metricsMap = new Map();
  for (const row of rows || []) {
    const adId = String(row.ad_id || '').trim();
    const date = row.date_start ? String(row.date_start).slice(0, 10) : null;
    if (!adId || !date) continue;

    if (!metricsMap.has(adId)) metricsMap.set(adId, new Map());
    metricsMap.get(adId).set(date, {
      date,
      spend: toNumber(row.spend),
      impressions: toInteger(row.impressions),
      clicks: toInteger(row.clicks),
      ctr: toNumber(row.ctr),
      cpc: toNumber(row.cpc),
      cpm: toNumber(row.cpm),
    });
  }
  return metricsMap;
}

function extractCreativeImageHash(creative) {
  const linkData = creative?.object_story_spec?.link_data;
  if (linkData?.image_hash) return linkData.image_hash;

  const attachments = Array.isArray(linkData?.child_attachments) ? linkData.child_attachments : [];
  const firstWithHash = attachments.find((item) => item?.image_hash);
  if (firstWithHash?.image_hash) return firstWithHash.image_hash;

  const assetImages = Array.isArray(creative?.asset_feed_spec?.images) ? creative.asset_feed_spec.images : [];
  const firstAssetImage = assetImages.find((item) => item?.hash);
  return firstAssetImage?.hash || null;
}

function extractCreativeVideoId(creative) {
  if (creative?.video_id) return creative.video_id;
  if (creative?.object_story_spec?.video_data?.video_id) return creative.object_story_spec.video_data.video_id;

  const videos = Array.isArray(creative?.asset_feed_spec?.videos) ? creative.asset_feed_spec.videos : [];
  const firstVideo = videos.find((item) => item?.video_id);
  return firstVideo?.video_id || null;
}

function getPreferredVideoThumbnail(videoPayload) {
  const thumbnails = Array.isArray(videoPayload?.thumbnails?.data) ? videoPayload.thumbnails.data : [];
  const preferred = thumbnails.find((item) => item?.is_preferred && item?.uri);
  if (preferred) {
    return {
      url: preferred.uri,
      width: preferred.width,
      height: preferred.height,
    };
  }

  const first = thumbnails.find((item) => item?.uri);
  if (first) {
    return {
      url: first.uri,
      width: first.width,
      height: first.height,
    };
  }

  if (videoPayload?.picture) {
    return {
      url: videoPayload.picture,
      width: 0,
      height: 0,
    };
  }

  return null;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function fetchConversationRows({ supabase, adIds, fromISO, toISO }) {
  if (!adIds.length) return [];

  const allRows = [];
  for (const chunk of chunkArray(adIds, CONVERSATION_CHUNK_SIZE)) {
    let from = 0;
    while (true) {
      let query = supabase
        .from('conversations')
        .select('id, meta_ad_id, created_at, agent_id, leads(inquiry_quality)')
        .in('meta_ad_id', chunk)
        .order('created_at', { ascending: false })
        .range(from, from + MAX_PAGE_SIZE - 1);

      if (fromISO) query = query.gte('created_at', fromISO);
      if (toISO) query = query.lte('created_at', toISO);

      const { data, error } = await query;
      if (error) throw error;

      const rows = data || [];
      allRows.push(...rows);
      if (rows.length < MAX_PAGE_SIZE) break;
      from += MAX_PAGE_SIZE;
    }
  }

  return allRows;
}

async function fetchConversationSummaryByAd({ supabase, fromISO, toISO }) {
  const { data, error } = await supabase.rpc('ad_conversation_stats', {
    from_ts: fromISO,
    to_ts: toISO,
  });

  if (error) throw error;
  return data || [];
}

async function fetchAgentsMap({ supabase }) {
  const { data, error } = await supabase.from('agents').select('id, product_line');
  if (error) throw error;

  const map = new Map();
  for (const agent of data || []) {
    if (agent?.id) map.set(agent.id, agent.product_line || 'unclassified');
  }
  return map;
}

function normalizeQuality(value) {
  const quality = String(value || '').toUpperCase().trim();
  return QUALITY_RANK[quality] ? quality : null;
}

function resolveFinalQuality(leads) {
  let bestQuality = null;
  let bestRank = 0;

  for (const lead of leads || []) {
    const quality = normalizeQuality(lead.inquiry_quality);
    if (!quality) continue;
    const rank = QUALITY_RANK[quality] || 0;
    if (rank > bestRank) {
      bestRank = rank;
      bestQuality = quality;
    }
  }

  return bestQuality;
}

function ensureAggStats(map, adId) {
  if (!map.has(adId)) {
    map.set(adId, {
      waConversations: 0,
      qualifyConversations: 0,
      proofConversations: 0,
      lastConversationAt: null,
      dailyMap: new Map(),
    });
  }
  return map.get(adId);
}

function ensureDailyBucket(stats, date) {
  if (!stats.dailyMap.has(date)) {
    stats.dailyMap.set(date, {
      date,
      waConversations: 0,
      qualifyConversations: 0,
      proofConversations: 0,
    });
  }
  return stats.dailyMap.get(date);
}

function aggregateConversationMetrics({ conversations, agentMap }) {
  const statsByAd = new Map();
  const lineCountsByAd = new Map();

  for (const row of conversations || []) {
    const adId = String(row.meta_ad_id || '').trim();
    if (!adId) continue;

    const stats = ensureAggStats(statsByAd, adId);
    const date = formatDateKey(row.created_at);
    const daily = ensureDailyBucket(stats, date);
    const finalQuality = resolveFinalQuality(row.leads || []);

    stats.waConversations += 1;
    daily.waConversations += 1;

    if (finalQuality === 'QUALIFY') {
      stats.qualifyConversations += 1;
      daily.qualifyConversations += 1;
    } else if (finalQuality === 'PROOF') {
      stats.proofConversations += 1;
      daily.proofConversations += 1;
    }

    if (!stats.lastConversationAt || row.created_at > stats.lastConversationAt) {
      stats.lastConversationAt = row.created_at;
    }

    const line = agentMap.get(row.agent_id) || 'unknown';
    if (!lineCountsByAd.has(adId)) lineCountsByAd.set(adId, new Map());
    const lineMap = lineCountsByAd.get(adId);
    lineMap.set(line, (lineMap.get(line) || 0) + 1);
  }

  const normalizedStats = new Map();
  for (const [adId, stats] of statsByAd.entries()) {
    const daily = Array.from(stats.dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    normalizedStats.set(adId, {
      waConversations: stats.waConversations,
      qualifyConversations: stats.qualifyConversations,
      proofConversations: stats.proofConversations,
      qualifyRate: stats.waConversations > 0 ? Math.round((stats.qualifyConversations / stats.waConversations) * 100) : 0,
      proofRate: stats.waConversations > 0 ? Math.round((stats.proofConversations / stats.waConversations) * 100) : 0,
      lastConversationAt: stats.lastConversationAt,
      daily,
    });
  }

  return { statsByAd: normalizedStats, lineCountsByAd };
}

function classifyByName(ad) {
  const haystack = [
    ad.adsetName || '',
    ad.adName || '',
    ad.campaignName || '',
  ].join(' ').toLowerCase();

  const matches = new Set();
  for (const rule of NAME_RULES) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
      matches.add(rule.productLine);
    }
  }

  return matches.size === 1 ? Array.from(matches)[0] : null;
}

function resolveBusinessLine({ ad, lineCounts }) {
  const nonUnknown = Array.from((lineCounts || new Map()).entries())
    .filter(([line, count]) => line && line !== 'unknown' && count > 0)
    .sort((a, b) => b[1] - a[1]);

  if (nonUnknown.length === 1) {
    return { businessLine: nonUnknown[0][0], source: 'attribution' };
  }

  if (nonUnknown.length > 1) {
    return { businessLine: 'unclassified', source: 'attribution_conflict' };
  }

  const byName = classifyByName(ad);
  if (byName) {
    return { businessLine: byName, source: 'naming' };
  }

  return { businessLine: 'unclassified', source: 'unclassified' };
}

function mergeStats(metaMetrics, conversationMetrics) {
  const spend = toNumber(metaMetrics?.spend);
  const impressions = toInteger(metaMetrics?.impressions);
  const clicks = toInteger(metaMetrics?.clicks);
  const ctr = impressions > 0 ? toNumber((clicks / impressions) * 100) : toNumber(metaMetrics?.ctr);
  const cpc = clicks > 0 ? toNumber(spend / clicks) : toNumber(metaMetrics?.cpc);
  const cpm = impressions > 0 ? toNumber((spend / impressions) * 1000) : toNumber(metaMetrics?.cpm);
  const waConversations = toInteger(conversationMetrics?.waConversations);
  const qualifyConversations = toInteger(conversationMetrics?.qualifyConversations);
  const proofConversations = toInteger(conversationMetrics?.proofConversations);
  const qualifyRate = waConversations > 0 ? Math.round((qualifyConversations / waConversations) * 100) : 0;
  const proofRate = waConversations > 0 ? Math.round((proofConversations / waConversations) * 100) : 0;

  return {
    spend,
    impressions,
    clicks,
    ctr,
    cpc,
    cpm,
    waConversations,
    qualifyConversations,
    proofConversations,
    qualifyRate,
    proofRate,
    cpa: waConversations > 0 ? toNumber(spend / waConversations) : 0,
    lastConversationAt: conversationMetrics?.lastConversationAt || null,
    daily: conversationMetrics?.daily || [],
  };
}

function buildMetaLifetimeSince(untilISO) {
  const untilDate = new Date(untilISO);
  const sinceDate = new Date(untilDate);
  sinceDate.setUTCMonth(sinceDate.getUTCMonth() - META_LIFETIME_LOOKBACK_MONTHS);
  return sinceDate.toISOString().slice(0, 10);
}

function buildPeriodDaily({ metaDailyMap, conversationDaily }) {
  const dateMap = new Map();

  for (const [date, meta] of metaDailyMap?.entries() || []) {
    dateMap.set(date, {
      date,
      spend: toNumber(meta.spend),
      impressions: toInteger(meta.impressions),
      clicks: toInteger(meta.clicks),
      ctr: toNumber(meta.ctr),
      waConversations: 0,
      qualifyConversations: 0,
      proofConversations: 0,
    });
  }

  for (const item of conversationDaily || []) {
    if (!dateMap.has(item.date)) {
      dateMap.set(item.date, {
        date: item.date,
        spend: 0,
        impressions: 0,
        clicks: 0,
        ctr: 0,
        waConversations: 0,
        qualifyConversations: 0,
        proofConversations: 0,
      });
    }
    const bucket = dateMap.get(item.date);
    bucket.waConversations = toInteger(item.waConversations);
    bucket.qualifyConversations = toInteger(item.qualifyConversations);
    bucket.proofConversations = toInteger(item.proofConversations);
  }

  return Array.from(dateMap.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((item) => ({
      ...item,
      qualifyRate: item.waConversations > 0 ? Math.round((item.qualifyConversations / item.waConversations) * 100) : 0,
      proofRate: item.waConversations > 0 ? Math.round((item.proofConversations / item.waConversations) * 100) : 0,
      cpa: item.waConversations > 0 ? toNumber(item.spend / item.waConversations) : 0,
    }));
}

function buildSummary(ads) {
  const summary = {
    spend: 0,
    impressions: 0,
    clicks: 0,
    waConversations: 0,
    qualifyConversations: 0,
    proofConversations: 0,
    totalAds: ads.length,
    activeAds: 0,
    endedAds: 0,
  };

  for (const ad of ads) {
    const period = ad.period || createEmptyStatBlock();
    summary.spend += period.spend;
    summary.impressions += period.impressions;
    summary.clicks += period.clicks;
    summary.waConversations += period.waConversations;
    summary.qualifyConversations += period.qualifyConversations;
    summary.proofConversations += period.proofConversations;

    if (ad.status === 'active') summary.activeAds += 1;
    else summary.endedAds += 1;
  }

  summary.spend = toNumber(summary.spend);
  summary.ctr = summary.impressions > 0 ? toNumber((summary.clicks / summary.impressions) * 100) : 0;
  summary.cpa = summary.waConversations > 0 ? toNumber(summary.spend / summary.waConversations) : 0;
  summary.qualifyRate = summary.waConversations > 0 ? Math.round((summary.qualifyConversations / summary.waConversations) * 100) : 0;
  summary.proofRate = summary.waConversations > 0 ? Math.round((summary.proofConversations / summary.waConversations) * 100) : 0;
  return summary;
}

function toStatus(meta) {
  const effectiveStatus = String(meta?.effective_status || '').toUpperCase();
  return effectiveStatus === STATUS_ACTIVE ? 'active' : 'ended';
}

export async function GET(request) {
  const demoResponse = demoGuard({
    range: null,
    summary: null,
    ads: [],
    warning: 'Demo mode - ad dashboard unavailable',
  });
  if (demoResponse) return demoResponse;

  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const range = parseDateRange(searchParams);
    const productLine = parseProductLine(searchParams);
    const adAccountId = normalizeAdAccountId(process.env.META_AD_ACCOUNT_ID);
    const accessToken = process.env.META_SYSTEM_TOKEN || process.env.META_ACCESS_TOKEN;

    if (!accessToken) {
      return NextResponse.json({ error: 'META_SYSTEM_TOKEN / META_ACCESS_TOKEN is not configured' }, { status: 500 });
    }

    if (!adAccountId) {
      return NextResponse.json({ error: 'META_AD_ACCOUNT_ID is not configured' }, { status: 500 });
    }

    const cacheKey = getDashboardCacheKey({
      userId: user.id,
      range,
      productLine,
    });
    const cachedPayload = getCachedDashboard(cacheKey);
    if (cachedPayload) {
      return NextResponse.json(cachedPayload);
    }

    let metaRateLimited = false;
    const agentsMap = await fetchAgentsMap({ supabase });
    let metaAds = [];
    try {
      metaAds = await fetchMetaAds({ adAccountId, accessToken });
    } catch (error) {
      if (isMetaRateLimitError(error)) {
        metaRateLimited = true;
        console.warn('Meta ads listing rate limited for ad dashboard, continuing with conversation-only data');
      } else {
        throw error;
      }
    }

    const adsById = new Map();
    for (const ad of metaAds || []) {
      const adId = String(ad.id || '').trim();
      if (!adId) continue;
      adsById.set(adId, {
        adId,
        adName: ad.name || '',
        adsetName: ad.adset?.name || '',
        campaignName: ad.campaign?.name || '',
        creativeThumbnailUrl: ad.creative?.thumbnail_url || '',
        effectiveStatus: ad.effective_status || 'UNKNOWN',
        configuredStatus: ad.configured_status || 'UNKNOWN',
        status: toStatus(ad),
      });
    }

    const metaLifetimeSince = buildMetaLifetimeSince(range.toISO);

    const periodConversationSummary = await fetchConversationSummaryByAd({
      supabase,
      fromISO: range.fromISO,
      toISO: range.toISO,
    });

    let lifetimeInsightRows = [];
    let periodInsightRows = [];
    let dailyInsightRows = [];
    try {
      [lifetimeInsightRows, periodInsightRows, dailyInsightRows] = await Promise.all([
        fetchMetaInsights({
          adAccountId,
          accessToken,
          timeRange: { since: metaLifetimeSince, until: range.toISO.slice(0, 10) },
        }),
        fetchMetaInsights({
          adAccountId,
          accessToken,
          timeRange: { since: range.fromISO.slice(0, 10), until: range.toISO.slice(0, 10) },
        }),
        fetchMetaInsights({
          adAccountId,
          accessToken,
          timeRange: { since: range.fromISO.slice(0, 10), until: range.toISO.slice(0, 10) },
          timeIncrement: 1,
        }),
      ]);
    } catch (error) {
      if (isMetaRateLimitError(error)) {
        metaRateLimited = true;
        console.warn('Meta insights rate limited for ad dashboard, continuing with conversation-only data');
      } else {
        throw error;
      }
    }

    const lifetimeMetaMap = buildMetaMetricsMap(lifetimeInsightRows);
    const periodMetaMap = buildMetaMetricsMap(periodInsightRows);
    const periodDailyMetaMap = buildDailyMetaMap(dailyInsightRows);

    const candidateAdIds = new Set();
    for (const [adId, ad] of adsById.entries()) {
      if (ad.status === 'active') candidateAdIds.add(adId);
    }
    for (const adId of lifetimeMetaMap.keys()) candidateAdIds.add(adId);
    for (const adId of periodMetaMap.keys()) candidateAdIds.add(adId);
    for (const row of periodConversationSummary) {
      const adId = String(row.meta_ad_id || '').trim();
      if (adId) candidateAdIds.add(adId);
    }

    const candidateIds = Array.from(candidateAdIds);

    const [lifetimeConversations, periodConversations] = await Promise.all([
      fetchConversationRows({
        supabase,
        adIds: candidateIds,
      }),
      fetchConversationRows({
        supabase,
        adIds: candidateIds,
        fromISO: range.fromISO,
        toISO: range.toISO,
      }),
    ]);

    const previewByAdId = new Map();
    try {
      const candidateCreatives = await fetchMetaAds({
        adAccountId,
        accessToken,
        adIds: candidateIds,
        fields: 'id,creative{thumbnail_url,video_id,object_story_spec,asset_feed_spec}',
      });

      const previewHashes = Array.from(new Set(
        candidateCreatives
          .map((ad) => extractCreativeImageHash(ad.creative))
          .filter(Boolean)
      ));
      const previewVideoIds = Array.from(new Set(
        candidateCreatives
          .map((ad) => extractCreativeVideoId(ad.creative))
          .filter(Boolean)
      ));

      let previewImages = [];
      try {
        previewImages = await fetchMetaAdImages({
          adAccountId,
          accessToken,
          hashes: previewHashes,
        });
      } catch (error) {
        console.warn('Skipping Meta ad image enrichment:', error?.message || error);
      }

      let previewVideos = new Map();
      try {
        previewVideos = await fetchMetaVideoAssets({
          accessToken,
          videoIds: previewVideoIds,
        });
      } catch (error) {
        if (isMetaPermissionError(error)) {
          console.warn('Skipping Meta video thumbnail enrichment due to permission:', error?.message || error);
        } else {
          console.warn('Skipping Meta video thumbnail enrichment:', error?.message || error);
        }
      }

      const previewImageMap = new Map(
        previewImages.map((item) => [item.hash, item])
      );

      for (const ad of candidateCreatives || []) {
        const adId = String(ad.id || '').trim();
        if (!adId) continue;
        const hash = extractCreativeImageHash(ad.creative);
        const videoId = extractCreativeVideoId(ad.creative);
        const image = hash ? previewImageMap.get(hash) : null;
        const video = videoId ? getPreferredVideoThumbnail(previewVideos.get(String(videoId))) : null;
        const resolvedUrl = image?.url || video?.url || ad.creative?.thumbnail_url || '';
        const resolvedWidth = image ? toInteger(image.width) : toInteger(video?.width);
        const resolvedHeight = image ? toInteger(image.height) : toInteger(video?.height);
        const originalWidth = image ? toInteger(image.original_width) : toInteger(video?.width);
        const originalHeight = image ? toInteger(image.original_height) : toInteger(video?.height);
        previewByAdId.set(adId, {
          creativePreviewUrl: resolvedUrl,
          creativePreviewPermalinkUrl: image?.permalink_url || '',
          creativePreviewWidth: resolvedWidth,
          creativePreviewHeight: resolvedHeight,
          creativeOriginalWidth: originalWidth,
          creativeOriginalHeight: originalHeight,
        });
      }
    } catch (error) {
      console.warn('Skipping creative preview enrichment for ad dashboard:', error?.message || error);
    }

    const lifetimeConvAgg = aggregateConversationMetrics({
      conversations: lifetimeConversations,
      agentMap: agentsMap,
    });
    const periodConvAgg = aggregateConversationMetrics({
      conversations: periodConversations,
      agentMap: agentsMap,
    });

    const relevantAdIds = new Set(candidateAdIds);
    for (const adId of lifetimeConvAgg.statsByAd.keys()) relevantAdIds.add(adId);

    const ads = Array.from(relevantAdIds)
      .map((adId) => {
        const meta = adsById.get(adId) || {
          adId,
          adName: '',
          adsetName: '',
          campaignName: '',
          creativeThumbnailUrl: '',
          effectiveStatus: 'UNKNOWN',
          configuredStatus: 'UNKNOWN',
          status: 'ended',
        };
        const lineCounts = lifetimeConvAgg.lineCountsByAd.get(adId) || new Map();
        const classification = resolveBusinessLine({ ad: meta, lineCounts });
        const lifetime = mergeStats(
          lifetimeMetaMap.get(adId) || createEmptyMetaMetrics(),
          lifetimeConvAgg.statsByAd.get(adId) || createEmptyConversationMetrics()
        );
        const periodBase = mergeStats(
          periodMetaMap.get(adId) || createEmptyMetaMetrics(),
          periodConvAgg.statsByAd.get(adId) || createEmptyConversationMetrics()
        );

        return {
          ...meta,
          ...(previewByAdId.get(adId) || {
            creativePreviewUrl: '',
            creativePreviewPermalinkUrl: '',
            creativePreviewWidth: 0,
            creativePreviewHeight: 0,
            creativeOriginalWidth: 0,
            creativeOriginalHeight: 0,
          }),
          businessLine: classification.businessLine,
          businessLineLabel: PRODUCT_LINE_LABELS[classification.businessLine] || PRODUCT_LINE_LABELS.unclassified,
          classificationSource: classification.source,
          lifetime,
          period: {
            ...periodBase,
            daily: buildPeriodDaily({
              metaDailyMap: periodDailyMetaMap.get(adId),
              conversationDaily: periodConvAgg.statsByAd.get(adId)?.daily || [],
            }),
          },
        };
      })
      .filter((ad) => {
        const hasLifetimeData = ad.lifetime.spend > 0 || ad.lifetime.waConversations > 0;
        return ad.status === 'active' || hasLifetimeData;
      });

    const filteredAds = ads
      .filter((ad) => productLine === 'all' || ad.businessLine === productLine)
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
        if (b.period.spend !== a.period.spend) return b.period.spend - a.period.spend;
        if (b.period.waConversations !== a.period.waConversations) return b.period.waConversations - a.period.waConversations;
        return a.adId.localeCompare(b.adId);
      });

    const payload = {
      range: {
        preset: range.preset,
        days: range.days,
        from: range.fromISO,
        to: range.toISO,
        isSingleDay: range.isSingleDay,
      },
      filter: {
        productLine,
      },
      warning: metaRateLimited ? 'Meta metrics temporarily unavailable due to rate limiting' : null,
      summary: buildSummary(filteredAds),
      ads: filteredAds,
    };
    setCachedDashboard(cacheKey, payload);
    return NextResponse.json(payload);
  } catch (error) {
    console.error('Error building ad dashboard:', error);
    try {
      const { searchParams } = new URL(request.url);
      const range = parseDateRange(searchParams);
      const productLine = parseProductLine(searchParams);
      const supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (user && isMetaRateLimitError(error)) {
        const cacheKey = getDashboardCacheKey({
          userId: user.id,
          range,
          productLine,
        });
        const cachedPayload = getCachedDashboard(cacheKey);
        if (cachedPayload) {
          console.warn('Returning cached ad dashboard after Meta rate limit');
          return NextResponse.json(cachedPayload);
        }
      }
    } catch (cacheError) {
      console.warn('Unable to evaluate cached ad dashboard fallback:', cacheError?.message || cacheError);
    }
    return NextResponse.json(
      { error: error.message || 'Failed to build ad dashboard' },
      { status: 500 }
    );
  }
}
