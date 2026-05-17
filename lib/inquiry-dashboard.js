import { INQUIRY_QUALITY_ORDER, BUSINESS_VALUE_ORDER } from './inquiries-filters.js';

const TIME_ZONE = 'Asia/Shanghai';

const QUALITY_ORDER = INQUIRY_QUALITY_ORDER;
const QUALITY_RANK = Object.fromEntries(QUALITY_ORDER.map((value, index) => [value, index]));

const BUSINESS_VALUE_RANK = Object.fromEntries(BUSINESS_VALUE_ORDER.map((value, index) => [value, index]));

const DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatDateInTimeZone(date) {
  const parts = DATE_FORMATTER.formatToParts(date);
  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

export function shiftDateString(dateString, deltaDays) {
  const [year, month, day] = dateString.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return shifted.toISOString().split('T')[0];
}

export function diffDaysInclusive(startDate, endDate) {
  const [startYear, startMonth, startDay] = startDate.split('-').map(Number);
  const [endYear, endMonth, endDay] = endDate.split('-').map(Number);
  const start = Date.UTC(startYear, startMonth - 1, startDay);
  const end = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.floor((end - start) / 86400000) + 1;
}

export function localDateToUtcIso(dateString, endOfDay = false) {
  const time = endOfDay ? '23:59:59.999' : '00:00:00.000';
  return new Date(`${dateString}T${time}+08:00`).toISOString();
}

export function buildDateWindows({ days, preset, startDate, endDate, now = new Date() }) {
  if (startDate && endDate) {
    const spanDays = diffDaysInclusive(startDate, endDate);
    const prevToDate = shiftDateString(startDate, -1);
    const prevFromDate = shiftDateString(prevToDate, -(spanDays - 1));

    return {
      current: {
        fromDate: startDate,
        toDate: endDate,
        fromISO: localDateToUtcIso(startDate, false),
        toISO: localDateToUtcIso(endDate, true),
      },
      previous: {
        fromDate: prevFromDate,
        toDate: prevToDate,
        fromISO: localDateToUtcIso(prevFromDate, false),
        toISO: localDateToUtcIso(prevToDate, true),
      },
    };
  }

  const today = formatDateInTimeZone(now);
  if (preset === '1d') {
    const yesterday = shiftDateString(today, -1);
    const previousDay = shiftDateString(yesterday, -1);

    return {
      current: {
        fromDate: yesterday,
        toDate: yesterday,
        fromISO: localDateToUtcIso(yesterday, false),
        toISO: localDateToUtcIso(yesterday, true),
      },
      previous: {
        fromDate: previousDay,
        toDate: previousDay,
        fromISO: localDateToUtcIso(previousDay, false),
        toISO: localDateToUtcIso(previousDay, true),
      },
    };
  }

  const spanDays = Math.max(days || 7, 1);
  const yesterday = shiftDateString(today, -1);
  const fromDate = shiftDateString(yesterday, -(spanDays - 1));
  const prevToDate = shiftDateString(fromDate, -1);
  const prevFromDate = shiftDateString(prevToDate, -(spanDays - 1));

  return {
    current: {
      fromDate,
      toDate: yesterday,
      fromISO: localDateToUtcIso(fromDate, false),
      toISO: localDateToUtcIso(yesterday, true),
    },
    previous: {
      fromDate: prevFromDate,
      toDate: prevToDate,
      fromISO: localDateToUtcIso(prevFromDate, false),
      toISO: localDateToUtcIso(prevToDate, true),
    },
  };
}

// Resolve a UI preset key into an explicit Asia/Shanghai date range so the
// frontend can send stable YYYY-MM-DD params to the backend (stable cache keys
// within a day + no partial-today data).
//
//   '1d'     → [yesterday, yesterday]
//   '7d'     → [yesterday - 6, yesterday]
//   '30d'    → [yesterday - 29, yesterday]
//   '365d'   → [yesterday - 364, yesterday]   (前一年)
//   'custom' → uses customFrom / customTo verbatim (YYYY-MM-DD)
export const PRESET_LABELS = {
  '1d': '昨天',
  '7d': '前一周',
  '30d': '前一个月',
  '365d': '前一年',
  custom: '自定义',
};

const PRESET_DAYS = { '1d': 1, '7d': 7, '30d': 30, '365d': 365 };

export function resolveDateRange(preset, customFrom, customTo, now = new Date()) {
  if (preset === 'custom') {
    if (!customFrom || !customTo) {
      return { startDate: null, endDate: null, days: 0, label: '自定义' };
    }
    const days = Math.max(1, diffDaysInclusive(customFrom, customTo));
    const label = customFrom === customTo ? customFrom : `${customFrom} ~ ${customTo}`;
    return { startDate: customFrom, endDate: customTo, days, label };
  }

  const days = PRESET_DAYS[preset] ?? 7;
  const today = formatDateInTimeZone(now);
  const yesterday = shiftDateString(today, -1);
  const startDate = shiftDateString(yesterday, -(days - 1));
  return {
    startDate,
    endDate: yesterday,
    days,
    label: PRESET_LABELS[preset] ?? `${days}d`,
  };
}

export function getProductName(lead, productLine) {
  const d = lead.details || {};
  switch (productLine) {
    case 'vehicle':
      return d.car_model || d.brand || d.product_name || null;
    case 'auto_parts':
      return d.part_name || d.product_name || d.oem_code || null;
    case 'agri_machinery':
      return d.machinery_type || d.product_name || null;
    default:
      return d.product_name || d.car_model || null;
  }
}

export function parseIntents(raw) {
  if (!raw) return [];
  if (typeof raw === 'string' && raw.startsWith('[')) {
    try {
      raw = JSON.parse(raw).join(',');
    } catch {
      raw = raw.replace(/[\[\]"]/g, '');
    }
  }
  return raw.split(',').map(item => item.trim()).filter(Boolean);
}

function pickBestQuality(leads) {
  let best = 'BAD';
  for (const lead of leads) {
    const quality = lead.inquiry_quality || 'BAD';
    if ((QUALITY_RANK[quality] ?? -1) > (QUALITY_RANK[best] ?? -1)) {
      best = quality;
    }
  }
  return best;
}

function pickBestBusinessValue(leads) {
  let best = null;
  for (const lead of leads) {
    const value = lead.business_value || null;
    if (!value) continue;
    if (!best || (BUSINESS_VALUE_RANK[value] ?? -1) > (BUSINESS_VALUE_RANK[best] ?? -1)) {
      best = value;
    }
  }
  return best;
}

function choosePrimaryLead(leads) {
  if (leads.length === 0) return null;

  return [...leads].sort((left, right) => {
    const qualityDiff = (QUALITY_RANK[right.inquiry_quality || 'BAD'] ?? -1) - (QUALITY_RANK[left.inquiry_quality || 'BAD'] ?? -1);
    if (qualityDiff !== 0) return qualityDiff;

    const businessValueDiff = (BUSINESS_VALUE_RANK[right.business_value || 'LOW'] ?? -1) - (BUSINESS_VALUE_RANK[left.business_value || 'LOW'] ?? -1);
    if (businessValueDiff !== 0) return businessValueDiff;

    return new Date(right.created_at).getTime() - new Date(left.created_at).getTime();
  })[0];
}

export function buildInquiryRecords({ conversations, leads, agentMap }) {
  const leadsByConversation = new Map();
  for (const lead of leads) {
    const existing = leadsByConversation.get(lead.conversation_id);
    if (existing) {
      existing.push(lead);
    } else {
      leadsByConversation.set(lead.conversation_id, [lead]);
    }
  }

  return conversations.map(conversation => {
    const conversationLeads = leadsByConversation.get(conversation.id) || [];
    const primaryLead = choosePrimaryLead(conversationLeads);
    const agent = agentMap[conversation.agent_id];
    const primaryIntent = primaryLead ? parseIntents(primaryLead.conversation_intent)[0] : null;

    return {
      conversationId: conversation.id,
      agentId: conversation.agent_id,
      agentName: agent?.name || 'Unknown',
      productLine: agent?.product_line || 'unknown',
      displayLabel: agent?.display_label || null,
      date: formatDateInTimeZone(new Date(conversation.created_at)),
      quality: pickBestQuality(conversationLeads),
      businessValue: pickBestBusinessValue(conversationLeads),
      country: primaryLead?.details?.destination_country || 'unknown',
      buyerType: primaryLead?.details?.buyer_type || 'unknown',
      intent: primaryIntent || 'unknown',
      productName: primaryLead ? getProductName(primaryLead, agent?.product_line || 'unknown') : null,
    };
  });
}

export function createDateSeries(fromDate, toDate) {
  const dates = [];
  let cursor = fromDate;
  while (cursor <= toDate) {
    dates.push(cursor);
    cursor = shiftDateString(cursor, 1);
  }
  return dates;
}

/* ─────────────────────────  data access  ───────────────────────── */

async function fetchAllPages(buildQuery, pageSize = 1000) {
  const rows = [];
  let from = 0;
  while (true) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }
  return rows;
}

async function fetchAgentsByProductLines(supabase, tenantId, productLines) {
  // agentMap is purely a display lookup (name + product_line) for rendering
  // inquiry rows. It must include BOTH active and inactive agents — otherwise
  // historical conversations owned by a now-deactivated agent resolve to
  // "Unknown", producing duplicate-key rows in buildAgentDistribution.
  let query = supabase
    .from('agents')
    .select('id, name, product_line, display_label')
    .eq('tenant_id', tenantId);
  if (productLines && productLines.length > 0) {
    query = query.in('product_line', productLines);
  }
  const { data, error } = await query;
  if (error) throw error;

  const agents = data || [];
  return {
    agentIds: agents.map((a) => a.id),
    agentMap: Object.fromEntries(agents.map((a) => [a.id, a])),
  };
}

async function queryConversations(supabase, tenantId, fromISO, toISO) {
  return fetchAllPages(() => (
    supabase
      .from('conversations')
      .select('id, agent_id, created_at, last_message_at')
      .eq('tenant_id', tenantId)
      .gte('last_message_at', fromISO)
      .lte('last_message_at', toISO)
      .order('last_message_at', { ascending: true })
      .order('id', { ascending: true })
  ));
}

async function queryLeads(supabase, tenantId, conversationIds) {
  if (conversationIds.length === 0) return [];
  const batchSize = 200;
  const leads = [];
  for (let i = 0; i < conversationIds.length; i += batchSize) {
    const batch = conversationIds.slice(i, i + batchSize);
    const rows = await fetchAllPages(() => (
      supabase
        .from('leads')
        .select('id, inquiry_quality, business_value, conversation_intent, details, conversation_id, agent_id, created_at')
        .eq('tenant_id', tenantId)
        .in('conversation_id', batch)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
    ));
    leads.push(...rows);
  }
  return leads;
}

/* ─────────────────────────  aggregations  ───────────────────────── */

function roundRate(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function computeKpi(inquiries) {
  const totalInquiries = inquiries.length;
  const proofInquiries = inquiries.filter((i) => i.quality === 'PROOF').length;
  const highValueInquiries = inquiries.filter((i) => i.businessValue === 'HIGH').length;
  return {
    totalInquiries,
    proofInquiries,
    proofRate: roundRate(proofInquiries, totalInquiries),
    highValueRate: roundRate(highValueInquiries, totalInquiries),
  };
}

function buildDailyTrend(inquiries, fromDate, toDate) {
  const groups = {};
  for (const inquiry of inquiries) {
    const g = groups[inquiry.date] || (groups[inquiry.date] = { total: 0, proof: 0 });
    g.total += 1;
    if (inquiry.quality === 'PROOF') g.proof += 1;
  }
  return createDateSeries(fromDate, toDate).map((date) => ({
    date,
    total: groups[date]?.total || 0,
    proof: groups[date]?.proof || 0,
  }));
}

function buildAgentDistribution(inquiries) {
  const groups = {};
  for (const inquiry of inquiries) {
    // Use a composite key: agentId normally resolves all of an agent's
    // inquiries to one row, but when agentId is null (pre-routing / router
    // clarification), group by productLine so each unknown bucket stays unique.
    const key = inquiry.agentId || `__noagent__:${inquiry.productLine || 'unknown'}`;
    const g = groups[key] || (groups[key] = {
      agentId: inquiry.agentId || null,
      agentName: inquiry.agentName,
      productLine: inquiry.productLine,
      displayLabel: inquiry.displayLabel || null,
      inquiryCount: 0,
      proofCount: 0,
      quality: { PROOF: 0, QUALIFY: 0, GOOD: 0, BAD: 0 },
    });
    g.inquiryCount += 1;
    if (inquiry.quality === 'PROOF') g.proofCount += 1;
    g.quality[inquiry.quality] += 1;
  }
  return Object.values(groups)
    .map((g) => ({ ...g, proofRate: roundRate(g.proofCount, g.inquiryCount) }))
    .sort((a, b) => b.inquiryCount - a.inquiryCount);
}

// Lead-level country distribution: each lead counts individually so
// conversations with multiple leads targeting different countries are all
// reflected. destination_country lives in details JSONB.
function buildCountryDistribution(leads) {
  const groups = {};
  for (const lead of leads) {
    const key = lead.details?.destination_country || 'UNKNOWN';
    const g = groups[key] || (groups[key] = { country: key, leadCount: 0, proofCount: 0 });
    g.leadCount += 1;
    if (lead.inquiry_quality === 'PROOF') g.proofCount += 1;
  }
  let rows = Object.values(groups)
    .map((g) => ({ country: g.country, leadCount: g.leadCount, proofRate: roundRate(g.proofCount, g.leadCount) }))
    .sort((a, b) => b.leadCount - a.leadCount);
  if (rows.length > 10) {
    const top10 = rows.slice(0, 10);
    const others = rows.slice(10);
    top10.push({
      country: 'Others',
      leadCount: others.reduce((sum, r) => sum + r.leadCount, 0),
      proofRate: 0,
    });
    rows = top10;
  }
  return rows;
}

function buildQualityDistribution(inquiries) {
  const counts = { PROOF: 0, QUALIFY: 0, GOOD: 0, BAD: 0 };
  for (const inquiry of inquiries) counts[inquiry.quality] += 1;
  return Object.entries(counts).map(([name, value]) => ({ name, value }));
}

function buildKeyedCountDistribution(inquiries, keyFn, fallback = 'other') {
  const counts = {};
  for (const inquiry of inquiries) {
    const key = keyFn(inquiry) || fallback;
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

function buildTopProducts(inquiries) {
  const groups = {};
  for (const inquiry of inquiries) {
    if (!inquiry.productName) continue;
    const key = `${inquiry.productName}|||${inquiry.productLine}`;
    const g = groups[key] || (groups[key] = {
      productName: inquiry.productName,
      productLine: inquiry.productLine,
      displayLabel: inquiry.displayLabel || null,
      inquiryCount: 0,
      proofCount: 0,
    });
    g.inquiryCount += 1;
    if (inquiry.quality === 'PROOF') g.proofCount += 1;
  }
  return Object.values(groups)
    .map((g) => ({
      productName: g.productName,
      productLine: g.productLine,
      displayLabel: g.displayLabel,
      inquiryCount: g.inquiryCount,
      proofRate: roundRate(g.proofCount, g.inquiryCount),
    }))
    .sort((a, b) => b.inquiryCount - a.inquiryCount)
    .slice(0, 10);
}

/* ─────────────────────────  composition  ───────────────────────── */

function emptyDashboardResult() {
  return {
    kpi: {
      totalInquiries: { current: 0, previous: 0 },
      proofInquiries: { current: 0, previous: 0 },
      proofRate: { current: 0, previous: 0 },
      highValueRate: { current: 0, previous: 0 },
    },
    dailyTrend: [],
    agentDistribution: [],
    countryDistribution: [],
    qualityDistribution: [],
    intentDistribution: [],
    topProducts: [],
  };
}

// Single entry point for computing the analytics dashboard. Both the JSON
// route and the SSE AI-summary route call this directly — no HTTP round-trip,
// no fake Request objects.
export async function fetchDashboardData(supabase, { tenantId, windows, productLines }) {
  if (!tenantId) throw new Error('fetchDashboardData: tenantId required');
  // agentMap is still needed for display (agent name / product_line in
  // agentDistribution / topProducts), but we no longer filter conversations
  // by agent_id — all conversations in the time window are counted.
  const { agentMap } = await fetchAgentsByProductLines(supabase, tenantId, productLines);

  const [currentConvs, previousConvs] = await Promise.all([
    queryConversations(supabase, tenantId, windows.current.fromISO, windows.current.toISO),
    queryConversations(supabase, tenantId, windows.previous.fromISO, windows.previous.toISO),
  ]);

  const [currentLeads, previousLeads] = await Promise.all([
    queryLeads(supabase, tenantId, currentConvs.map((c) => c.id)),
    queryLeads(supabase, tenantId, previousConvs.map((c) => c.id)),
  ]);

  const current = buildInquiryRecords({ conversations: currentConvs, leads: currentLeads, agentMap });
  const previous = buildInquiryRecords({ conversations: previousConvs, leads: previousLeads, agentMap });

  const currentKpi = computeKpi(current);
  const previousKpi = computeKpi(previous);

  return {
    kpi: {
      totalInquiries: { current: currentKpi.totalInquiries, previous: previousKpi.totalInquiries },
      proofInquiries: { current: currentKpi.proofInquiries, previous: previousKpi.proofInquiries },
      proofRate: { current: currentKpi.proofRate, previous: previousKpi.proofRate },
      highValueRate: { current: currentKpi.highValueRate, previous: previousKpi.highValueRate },
    },
    dailyTrend: buildDailyTrend(current, windows.current.fromDate, windows.current.toDate),
    agentDistribution: buildAgentDistribution(current),
    countryDistribution: buildCountryDistribution(currentLeads),
    qualityDistribution: buildQualityDistribution(current),
    intentDistribution: buildKeyedCountDistribution(current, (i) => i.intent),
    topProducts: buildTopProducts(current),
  };
}

/* ─────────────────────────  param parsing  ───────────────────────── */

export function parseDashboardParams(searchParams) {
  const days = parseInt(searchParams.get('days') || '7', 10);
  const preset = searchParams.get('preset') || '';
  const rawStart = searchParams.get('startDate') || '';
  const rawEnd = searchParams.get('endDate') || '';
  // Empty default = "all active" — fetchAgentsByProductLines() will expand to
  // every active agent, so dashboards auto-include newly-created product lines.
  const productLines = (searchParams.get('productLines') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // The frontend may send full ISO timestamps (rolling window) or YYYY-MM-DD
  // strings (custom date picker). Detect which format and handle accordingly.
  const isIsoTimestamp = rawStart.includes('T');

  if (isIsoTimestamp && rawStart && rawEnd) {
    // Full ISO timestamps — use directly, skip buildDateWindows' date-string logic.
    // Compute a "previous" window of the same span for delta comparison.
    const fromMs = new Date(rawStart).getTime();
    const toMs = new Date(rawEnd).getTime();
    const spanMs = toMs - fromMs;
    const prevToISO = new Date(fromMs - 1).toISOString();
    const prevFromISO = new Date(fromMs - spanMs).toISOString();
    const fromDate = rawStart.slice(0, 10);
    const toDate = rawEnd.slice(0, 10);
    const prevFromDate = prevFromISO.slice(0, 10);
    const prevToDate = prevToISO.slice(0, 10);

    return {
      windows: {
        current: { fromDate, toDate, fromISO: rawStart, toISO: rawEnd },
        previous: { fromDate: prevFromDate, toDate: prevToDate, fromISO: prevFromISO, toISO: prevToISO },
      },
      productLines,
    };
  }

  // YYYY-MM-DD strings or days-based preset — delegate to buildDateWindows
  return {
    windows: buildDateWindows({ days, preset, startDate: rawStart, endDate: rawEnd }),
    productLines,
  };
}
