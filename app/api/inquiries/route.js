import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import { getTenantContext } from '@/lib/tenant-context';
import {
  BUSINESS_VALUE_OPTIONS,
  INQUIRY_QUALITY_OPTIONS,
  ROUTE_OPTIONS,
  filterLeadsByQuantity,
  hasActiveQuantityFilter,
  normalizeQuantityFilter,
  parseMultiSelectParams,
} from '@/lib/inquiries-filters';

/* ─────────────────────────  constants  ───────────────────────── */

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const FULL_SCAN_BATCH_SIZE = 200;
const CONTACT_ID_BATCH = 1000;

// 产品线归属的事实真源是 leads.product_line。agents 表已下线。
const LEADS_SELECT = `
  id, conversation_id, inquiry_quality, business_value,
  conversation_intent, conversation_intent_summary,
  route, handoff_summary, updated_at,
  details, product_line
`;

const CONVERSATION_SELECT = `
  id, status, last_message_at, message_count,
  contact_id, is_human_takeover, wa_phone_number_id, meta_ad_id,
  resolved_route,
  contact:contacts!inner(wa_id, company_name, name)
`;

/* ─────────────────────────  small utilities  ───────────────────────── */

function throwIfError(result) {
  if (result?.error) throw result.error;
  return result;
}

function makeLikePattern(raw) {
  const trimmed = raw.trim();
  return /[%_]/.test(trimmed) ? trimmed : `${trimmed}%`;
}

/* ─────────────────────────  param parsing  ───────────────────────── */

function parseHumanTakeover(sp) {
  const raw = sp.get('humanTakeover');
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

function parseCursor(sp) {
  const cursorTs = sp.get('cursorTs');
  const cursorId = sp.get('cursorId');
  return cursorTs && cursorId ? { cursorTs, cursorId } : null;
}

function parseLimit(sp) {
  const raw = Number.parseInt(sp.get('limit') || `${DEFAULT_LIMIT}`, 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
}

// resolvedRoute（会话级当前路由，由 conversations_with_resolved_route 视图算出）
// 与 routes（leads.route 多选过滤，lead 级）语义不同。前者用于 leadhub 顶部 route
// bar 的 tab 切换；后者保留给原本就按 lead.route 多选的场景。
const RESOLVED_ROUTE_VALUES = new Set(['HUMAN_NOW', 'CONTINUE', 'FAQ_END']);

function parseFilters(sp) {
  const dateFrom = sp.get('dateFrom') || '';
  const dateTo = sp.get('dateTo') || '';
  const rawResolvedRoute = sp.get('resolvedRoute') || '';
  return {
    // lead-level filters
    inquiryQualities: parseMultiSelectParams(sp, 'inquiryQuality', INQUIRY_QUALITY_OPTIONS),
    businessValues: parseMultiSelectParams(sp, 'businessValue', BUSINESS_VALUE_OPTIONS),
    routes: parseMultiSelectParams(sp, 'route', ROUTE_OPTIONS),
    country: sp.get('country') || 'all',
    model: sp.get('model') || 'all',

    // conversation-level resolved-route filter (HUMAN_NOW / CONTINUE / FAQ_END)
    resolvedRoute: RESOLVED_ROUTE_VALUES.has(rawResolvedRoute) ? rawResolvedRoute : null,

    // contact-level filters
    customer: sp.get('customer') || '',
    waPrefix: sp.get('waPrefix') || '',

    // conversation-level filters
    dateFrom: Number.isNaN(Date.parse(dateFrom)) ? '' : dateFrom,
    dateTo: Number.isNaN(Date.parse(dateTo)) ? '' : dateTo,
    // 产品线归属走 leads.product_line —— lead-scoped filter；
    // values 是 product_line slug（e.g. 'vehicle'）。
    productLines: sp.getAll('productLines').filter(Boolean),
    humanTakeover: parseHumanTakeover(sp),
    // Accept either ?metaAdId=X or repeated ?metaAdId=X&metaAdId=Y
    metaAdIds: sp.getAll('metaAdId').map((v) => v.trim()).filter(Boolean),
    // Targeted fetch by conversation id — used by the leadhub realtime path to
    // refresh just the rows that changed instead of the full first page.
    conversationIds: sp.getAll('conversationIds').map((v) => v.trim()).filter(Boolean),

    // quantity lives inside leads.color_quantity JSON → JS-side
    ...normalizeQuantityFilter({
      quantityMin: sp.get('quantityMin'),
      quantityMax: sp.get('quantityMax'),
    }),
  };
}

/* ─────────────────────────  filter application  ─────────────────────────
 *
 * Each helper takes a query + the active filters and an optional foreignTable
 * so the same code works when the filter targets the base table (e.g. querying
 * conversations directly) or an inner-joined embedded resource (e.g. filtering
 * conversations.* from a leads-first query).
 * ─────────────────────────────────────────────────────────────────────── */

function hasLeadScopedFilter(f) {
  return (
    f.inquiryQualities.length > 0 ||
    f.businessValues.length > 0 ||
    f.routes.length > 0 ||
    f.productLines.length > 0 ||
    (f.country && f.country !== 'all') ||
    (f.model && f.model !== 'all')
  );
}

function applyConversationFilters(query, filters, { foreignTable } = {}) {
  const col = (name) => (foreignTable ? `${foreignTable}.${name}` : name);

  if (filters.humanTakeover === true) {
    query = query.eq(col('is_human_takeover'), true);
  } else if (filters.humanTakeover === false) {
    // NULL or false — PostgREST .or() uses the foreignTable option for scoping
    const expr = 'is_human_takeover.is.null,is_human_takeover.eq.false';
    query = foreignTable ? query.or(expr, { foreignTable }) : query.or(expr);
  }
  if (filters.dateFrom) query = query.gte(col('last_message_at'), filters.dateFrom);
  if (filters.dateTo) query = query.lte(col('last_message_at'), filters.dateTo);
  if (filters.metaAdIds.length === 1) {
    query = query.eq(col('meta_ad_id'), filters.metaAdIds[0]);
  } else if (filters.metaAdIds.length > 1) {
    query = query.in(col('meta_ad_id'), filters.metaAdIds);
  }
  if (filters.conversationIds.length === 1) {
    query = query.eq(col('id'), filters.conversationIds[0]);
  } else if (filters.conversationIds.length > 1) {
    query = query.in(col('id'), filters.conversationIds);
  }
  // resolved_route 只存在于 conversations_with_resolved_route 视图（即 base 查询，
  // 没有 foreignTable）。lead-base 查询走 conversations!inner 嵌套是 base 表，
  // 没有这列；这里跳过避免 PostgREST 报 unknown column。代价是：当 resolvedRoute
  // 过滤生效时，totalLeads 会反映"全部 route 范围内的 lead 总数"而不是仅当前
  // 选中 route。KpiStrip 的 "线索" 字段是 scope 指示，可接受；route bar 本身
  // 的精确 count 由服务端独立计算的 routeBuckets 提供。
  if (filters.resolvedRoute && !foreignTable) {
    query = query.eq('resolved_route', filters.resolvedRoute);
  }
  return query;
}

// The `customer` search box matches any of company_name / name / wa_id /
// leads.destination_country. Because destination_country lives on a sibling
// table (leads), the cross-table OR can't be expressed in a single PostgREST
// query — the caller pre-resolves matching conversation_ids into
// filters._customerConvIds, and this helper just narrows by that set.
// `waPrefix` is a separate legacy param that still narrows wa_id only.
function applyContactFilters(query, filters, opts = {}) {
  const { foreignTable = 'contact', conversationIdCol = 'id' } = opts;
  if (Array.isArray(filters._customerConvIds)) {
    query = query.in(conversationIdCol, filters._customerConvIds);
  }
  if (filters.waPrefix.trim()) {
    query = query.ilike(`${foreignTable}.wa_id`, makeLikePattern(filters.waPrefix));
  }
  return query;
}

// Resolve the `customer` free-text search into the union of conversation_ids
// matched via contact fields and via leads.destination_country.
async function resolveCustomerConvIds(supabase, tenantId, rawCustomer) {
  const safe = rawCustomer.trim().replace(/,/g, ' ');
  if (!safe) return null;
  const orLike = `*${safe}*`;
  const ilikePattern = `%${safe}%`;

  const [byContact, byCountry] = await Promise.all([
    supabase
      .from('conversations')
      .select('id, contact:contacts!inner(id)')
      .eq('tenant_id', tenantId)
      .or(
        `company_name.ilike.${orLike},name.ilike.${orLike},wa_id.ilike.${orLike}`,
        { foreignTable: 'contact' },
      ),
    supabase
      .from('leads')
      .select('conversation_id')
      .eq('tenant_id', tenantId)
      .ilike('details->>destination_country', ilikePattern)
      .not('conversation_id', 'is', null),
  ]);
  throwIfError(byContact);
  throwIfError(byCountry);

  const ids = new Set();
  for (const r of byContact.data || []) ids.add(r.id);
  for (const r of byCountry.data || []) ids.add(r.conversation_id);
  return Array.from(ids);
}

function applyLeadFilters(query, filters, prefix = 'leads.') {
  const col = (name) => `${prefix}${name}`;
  if (filters.inquiryQualities.length > 0) query = query.in(col('inquiry_quality'), filters.inquiryQualities);
  if (filters.businessValues.length > 0) query = query.in(col('business_value'), filters.businessValues);
  if (filters.routes.length > 0) query = query.in(col('route'), filters.routes);
  if (filters.productLines.length > 0) query = query.in(col('product_line'), filters.productLines);
  if (filters.country !== 'all') query = query.eq(col('details->>destination_country'), filters.country);
  if (filters.model !== 'all') query = query.eq(col('details->>car_model'), filters.model);
  return query;
}

function applyCursor(query, cursor) {
  if (!cursor) return query;
  return query.or(
    `last_message_at.lt.${cursor.cursorTs},and(last_message_at.eq.${cursor.cursorTs},id.lt.${cursor.cursorId})`
  );
}

/* ─────────────────────────  query builders  ─────────────────────────
 *
 * Every conversation-scoped query shares the same filter application; only
 * the SELECT fragment and range/order/count vary. buildConversationsQuery is
 * the single scaffold; specialised builders pick a select and add pagination.
 * ─────────────────────────────────────────────────────────────────────── */

// 所有"对话为主"的查询走视图 conversations_with_resolved_route，让 resolvedRoute
// 过滤、resolved_route 列、以及顶部 route bar 的 server-side filter 全部在 SQL
// 层完成。视图列是 conversations.* + resolved_route，原本的字段选择无需调整。
const CONVERSATIONS_SOURCE = 'conversations_with_resolved_route';

function buildConversationsQuery(supabase, tenantId, filters, { select, count = false }) {
  const base = supabase
    .from(CONVERSATIONS_SOURCE)
    .select(select, count ? { count: 'exact', head: true } : undefined)
    .eq('tenant_id', tenantId);

  let query = applyConversationFilters(base, filters);
  query = applyContactFilters(query, filters);
  // Applying lead filters on a left join is a no-op on parent rows; when the
  // caller forces `leads!inner` in its select fragment, it narrows correctly.
  query = applyLeadFilters(query, filters);
  return query;
}

function leadsJoinFragment(filters) {
  return hasLeadScopedFilter(filters) ? 'leads!inner' : 'leads';
}

function buildListQuery(supabase, tenantId, filters, limit, cursor) {
  const query = buildConversationsQuery(supabase, tenantId, filters, {
    select: `${CONVERSATION_SELECT}, ${leadsJoinFragment(filters)}(${LEADS_SELECT})`,
  })
    .order('last_message_at', { ascending: false })
    .order('id', { ascending: false })
    .order('updated_at', { ascending: false, foreignTable: 'leads' })
    .range(0, limit); // overfetch by 1 for hasMore
  return applyCursor(query, cursor);
}

function buildConversationCountQuery(supabase, tenantId, filters) {
  return buildConversationsQuery(supabase, tenantId, filters, {
    select: `id, contact:contacts!inner(id), ${leadsJoinFragment(filters)}(id)`,
    count: true,
  });
}

// Quantity lives inside leads.color_quantity JSON, so the path must always
// inner-join leads and filter in JS. Lead-less convs naturally excluded.
function buildQuantityScanQuery(supabase, tenantId, filters, from, to) {
  return buildConversationsQuery(supabase, tenantId, filters, {
    select: `${CONVERSATION_SELECT}, leads!inner(${LEADS_SELECT})`,
  })
    .order('last_message_at', { ascending: false })
    .order('id', { ascending: false })
    .order('updated_at', { ascending: false, foreignTable: 'leads' })
    .range(from, to);
}

// Leads-centric count that still respects every active filter.
function buildLeadCountQuery(supabase, tenantId, filters) {
  let query = supabase.from('leads').select(`
    id,
    contact:contacts!inner(id),
    conversation:conversations!inner(id, is_human_takeover, last_message_at)
  `, { count: 'exact', head: true })
    .eq('tenant_id', tenantId);

  query = applyLeadFilters(query, filters, '');
  query = applyConversationFilters(query, filters, { foreignTable: 'conversation' });
  query = applyContactFilters(query, filters, { conversationIdCol: 'conversation_id' });
  return query;
}

const EMPTY_ROUTE_BUCKETS = { HUMAN_NOW: 0, CONTINUE: 0, FAQ_END: 0 };

// Single scan that yields both the distinct contact count and the route-bucket
// distribution. resolved_route 现在直接来自视图列，省掉了原本"扫 leads + 在
// JS 里推断最新 route"的逻辑。重要：route bar 自己的 count 必须反映"全部 route
// 的整体分布"，所以这里显式剥掉 resolvedRoute filter，否则切到 HUMAN_NOW tab
// 会让 routeBuckets 全部归零除了 HUMAN_NOW。
async function fetchAggregates(supabase, tenantId, filters) {
  const filtersNoRoute = { ...filters, resolvedRoute: null };
  const ids = new Set();
  const routeBuckets = { ...EMPTY_ROUTE_BUCKETS };
  const selectFragment = `id, contact_id, resolved_route, contact:contacts!inner(id)${hasLeadScopedFilter(filtersNoRoute) ? ', leads!inner(id)' : ''}`;

  for (let offset = 0; ; offset += CONTACT_ID_BATCH) {
    const query = buildConversationsQuery(supabase, tenantId, filtersNoRoute, { select: selectFragment })
      .order('id', { ascending: true })
      .range(offset, offset + CONTACT_ID_BATCH - 1);
    const { data } = throwIfError(await query);
    const batch = data || [];
    for (const row of batch) {
      if (row.contact_id) ids.add(row.contact_id);
      const resolved = row.resolved_route || 'CONTINUE';
      if (resolved in routeBuckets) routeBuckets[resolved] += 1;
    }
    if (batch.length < CONTACT_ID_BATCH) break;
  }
  return { totalContacts: ids.size, routeBuckets };
}

/* ─────────────────────────  quantity path  ───────────────────────── */

function filterByQuantity(rows, filters) {
  const out = [];
  for (const conv of rows || []) {
    const matching = filterLeadsByQuantity(conv.leads || [], filters);
    if (matching.length > 0) out.push({ ...conv, leads: matching });
  }
  return out;
}

async function fetchAllQuantityFiltered(supabase, tenantId, filters) {
  const rows = [];
  for (let offset = 0; ; offset += FULL_SCAN_BATCH_SIZE) {
    const { data } = throwIfError(
      await buildQuantityScanQuery(supabase, tenantId, filters, offset, offset + FULL_SCAN_BATCH_SIZE - 1)
    );
    const batch = data || [];
    if (batch.length === 0) break;
    rows.push(...filterByQuantity(batch, filters));
    if (batch.length < FULL_SCAN_BATCH_SIZE) break;
  }
  return rows;
}

function rowBeforeCursor(row, cursor) {
  if (!cursor) return true;
  const ts = row?.last_message_at || '';
  if (ts < cursor.cursorTs) return true;
  if (ts > cursor.cursorTs) return false;
  return String(row?.id || '') < String(cursor.cursorId);
}

/* ─────────────────────────  mappers  ───────────────────────── */

const LEAD_PASSTHROUGH_FIELDS = [
  'id', 'conversation_id',
  'conversation_intent', 'conversation_intent_summary',
  'route', 'handoff_summary', 'updated_at',
];

// 业务字段以前在 leads 表硬编码列里，现统一从 details 读；输出 shape 保留扁平
// 形态以兼容前端契约（前端读 lead.brand / lead.car_model 等）。
const LEAD_BUSINESS_FIELDS_FROM_DETAILS = [
  'brand', 'car_model', 'product_name',
  'destination_country', 'destination_port',
  'qty_bucket', 'color_quantity',
  'buyer_type', 'timeline', 'loading_port',
];

function mapLead(lead, contact) {
  const d = lead.details || {};
  const out = {};
  for (const f of LEAD_PASSTHROUGH_FIELDS) out[f] = lead[f];
  for (const f of LEAD_BUSINESS_FIELDS_FROM_DETAILS) out[f] = d[f] ?? null;
  out.incoterm = d.international_commercial_term ?? null;  // 列名 ↔ details key 别名
  out.wa_id = contact?.wa_id || null;
  out.company_name = contact?.company_name || null;
  out.inquiry_quality = lead.inquiry_quality || 'GOOD';
  out.business_value = lead.business_value || 'LOW';
  out.details = lead.details || {};
  out.product_line = lead.product_line || null;
  out.lead_data = {
    destination_country: d.destination_country || null,
    destination_port: d.destination_port || null,
    brand: d.brand || null,
    qty_bucket: d.qty_bucket || null,
    car_model: d.car_model || null,
    company_name: contact?.company_name || null,
    buyer_type: d.buyer_type || null,
    timeline: d.timeline || null,
    color_quantity: d.color_quantity || null,
  };
  return out;
}

function composeDisplayName(contact) {
  const parts = [contact?.name, contact?.company_name].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function mapConversationGroup(conversation) {
  const contact = conversation.contact || null;
  const leads = (conversation.leads || [])
    .map((lead) => mapLead(lead, contact))
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  const latest = leads[0] || null;

  // resolved_route 来自 conversations_with_resolved_route 视图（is_human_takeover
  // 覆盖 + 最新 lead.route + CONTINUE fallback），跟 route bar 的服务端筛选用同
  // 一份事实源头，确保卡片上 RouteTag 与 tab 过滤结果不会打架。视图列缺失时
  // (e.g. 历史 test fixture)，退化到原 JS 推断保险。
  const resolvedRoute = conversation.resolved_route
    || (conversation.is_human_takeover ? 'HUMAN_NOW' : (latest?.route || 'CONTINUE'));
  const productLine = latest?.product_line || null;

  return {
    meta: {
      conversation_id: conversation.id,
      contact_id: conversation.contact_id || null,
      wa_id: contact?.wa_id || null,
      name: composeDisplayName(contact),
      inquiry_quality: latest?.inquiry_quality || null,
      business_value: latest?.business_value || null,
      conversation_intent: latest?.conversation_intent || null,
      conversation_intent_summary: latest?.conversation_intent_summary || null,
      route: resolvedRoute,
      handoff_summary: latest?.handoff_summary || null,
      product_line: productLine,
      is_human_takeover: !!conversation.is_human_takeover,
      wa_phone_number_id: conversation.wa_phone_number_id || null,
      meta_ad_id: conversation.meta_ad_id || null,
      last_message_at: conversation.last_message_at,
    },
    leads,
  };
}

/* ─────────────────────────  response shaping  ───────────────────────── */

function cursorFromRow(row) {
  return row ? { cursorTs: row.last_message_at, cursorId: row.id } : null;
}

function emptyResponse() {
  return NextResponse.json({
    groups: [],
    hasMore: false,
    nextCursor: null,
    totalContacts: 0,
    totalConversations: 0,
    totalLeads: 0,
    routeBuckets: { ...EMPTY_ROUTE_BUCKETS },
  });
}

function paginatedResponse(rows, limit, counts) {
  const pageRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return NextResponse.json({
    groups: pageRows.map(mapConversationGroup),
    hasMore,
    nextCursor: hasMore ? cursorFromRow(pageRows[pageRows.length - 1]) : null,
    ...counts,
  });
}

/* ─────────────────────────  handler  ───────────────────────── */

function aggregateRouteBuckets(rows) {
  const buckets = { ...EMPTY_ROUTE_BUCKETS };
  for (const conv of rows) {
    const resolved = conv.resolved_route || 'CONTINUE';
    if (resolved in buckets) buckets[resolved] += 1;
  }
  return buckets;
}

async function handleQuantityBranch(supabase, tenantId, filters, limit, cursor) {
  // route bar 切 tab 不影响 routeBuckets 的整体分布，且 quantity 路径只扫一次，
  // 所以这里也剥掉 resolvedRoute filter 跑完整集合，再 JS 侧用 resolved_route 做
  // 二次过滤，让显示口径跟 standard 分支一致。
  const filtersNoRoute = { ...filters, resolvedRoute: null };
  const rows = await fetchAllQuantityFiltered(supabase, tenantId, filtersNoRoute);
  const routeBuckets = aggregateRouteBuckets(rows);
  const filtered = filters.resolvedRoute
    ? rows.filter((r) => (r.resolved_route || 'CONTINUE') === filters.resolvedRoute)
    : rows;
  const visible = filtered.filter((r) => rowBeforeCursor(r, cursor));

  return paginatedResponse(visible, limit, {
    totalContacts: new Set(filtered.map((r) => r.contact_id).filter(Boolean)).size,
    // route bar 的「全部」chip 期望反映"非路由 filter 下"的总对话数；用未经
    // resolvedRoute 二次过滤的 rows.length，跟 standard 分支语义对齐。
    totalConversations: rows.length,
    totalLeads: filtered.reduce((n, c) => n + (c.leads?.length || 0), 0),
    routeBuckets,
  });
}

async function handleStandardBranch(supabase, tenantId, filters, limit, cursor) {
  // 列表查询保留 resolvedRoute（点 tab 就只看那个路由的对话），但 count 类
  // 聚合查询必须剥掉 resolvedRoute：route bar 的「全部」chip 和 KPI 条「对话」
  // 期望反映"应用全部 *非路由* filter 的对话总数"。否则点「人工跟进中」会让
  // 「全部」collapse 成人工那个数，看起来像 bug。totalLeads 走 leads-base
  // 查询，因为 PostgREST 嵌套限制本来就拿不到 resolved_route，天然
  // route-independent，不用动。
  const filtersNoRoute = { ...filters, resolvedRoute: null };
  const [dataRes, convCountRes, leadsCountRes, aggregates] =
    await Promise.all([
      buildListQuery(supabase, tenantId, filters, limit, cursor),
      buildConversationCountQuery(supabase, tenantId, filtersNoRoute),
      buildLeadCountQuery(supabase, tenantId, filters),
      fetchAggregates(supabase, tenantId, filters),
    ]);

  for (const r of [dataRes, convCountRes, leadsCountRes]) throwIfError(r);

  return paginatedResponse(dataRes.data || [], limit, {
    totalContacts: aggregates.totalContacts,
    totalConversations: convCountRes.count || 0,
    totalLeads: leadsCountRes.count || 0,
    routeBuckets: aggregates.routeBuckets,
  });
}

export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const supabase = await createClient();
    const { tenantId } = ctx;

    const { searchParams } = new URL(request.url);
    const filters = parseFilters(searchParams);
    const limit = parseLimit(searchParams);
    const cursor = parseCursor(searchParams);

    // Resolve free-text customer search into a conversation_id set so downstream
    // queries can union contact-field matches with leads.destination_country
    // matches (cross-table OR can't be expressed inline in PostgREST).
    if (filters.customer.trim()) {
      filters._customerConvIds = await resolveCustomerConvIds(supabase, tenantId, filters.customer);
      if (filters._customerConvIds.length === 0) return emptyResponse();
    }

    return hasActiveQuantityFilter(filters)
      ? await handleQuantityBranch(supabase, tenantId, filters, limit, cursor)
      : await handleStandardBranch(supabase, tenantId, filters, limit, cursor);
  } catch (error) {
    console.error('Error listing inquiries:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch inquiries' },
      { status: 500 }
    );
  }
}
