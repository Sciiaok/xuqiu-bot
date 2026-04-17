import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LEADS_SELECT = `
  id, conversation_id, inquiry_quality, business_value,
  conversation_intent, conversation_intent_summary,
  route, handoff_summary, updated_at, approved, approved_at,
  brand, car_model, product_name,
  destination_country, destination_port,
  qty_bucket, color_quantity,
  buyer_type, timeline, incoterm, loading_port,
  details, agent_id,
  agent:agents(id, product_line)
`;

const CONVERSATION_SELECT = `
  id, status, last_message_at, message_count,
  contact_id, agent_id, is_human_takeover, wa_phone_number_id, meta_ad_id,
  contact:contacts!inner(wa_id, company_name, name),
  agent:agents(id, product_line)
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

async function resolveAgentIdsFilter(supabase, rawAgentIds) {
  if (!rawAgentIds?.length) return [];
  const uuids = [];
  const productLines = [];
  for (const value of rawAgentIds) {
    (UUID_RE.test(value) ? uuids : productLines).push(value);
  }
  if (!productLines.length) return uuids;

  const { data } = throwIfError(
    await supabase.from('agents').select('id').in('product_line', productLines)
  );
  return Array.from(new Set([...uuids, ...(data || []).map((row) => row.id)]));
}

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

function parseFilters(sp) {
  const dateFrom = sp.get('dateFrom') || '';
  const dateTo = sp.get('dateTo') || '';
  return {
    // lead-level filters
    inquiryQualities: parseMultiSelectParams(sp, 'inquiryQuality', INQUIRY_QUALITY_OPTIONS),
    businessValues: parseMultiSelectParams(sp, 'businessValue', BUSINESS_VALUE_OPTIONS),
    routes: parseMultiSelectParams(sp, 'route', ROUTE_OPTIONS),
    country: sp.get('country') || 'all',
    model: sp.get('model') || 'all',

    // contact-level filters
    customer: sp.get('customer') || '',
    waPrefix: sp.get('waPrefix') || '',

    // conversation-level filters
    dateFrom: Number.isNaN(Date.parse(dateFrom)) ? '' : dateFrom,
    dateTo: Number.isNaN(Date.parse(dateTo)) ? '' : dateTo,
    agentIds: sp.getAll('agentIds').filter(Boolean),
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
  if (filters.agentIds.length > 0) query = query.in(col('agent_id'), filters.agentIds);
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
  return query;
}

// The `customer` search box matches any of company_name / name / wa_id.
// `waPrefix` is a separate legacy param that still narrows wa_id only.
function applyContactFilters(query, filters, foreignTable = 'contact') {
  const customer = filters.customer.trim();
  if (customer) {
    // PostgREST .or() commas are delimiters — strip them from user input so
    // the expression stays well-formed. Safe for a search box.
    const safe = customer.replace(/,/g, ' ');
    const like = `*${safe}*`;
    query = query.or(
      `company_name.ilike.${like},name.ilike.${like},wa_id.ilike.${like}`,
      { foreignTable },
    );
  }
  if (filters.waPrefix.trim()) {
    query = query.ilike(`${foreignTable}.wa_id`, makeLikePattern(filters.waPrefix));
  }
  return query;
}

function applyLeadFilters(query, filters, prefix = 'leads.') {
  const col = (name) => `${prefix}${name}`;
  if (filters.inquiryQualities.length > 0) query = query.in(col('inquiry_quality'), filters.inquiryQualities);
  if (filters.businessValues.length > 0) query = query.in(col('business_value'), filters.businessValues);
  if (filters.routes.length > 0) query = query.in(col('route'), filters.routes);
  if (filters.country !== 'all') query = query.eq(col('destination_country'), filters.country);
  if (filters.model !== 'all') query = query.eq(col('car_model'), filters.model);
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

function buildConversationsQuery(supabase, filters, { select, count = false }) {
  const base = supabase
    .from('conversations')
    .select(select, count ? { count: 'exact', head: true } : undefined);

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

function buildListQuery(supabase, filters, limit, cursor) {
  const query = buildConversationsQuery(supabase, filters, {
    select: `${CONVERSATION_SELECT}, ${leadsJoinFragment(filters)}(${LEADS_SELECT})`,
  })
    .order('last_message_at', { ascending: false })
    .order('id', { ascending: false })
    .order('updated_at', { ascending: false, foreignTable: 'leads' })
    .range(0, limit); // overfetch by 1 for hasMore
  return applyCursor(query, cursor);
}

function buildConversationCountQuery(supabase, filters) {
  return buildConversationsQuery(supabase, filters, {
    select: `id, contact:contacts!inner(id), ${leadsJoinFragment(filters)}(id)`,
    count: true,
  });
}

// Quantity lives inside leads.color_quantity JSON, so the path must always
// inner-join leads and filter in JS. Lead-less convs naturally excluded.
function buildQuantityScanQuery(supabase, filters, from, to) {
  return buildConversationsQuery(supabase, filters, {
    select: `${CONVERSATION_SELECT}, leads!inner(${LEADS_SELECT})`,
  })
    .order('last_message_at', { ascending: false })
    .order('id', { ascending: false })
    .order('updated_at', { ascending: false, foreignTable: 'leads' })
    .range(from, to);
}

// Leads-centric count that still respects every active filter.
function buildLeadCountQuery(supabase, filters, { approvedOnly = false } = {}) {
  let query = supabase.from('leads').select(`
    id,
    contact:contacts!inner(id),
    conversation:conversations!inner(id, agent_id, is_human_takeover, last_message_at)
  `, { count: 'exact', head: true });

  query = applyLeadFilters(query, filters, '');
  query = applyConversationFilters(query, filters, { foreignTable: 'conversation' });
  query = applyContactFilters(query, filters);
  if (approvedOnly) query = query.eq('approved', true);
  return query;
}

async function fetchDistinctContactCount(supabase, filters) {
  const ids = new Set();
  const selectFragment = `contact_id, contact:contacts!inner(id), ${leadsJoinFragment(filters)}(id)`;

  for (let offset = 0; ; offset += CONTACT_ID_BATCH) {
    const query = buildConversationsQuery(supabase, filters, { select: selectFragment })
      .range(offset, offset + CONTACT_ID_BATCH - 1);
    const { data } = throwIfError(await query);
    const batch = data || [];
    for (const row of batch) if (row.contact_id) ids.add(row.contact_id);
    if (batch.length < CONTACT_ID_BATCH) break;
  }
  return ids.size;
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

async function fetchAllQuantityFiltered(supabase, filters) {
  const rows = [];
  for (let offset = 0; ; offset += FULL_SCAN_BATCH_SIZE) {
    const { data } = throwIfError(
      await buildQuantityScanQuery(supabase, filters, offset, offset + FULL_SCAN_BATCH_SIZE - 1)
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
  'route', 'handoff_summary', 'updated_at', 'approved', 'approved_at',
  'brand', 'car_model', 'product_name',
  'destination_country', 'destination_port',
  'qty_bucket', 'color_quantity',
  'buyer_type', 'timeline', 'incoterm', 'loading_port',
];

function mapLead(lead, contact) {
  const out = {};
  for (const f of LEAD_PASSTHROUGH_FIELDS) out[f] = lead[f];
  out.wa_id = contact?.wa_id || null;
  out.company_name = contact?.company_name || null;
  out.inquiry_quality = lead.inquiry_quality || 'GOOD';
  out.business_value = lead.business_value || 'LOW';
  out.details = lead.details || {};
  out.agent_id = lead.agent_id || lead.agent?.id || null;
  out.agent_product_line = lead.agent?.product_line || null;
  out.lead_data = {
    destination_country: lead.destination_country,
    destination_port: lead.destination_port,
    brand: lead.brand,
    qty_bucket: lead.qty_bucket,
    car_model: lead.car_model,
    company_name: contact?.company_name || null,
    buyer_type: lead.buyer_type,
    timeline: lead.timeline,
    color_quantity: lead.color_quantity,
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

  // is_human_takeover is the authoritative runtime state: a human operator can
  // take over at any time regardless of Claude's routing recommendation stored
  // in lead.route. So HUMAN_NOW always wins when the flag is set; otherwise
  // fall back to lead.route (which may be CONTINUE / NURTURE / FAQ_END).
  const resolvedRoute = conversation.is_human_takeover
    ? 'HUMAN_NOW'
    : (latest?.route || 'CONTINUE');
  const productLine =
    conversation.agent?.product_line || latest?.agent_product_line || null;

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
      agent_product_line: productLine,
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
    approvedCount: 0,
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

async function handleQuantityBranch(supabase, filters, limit, cursor) {
  const rows = await fetchAllQuantityFiltered(supabase, filters);
  const visible = rows.filter((r) => rowBeforeCursor(r, cursor));

  return paginatedResponse(visible, limit, {
    totalContacts: new Set(rows.map((r) => r.contact_id).filter(Boolean)).size,
    totalConversations: rows.length,
    totalLeads: rows.reduce((n, c) => n + (c.leads?.length || 0), 0),
    approvedCount: rows.reduce(
      (n, c) => n + (c.leads || []).filter((l) => l.approved).length,
      0,
    ),
  });
}

async function handleStandardBranch(supabase, filters, limit, cursor) {
  const [dataRes, convCountRes, leadsCountRes, approvedCountRes, totalContacts] =
    await Promise.all([
      buildListQuery(supabase, filters, limit, cursor),
      buildConversationCountQuery(supabase, filters),
      buildLeadCountQuery(supabase, filters),
      buildLeadCountQuery(supabase, filters, { approvedOnly: true }),
      fetchDistinctContactCount(supabase, filters),
    ]);

  for (const r of [dataRes, convCountRes, leadsCountRes, approvedCountRes]) throwIfError(r);

  return paginatedResponse(dataRes.data || [], limit, {
    totalContacts,
    totalConversations: convCountRes.count || 0,
    totalLeads: leadsCountRes.count || 0,
    approvedCount: approvedCountRes.count || 0,
  });
}

export async function GET(request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const filters = parseFilters(searchParams);
    const limit = parseLimit(searchParams);
    const cursor = parseCursor(searchParams);

    const rawAgentIds = searchParams.getAll('agentIds').filter(Boolean);
    filters.agentIds = await resolveAgentIdsFilter(supabase, rawAgentIds);

    // Supply-chain token that maps to zero agents → no conversation can match.
    if (rawAgentIds.length > 0 && filters.agentIds.length === 0) {
      return emptyResponse();
    }

    return hasActiveQuantityFilter(filters)
      ? await handleQuantityBranch(supabase, filters, limit, cursor)
      : await handleStandardBranch(supabase, filters, limit, cursor);
  } catch (error) {
    console.error('Error listing inquiries:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch inquiries' },
      { status: 500 }
    );
  }
}
