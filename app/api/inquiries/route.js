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

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const FULL_SCAN_BATCH_SIZE = 200;

function parseFilters(searchParams) {
  const dateFrom = searchParams.get('dateFrom') || '';
  const dateTo = searchParams.get('dateTo') || '';
  const quantityRange = normalizeQuantityFilter({
    quantityMin: searchParams.get('quantityMin'),
    quantityMax: searchParams.get('quantityMax'),
  });

  return {
    inquiryQualities: parseMultiSelectParams(searchParams, 'inquiryQuality', INQUIRY_QUALITY_OPTIONS),
    businessValues: parseMultiSelectParams(searchParams, 'businessValue', BUSINESS_VALUE_OPTIONS),
    routes: parseMultiSelectParams(searchParams, 'route', ROUTE_OPTIONS),
    customer: searchParams.get('customer') || '',
    waPrefix: searchParams.get('waPrefix') || '',
    country: searchParams.get('country') || 'all',
    model: searchParams.get('model') || 'all',
    dateFrom: Number.isNaN(Date.parse(dateFrom)) ? '' : dateFrom,
    dateTo: Number.isNaN(Date.parse(dateTo)) ? '' : dateTo,
    agentIds: searchParams.getAll('agentIds').filter(Boolean),
    ...quantityRange,
  };
}

function parseLimit(searchParams) {
  const raw = Number.parseInt(searchParams.get('limit') || `${DEFAULT_LIMIT}`, 10);
  if (Number.isNaN(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
}

function applyLeadFilters(query, filters) {
  if (filters.inquiryQualities.length > 0) {
    query = query.in('leads.inquiry_quality', filters.inquiryQualities);
  }

  if (filters.businessValues.length > 0) {
    query = query.in('leads.business_value', filters.businessValues);
  }

  if (filters.routes.length > 0) {
    query = query.in('leads.route', filters.routes);
  }

  if (filters.customer.trim()) {
    query = query.ilike('contact.company_name', `%${filters.customer.trim()}%`);
  }

  if (filters.waPrefix.trim()) {
    const pattern = /[%_]/.test(filters.waPrefix)
      ? filters.waPrefix.trim()
      : `${filters.waPrefix.trim()}%`;
    query = query.ilike('contact.wa_id', pattern);
  }

  if (filters.country !== 'all') {
    query = query.eq('leads.destination_country', filters.country);
  }

  if (filters.model !== 'all') {
    query = query.eq('leads.car_model', filters.model);
  }

  if (filters.agentIds.length > 0) {
    query = query.in('leads.agent_id', filters.agentIds);
  }

  return query;
}

function applyDateRangeFilters(query, filters, column) {
  if (filters.dateFrom) {
    query = query.gte(column, filters.dateFrom);
  }

  if (filters.dateTo) {
    query = query.lte(column, filters.dateTo);
  }

  return query;
}

function applyConversationCursor(query, searchParams) {
  const cursorTs = searchParams?.get('cursorTs');
  const cursorId = searchParams?.get('cursorId');

  if (!cursorTs || !cursorId) {
    return query;
  }

  return query.or(
    `last_message_at.lt.${cursorTs},and(last_message_at.eq.${cursorTs},id.lt.${cursorId})`
  );
}

function extractCursor(searchParams) {
  const cursorTs = searchParams.get('cursorTs');
  const cursorId = searchParams.get('cursorId');

  return cursorTs && cursorId
    ? { cursorTs, cursorId }
    : null;
}

function buildConversationDataQuery(supabase, filters, limit, searchParams) {
  let query = supabase
    .from('conversations')
    .select(`
      id,
      status,
      last_message_at,
      message_count,
      contact:contacts!inner(
        wa_id,
        company_name,
        name
      ),
      leads!inner(
        id,
        conversation_id,
        inquiry_quality,
        business_value,
        conversation_intent,
        conversation_intent_summary,
        route,
        handoff_summary,
        updated_at,
        approved,
        approved_at,
        brand,
        car_model,
        product_name,
        destination_country,
        destination_port,
        qty_bucket,
        color_quantity,
        buyer_type,
        timeline,
        incoterm,
        loading_port,
        details,
        agent_id,
        agent:agents(
          id,
          product_line
        )
      )
    `)
    .order('last_message_at', { ascending: false })
    .order('id', { ascending: false })
    .order('updated_at', { ascending: false, foreignTable: 'leads' })
    .range(0, limit);

  query = applyLeadFilters(query, filters);
  query = applyDateRangeFilters(query, filters, 'last_message_at');
  return applyConversationCursor(query, searchParams);
}

function buildConversationCountQuery(supabase, filters) {
  let query = supabase
    .from('conversations')
    .select(`
      id,
      contact:contacts!inner(company_name, wa_id),
      leads!inner(id)
    `, { count: 'exact', head: true });

  query = applyLeadFilters(query, filters);
  return applyDateRangeFilters(query, filters, 'last_message_at');
}

function buildLeadCountQuery(supabase, filters, approvedOnly = false) {
  let query = supabase
    .from('leads')
    .select(`
      id,
      contact:contacts!inner(company_name, wa_id),
      conversation:conversations!inner(last_message_at)
    `, { count: 'exact', head: true });

  if (filters.inquiryQualities.length > 0) {
    query = query.in('inquiry_quality', filters.inquiryQualities);
  }

  if (filters.businessValues.length > 0) {
    query = query.in('business_value', filters.businessValues);
  }

  if (filters.routes.length > 0) {
    query = query.in('route', filters.routes);
  }

  if (filters.customer.trim()) {
    query = query.ilike('contact.company_name', `%${filters.customer.trim()}%`);
  }

  if (filters.waPrefix.trim()) {
    const pattern = /[%_]/.test(filters.waPrefix)
      ? filters.waPrefix.trim()
      : `${filters.waPrefix.trim()}%`;
    query = query.ilike('contact.wa_id', pattern);
  }

  if (filters.country !== 'all') {
    query = query.eq('destination_country', filters.country);
  }

  if (filters.model !== 'all') {
    query = query.eq('car_model', filters.model);
  }

  if (filters.agentIds.length > 0) {
    query = query.in('agent_id', filters.agentIds);
  }

  if (approvedOnly) {
    query = query.eq('approved', true);
  }

  query = applyDateRangeFilters(query, filters, 'conversation.last_message_at');
  return query;
}

function buildFullScanConversationQuery(supabase, filters, from, to) {
  let query = supabase
    .from('conversations')
    .select(`
      id,
      status,
      last_message_at,
      message_count,
      contact:contacts!inner(
        wa_id,
        company_name,
        name
      ),
      leads!inner(
        id,
        conversation_id,
        inquiry_quality,
        business_value,
        conversation_intent,
        conversation_intent_summary,
        route,
        handoff_summary,
        updated_at,
        approved,
        approved_at,
        brand,
        car_model,
        product_name,
        destination_country,
        destination_port,
        qty_bucket,
        color_quantity,
        buyer_type,
        timeline,
        incoterm,
        loading_port,
        details,
        agent_id,
        agent:agents(
          id,
          product_line
        )
      )
    `)
    .order('last_message_at', { ascending: false })
    .order('id', { ascending: false })
    .order('updated_at', { ascending: false, foreignTable: 'leads' })
    .range(from, to);

  query = applyLeadFilters(query, filters);
  return applyDateRangeFilters(query, filters, 'last_message_at');
}

function filterConversationRowsByQuantity(rows, filters) {
  return (rows || [])
    .map((conversation) => {
      const matchingLeads = filterLeadsByQuantity(conversation.leads || [], filters);
      if (matchingLeads.length === 0) return null;

      return {
        ...conversation,
        leads: matchingLeads,
      };
    })
    .filter(Boolean);
}

function rowMatchesCursor(row, cursor) {
  if (!cursor?.cursorTs || !cursor?.cursorId) return true;

  const rowTimestamp = row?.last_message_at || '';
  if (rowTimestamp < cursor.cursorTs) return true;
  if (rowTimestamp > cursor.cursorTs) return false;
  return String(row?.id || '') < String(cursor.cursorId);
}

async function fetchAllQuantityFilteredConversations(supabase, filters) {
  const rows = [];
  let offset = 0;

  while (true) {
    const { data, error } = await buildFullScanConversationQuery(
      supabase,
      filters,
      offset,
      offset + FULL_SCAN_BATCH_SIZE - 1
    );

    if (error) throw error;

    const batch = data || [];
    if (batch.length === 0) break;

    rows.push(...filterConversationRowsByQuantity(batch, filters));

    if (batch.length < FULL_SCAN_BATCH_SIZE) break;
    offset += FULL_SCAN_BATCH_SIZE;
  }

  return rows;
}

function mapLead(lead, contact) {
  return {
    id: lead.id,
    conversation_id: lead.conversation_id,
    wa_id: contact?.wa_id || null,
    company_name: contact?.company_name || null,
    inquiry_quality: lead.inquiry_quality || 'GOOD',
    business_value: lead.business_value || 'LOW',
    conversation_intent: lead.conversation_intent,
    conversation_intent_summary: lead.conversation_intent_summary,
    route: lead.route,
    handoff_summary: lead.handoff_summary,
    updated_at: lead.updated_at,
    approved: lead.approved,
    approved_at: lead.approved_at,
    brand: lead.brand,
    car_model: lead.car_model,
    product_name: lead.product_name,
    destination_country: lead.destination_country,
    destination_port: lead.destination_port,
    qty_bucket: lead.qty_bucket,
    color_quantity: lead.color_quantity,
    buyer_type: lead.buyer_type,
    timeline: lead.timeline,
    incoterm: lead.incoterm,
    loading_port: lead.loading_port,
    details: lead.details || {},
    agent_id: lead.agent_id || lead.agent?.id || null,
    agent_product_line: lead.agent?.product_line || null,
    lead_data: {
      destination_country: lead.destination_country,
      destination_port: lead.destination_port,
      qty_bucket: lead.qty_bucket,
      car_model: lead.car_model,
      company_name: contact?.company_name || null,
      buyer_type: lead.buyer_type,
      timeline: lead.timeline,
      color_quantity: lead.color_quantity,
    },
  };
}

function mapConversationGroup(conversation) {
  const contact = conversation.contact || null;
  const leads = (conversation.leads || [])
    .map((lead) => mapLead(lead, contact))
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  const latestLead = leads[0] || {};

  return {
    meta: {
      conversation_id: conversation.id,
      wa_id: contact?.wa_id || null,
      company_name: contact?.company_name || null,
      inquiry_quality: latestLead.inquiry_quality || 'GOOD',
      business_value: latestLead.business_value || 'LOW',
      conversation_intent: latestLead.conversation_intent || null,
      conversation_intent_summary: latestLead.conversation_intent_summary || null,
      route: latestLead.route || null,
      handoff_summary: latestLead.handoff_summary || null,
      agent_product_line: latestLead.agent_product_line || null,
      updated_at: latestLead.updated_at || conversation.last_message_at,
    },
    leads,
  };
}

export async function GET(request) {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const filters = parseFilters(searchParams);
    const limit = parseLimit(searchParams);
    const cursor = extractCursor(searchParams);

    if (hasActiveQuantityFilter(filters)) {
      const matchingRows = await fetchAllQuantityFilteredConversations(supabase, filters);
      const cursorFilteredRows = matchingRows.filter((row) => rowMatchesCursor(row, cursor));
      const pageRows = cursorFilteredRows.slice(0, limit);
      const groups = pageRows.map(mapConversationGroup);
      const hasMore = cursorFilteredRows.length > limit;
      const lastRow = pageRows[pageRows.length - 1];
      const totalLeads = matchingRows.reduce((sum, conversation) => sum + (conversation.leads?.length || 0), 0);
      const approvedCount = matchingRows.reduce(
        (sum, conversation) => sum + (conversation.leads || []).filter((lead) => lead.approved).length,
        0
      );

      return NextResponse.json({
        groups,
        hasMore,
        nextCursor: hasMore && lastRow
          ? {
              cursorTs: lastRow.last_message_at,
              cursorId: lastRow.id,
            }
          : null,
        totalConversations: matchingRows.length,
        totalLeads,
        approvedCount,
      });
    }

    const [dataResult, conversationsCountResult, leadsCountResult, approvedCountResult] = await Promise.all([
      buildConversationDataQuery(supabase, filters, limit, searchParams),
      buildConversationCountQuery(supabase, filters),
      buildLeadCountQuery(supabase, filters),
      buildLeadCountQuery(supabase, filters, true),
    ]);

    if (dataResult.error) throw dataResult.error;
    if (conversationsCountResult.error) throw conversationsCountResult.error;
    if (leadsCountResult.error) throw leadsCountResult.error;
    if (approvedCountResult.error) throw approvedCountResult.error;

    const rows = dataResult.data || [];
    const pageRows = rows.slice(0, limit);
    const groups = pageRows.map(mapConversationGroup);
    const hasMore = rows.length > limit;
    const lastRow = pageRows[pageRows.length - 1];

    return NextResponse.json({
      groups,
      hasMore,
      nextCursor: hasMore && lastRow
        ? {
            cursorTs: lastRow.last_message_at,
            cursorId: lastRow.id,
          }
        : null,
      totalConversations: conversationsCountResult.count || 0,
      totalLeads: leadsCountResult.count || 0,
      approvedCount: approvedCountResult.count || 0,
    });
  } catch (error) {
    console.error('Error listing inquiries:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch inquiries' },
      { status: 500 }
    );
  }
}
