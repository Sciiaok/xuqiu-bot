import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';
import { getTenantContext } from '../../../../lib/tenant-context.js';
import { generateSummaryWithFallback } from '../../../../lib/ai-summary.js';

const VALID_TYPES = new Set([
  'daily_report',
  'attribution',
  'market_insight',
  'campaign_analysis',
]);

const REPORT_PROMPTS = {
  daily_report: '你是B2B外贸数据分析师。根据以下数据生成简洁的中文日报分析。包含：关键指标变化、线索质量分布、值得关注的趋势、建议的行动项。',
  attribution: '你是广告归因分析专家。分析广告到线索的转化路径，识别高效广告、问题广告，给出优化建议。用中文回复。',
  market_insight: '你是国际市场分析师。分析各市场的询盘数据，识别热门市场、新兴机会和风险信号。用中文回复。',
  campaign_analysis: '你是数字营销策略师。综合分析广告投放效果，评估各广告的表现，提供全局优化策略建议。用中文回复。',
};

const QUALITY_KEYS = ['PROOF', 'QUALIFY', 'GOOD', 'BAD'];

function parseDays(value) {
  const parsed = Number.parseInt(String(value ?? '7'), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 7;
  return Math.min(parsed, 90);
}

function buildDateRange(days) {
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days + 1);
  fromDate.setHours(0, 0, 0, 0);
  return {
    fromDate,
    toDate,
    fromISO: fromDate.toISOString(),
    toISO: toDate.toISOString(),
  };
}

function toDateKey(value) {
  return value ? value.split('T')[0] : null;
}

function createDateSeries(fromDate, toDate, builder) {
  const series = [];
  const cursor = new Date(fromDate);

  while (cursor <= toDate) {
    const date = cursor.toISOString().split('T')[0];
    series.push(builder(date));
    cursor.setDate(cursor.getDate() + 1);
  }

  return series;
}

function countEntries(rows, getKey) {
  const counts = {};

  for (const row of rows || []) {
    const key = getKey(row);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }

  return counts;
}

function chunkValues(values, size = 200) {
  const chunks = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

function normalizeQuality(value) {
  const normalized = String(value || '').toUpperCase();
  return QUALITY_KEYS.includes(normalized) ? normalized : 'UNKNOWN';
}

function incrementMap(map, key, amount = 1) {
  map.set(key, (map.get(key) || 0) + amount);
}

function mapToSortedEntries(map, keyName = 'name', valueName = 'count') {
  return Array.from(map.entries())
    .map(([key, value]) => ({ [keyName]: key, [valueName]: value }))
    .sort((a, b) => b[valueName] - a[valueName]);
}

async function fetchLeadsByConversationIds(tenantId, conversationIds, selectClause) {
  if (conversationIds.length === 0) return [];

  const responses = await Promise.all(
    chunkValues(conversationIds).map((ids) => (
      supabase
        .from('leads')
        .select(selectClause)
        .eq('tenant_id', tenantId)
        .in('conversation_id', ids)
        .limit(10000)
    ))
  );

  for (const response of responses) {
    if (response.error) throw response.error;
  }

  return responses.flatMap((response) => response.data || []);
}

async function buildDailyReportData(tenantId, fromISO, toISO, fromDate, toDate) {
  const { data: conversations, error: conversationsError } = await supabase
    .from('conversations')
    .select('id, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', fromISO)
    .lte('created_at', toISO)
    .limit(10000);

  if (conversationsError) throw conversationsError;

  const { data: leads, error: leadsError } = await supabase
    .from('leads')
    .select('id, inquiry_quality, business_value, route, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', fromISO)
    .lte('created_at', toISO)
    .limit(10000);

  if (leadsError) throw leadsError;

  const conversationCountsByDate = countEntries(conversations, (row) => toDateKey(row.created_at));
  const leadsByDate = {};
  const qualityDistribution = new Map();
  const routeDistribution = new Map();

  for (const lead of leads || []) {
    const date = toDateKey(lead.created_at);
    const quality = normalizeQuality(lead.inquiry_quality);

    if (date) {
      if (!leadsByDate[date]) {
        leadsByDate[date] = { total: 0, PROOF: 0, QUALIFY: 0, GOOD: 0, BAD: 0 };
      }

      leadsByDate[date].total += 1;
      if (QUALITY_KEYS.includes(quality)) {
        leadsByDate[date][quality] += 1;
      }
    }

    incrementMap(qualityDistribution, quality);
    incrementMap(routeDistribution, lead.route || 'UNKNOWN');
  }

  const dailyConversations = createDateSeries(fromDate, toDate, (date) => ({
    date,
    count: conversationCountsByDate[date] || 0,
  }));

  const dailyLeads = createDateSeries(fromDate, toDate, (date) => ({
    date,
    ...(leadsByDate[date] || { total: 0, PROOF: 0, QUALIFY: 0, GOOD: 0, BAD: 0 }),
  }));

  return {
    totals: {
      conversations: conversations?.length || 0,
      leads: leads?.length || 0,
    },
    qualityDistribution: mapToSortedEntries(qualityDistribution, 'quality', 'count'),
    routeDistribution: mapToSortedEntries(routeDistribution, 'route', 'count'),
    dailyConversations,
    dailyLeads,
  };
}

function ensureAttributionBucket(map, metaAdId) {
  if (!map.has(metaAdId)) {
    map.set(metaAdId, {
      metaAdId,
      conversationCount: 0,
      leadCount: 0,
      qualityCounts: new Map(),
      routeCounts: new Map(),
      agentCounts: new Map(),
      countryCounts: new Map(),
      lastConversationAt: null,
      qualifyConversationIds: new Set(),
      proofConversationIds: new Set(),
    });
  }

  return map.get(metaAdId);
}

async function buildAttributionData(tenantId, fromISO, toISO) {
  const { data: conversations, error: conversationsError } = await supabase
    .from('conversations')
    .select('id, meta_ad_id, created_at')
    .eq('tenant_id', tenantId)
    .not('meta_ad_id', 'is', null)
    .gte('created_at', fromISO)
    .lte('created_at', toISO)
    .order('created_at', { ascending: false })
    .limit(10000);

  if (conversationsError) throw conversationsError;

  const attributionMap = new Map();
  const conversationMetaAdMap = new Map();

  for (const conversation of conversations || []) {
    const metaAdId = String(conversation.meta_ad_id || '').trim();
    if (!metaAdId) continue;

    conversationMetaAdMap.set(conversation.id, metaAdId);

    const bucket = ensureAttributionBucket(attributionMap, metaAdId);
    bucket.conversationCount += 1;

    if (!bucket.lastConversationAt || conversation.created_at > bucket.lastConversationAt) {
      bucket.lastConversationAt = conversation.created_at;
    }
  }

  const leads = await fetchLeadsByConversationIds(
    tenantId,
    Array.from(conversationMetaAdMap.keys()),
    'id, conversation_id, inquiry_quality, business_value, route, destination_country, agent_id, created_at, agent:agents(id, product_line)'
  );

  for (const lead of leads) {
    const metaAdId = conversationMetaAdMap.get(lead.conversation_id);
    if (!metaAdId) continue;

    const bucket = ensureAttributionBucket(attributionMap, metaAdId);
    const quality = normalizeQuality(lead.inquiry_quality);
    const agentLabel = lead.agent?.product_line || lead.agent_id || 'UNASSIGNED';

    bucket.leadCount += 1;
    incrementMap(bucket.qualityCounts, quality);
    incrementMap(bucket.routeCounts, lead.route || 'UNKNOWN');
    incrementMap(bucket.agentCounts, agentLabel);
    incrementMap(bucket.countryCounts, lead.destination_country || 'UNKNOWN');

    if (lead.conversation_id && quality === 'QUALIFY') {
      bucket.qualifyConversationIds.add(lead.conversation_id);
    }

    if (lead.conversation_id && quality === 'PROOF') {
      bucket.proofConversationIds.add(lead.conversation_id);
    }
  }

  const summary = Array.from(attributionMap.values())
    .map((bucket) => ({
      metaAdId: bucket.metaAdId,
      conversationCount: bucket.conversationCount,
      leadCount: bucket.leadCount,
      qualifyConversationCount: bucket.qualifyConversationIds.size,
      proofConversationCount: bucket.proofConversationIds.size,
      qualifyConversationRate: bucket.conversationCount > 0
        ? Math.round((bucket.qualifyConversationIds.size / bucket.conversationCount) * 100)
        : 0,
      proofConversationRate: bucket.conversationCount > 0
        ? Math.round((bucket.proofConversationIds.size / bucket.conversationCount) * 100)
        : 0,
      qualityDistribution: mapToSortedEntries(bucket.qualityCounts, 'quality', 'count'),
      routeDistribution: mapToSortedEntries(bucket.routeCounts, 'route', 'count'),
      topAgents: mapToSortedEntries(bucket.agentCounts, 'agent', 'count').slice(0, 5),
      topCountries: mapToSortedEntries(bucket.countryCounts, 'country', 'count').slice(0, 5),
      lastConversationAt: bucket.lastConversationAt,
    }))
    .sort((a, b) => {
      if (b.conversationCount !== a.conversationCount) {
        return b.conversationCount - a.conversationCount;
      }
      return a.metaAdId.localeCompare(b.metaAdId);
    });

  return {
    totals: {
      ads: summary.length,
      conversations: conversations?.length || 0,
      leads: leads.length,
    },
    ads: summary,
  };
}

async function buildMarketInsightData(tenantId, fromISO, toISO) {
  const { data: leads, error: leadsError } = await supabase
    .from('leads')
    .select('id, destination_country, inquiry_quality, business_value, route, created_at')
    .eq('tenant_id', tenantId)
    .gte('created_at', fromISO)
    .lte('created_at', toISO)
    .not('destination_country', 'is', null)
    .limit(10000);

  if (leadsError) throw leadsError;

  const countryMap = new Map();
  const routeDistribution = new Map();

  for (const lead of leads || []) {
    const country = String(lead.destination_country || '').trim();
    if (!country) continue;

    if (!countryMap.has(country)) {
      countryMap.set(country, {
        country,
        leadCount: 0,
        qualityCounts: new Map(),
        businessValueCounts: new Map(),
        routeCounts: new Map(),
      });
    }

    const bucket = countryMap.get(country);
    const quality = normalizeQuality(lead.inquiry_quality);

    bucket.leadCount += 1;
    incrementMap(bucket.qualityCounts, quality);
    incrementMap(bucket.businessValueCounts, lead.business_value || 'UNKNOWN');
    incrementMap(bucket.routeCounts, lead.route || 'UNKNOWN');
    incrementMap(routeDistribution, lead.route || 'UNKNOWN');
  }

  const countries = Array.from(countryMap.values())
    .map((bucket) => ({
      country: bucket.country,
      leadCount: bucket.leadCount,
      qualityDistribution: mapToSortedEntries(bucket.qualityCounts, 'quality', 'count'),
      businessValueDistribution: mapToSortedEntries(bucket.businessValueCounts, 'businessValue', 'count'),
      routeDistribution: mapToSortedEntries(bucket.routeCounts, 'route', 'count'),
    }))
    .sort((a, b) => {
      if (b.leadCount !== a.leadCount) {
        return b.leadCount - a.leadCount;
      }
      return a.country.localeCompare(b.country);
    });

  return {
    totals: {
      countries: countries.length,
      leads: leads?.length || 0,
    },
    routeDistribution: mapToSortedEntries(routeDistribution, 'route', 'count'),
    countries,
  };
}

function ensureCampaignBucket(map, metaAdId) {
  if (!map.has(metaAdId)) {
    map.set(metaAdId, {
      metaAdId,
      conversationCount: 0,
      leadCount: 0,
      qualityCounts: new Map(),
      qualifyConversationIds: new Set(),
      proofConversationIds: new Set(),
    });
  }

  return map.get(metaAdId);
}

async function buildCampaignAnalysisData(tenantId, fromISO, toISO, fromDate, toDate) {
  const { data: conversations, error: conversationsError } = await supabase
    .from('conversations')
    .select('id, meta_ad_id, created_at')
    .eq('tenant_id', tenantId)
    .not('meta_ad_id', 'is', null)
    .gte('created_at', fromISO)
    .lte('created_at', toISO)
    .order('created_at', { ascending: false })
    .limit(10000);

  if (conversationsError) throw conversationsError;

  const adMap = new Map();
  const conversationMetaAdMap = new Map();
  const conversationDateMap = new Map();

  for (const conversation of conversations || []) {
    const metaAdId = String(conversation.meta_ad_id || '').trim();
    if (!metaAdId) continue;

    conversationMetaAdMap.set(conversation.id, metaAdId);
    conversationDateMap.set(conversation.id, toDateKey(conversation.created_at));

    const bucket = ensureCampaignBucket(adMap, metaAdId);
    bucket.conversationCount += 1;
  }

  const leads = await fetchLeadsByConversationIds(
    tenantId,
    Array.from(conversationMetaAdMap.keys()),
    'id, conversation_id, inquiry_quality'
  );

  const dailyAdConversationCounts = countEntries(conversations, (row) => toDateKey(row.created_at));
  const dailyQualifiedConversationSets = {};

  for (const lead of leads) {
    const metaAdId = conversationMetaAdMap.get(lead.conversation_id);
    if (!metaAdId) continue;

    const bucket = ensureCampaignBucket(adMap, metaAdId);
    const quality = normalizeQuality(lead.inquiry_quality);

    bucket.leadCount += 1;
    incrementMap(bucket.qualityCounts, quality);

    if (lead.conversation_id && quality === 'QUALIFY') {
      bucket.qualifyConversationIds.add(lead.conversation_id);
    }

    if (lead.conversation_id && quality === 'PROOF') {
      bucket.proofConversationIds.add(lead.conversation_id);
    }

    if (lead.conversation_id && (quality === 'QUALIFY' || quality === 'PROOF')) {
      const date = conversationDateMap.get(lead.conversation_id);
      if (date) {
        if (!dailyQualifiedConversationSets[date]) {
          dailyQualifiedConversationSets[date] = new Set();
        }
        dailyQualifiedConversationSets[date].add(lead.conversation_id);
      }
    }
  }

  const dailyPerformance = createDateSeries(fromDate, toDate, (date) => ({
    date,
    adConversationCount: dailyAdConversationCounts[date] || 0,
    qualifiedConversationCount: dailyQualifiedConversationSets[date]?.size || 0,
  }));

  const ads = Array.from(adMap.values())
    .map((bucket) => ({
      metaAdId: bucket.metaAdId,
      conversationCount: bucket.conversationCount,
      leadCount: bucket.leadCount,
      qualifyConversationCount: bucket.qualifyConversationIds.size,
      proofConversationCount: bucket.proofConversationIds.size,
      qualifyConversationRate: bucket.conversationCount > 0
        ? Math.round((bucket.qualifyConversationIds.size / bucket.conversationCount) * 100)
        : 0,
      proofConversationRate: bucket.conversationCount > 0
        ? Math.round((bucket.proofConversationIds.size / bucket.conversationCount) * 100)
        : 0,
      qualityDistribution: mapToSortedEntries(bucket.qualityCounts, 'quality', 'count'),
    }))
    .sort((a, b) => {
      if (b.conversationCount !== a.conversationCount) {
        return b.conversationCount - a.conversationCount;
      }
      return a.metaAdId.localeCompare(b.metaAdId);
    });

  const totals = ads.reduce((acc, item) => {
    acc.ads += 1;
    acc.conversations += item.conversationCount;
    acc.leads += item.leadCount;
    acc.qualifyConversations += item.qualifyConversationCount;
    acc.proofConversations += item.proofConversationCount;
    return acc;
  }, {
    ads: 0,
    conversations: 0,
    leads: 0,
    qualifyConversations: 0,
    proofConversations: 0,
  });

  return {
    totals: {
      ...totals,
      qualifyConversationRate: totals.conversations > 0
        ? Math.round((totals.qualifyConversations / totals.conversations) * 100)
        : 0,
      proofConversationRate: totals.conversations > 0
        ? Math.round((totals.proofConversations / totals.conversations) * 100)
        : 0,
    },
    dailyPerformance,
    ads,
  };
}

export async function buildReportData(tenantId, type, fromISO, toISO, fromDate, toDate) {
  switch (type) {
    case 'daily_report':
      return buildDailyReportData(tenantId, fromISO, toISO, fromDate, toDate);
    case 'attribution':
      return buildAttributionData(tenantId, fromISO, toISO);
    case 'market_insight':
      return buildMarketInsightData(tenantId, fromISO, toISO);
    case 'campaign_analysis':
      return buildCampaignAnalysisData(tenantId, fromISO, toISO, fromDate, toDate);
    default:
      throw new Error(`Unsupported report type: ${type}`);
  }
}

export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const type = typeof body?.type === 'string' ? body.type : '';
    const days = parseDays(body?.days);
    const context = body?.context && typeof body.context === 'object' && !Array.isArray(body.context)
      ? body.context
      : null;

    if (!VALID_TYPES.has(type)) {
      return NextResponse.json(
        { error: 'Invalid type. Expected one of: daily_report, attribution, market_insight, campaign_analysis' },
        { status: 400 }
      );
    }

    const { fromDate, toDate, fromISO, toISO } = buildDateRange(days);
    const generatedAt = new Date().toISOString();

    const reportData = await buildReportData(ctx.tenantId, type, fromISO, toISO, fromDate, toDate);
    const systemPrompt = REPORT_PROMPTS[type];

    const dataStr = JSON.stringify(reportData, null, 2);
    // Truncate to ~30KB to stay within MiniMax token budget
    const truncated = dataStr.length > 30000 ? dataStr.slice(0, 30000) + '\n...(数据已截断)' : dataStr;
    const userPrompt = `请严格基于以下数据生成报告，不要编造未提供的信息。若数据不足，请明确指出。\n\n报告类型: ${type}\n时间范围: ${fromISO} 至 ${toISO}\n附加上下文:\n${JSON.stringify(context || {}, null, 2)}\n\n数据:\n${truncated}`;

    const report = await generateSummaryWithFallback({
      system: systemPrompt,
      userPrompt,
      maxTokens: 2000,
      logTag: `ai/report:${type}`,
      tenantId: ctx.tenantId,
      callSite: `ai-report.${type}`,
    });

    return NextResponse.json({
      type,
      report,
      generatedAt,
      dataRange: {
        from: fromISO,
        to: toISO,
      },
    });
  } catch (error) {
    console.error('[ai/report] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to generate report' },
      { status: 500 }
    );
  }
}
