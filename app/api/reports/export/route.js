import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase-server';
import supabase from '@/lib/supabase';
import { demoGuard } from '@/lib/demo-mode';

const VALID_TYPES = new Set(['leads', 'campaign', 'analytics']);
const VALID_FORMATS = new Set(['csv', 'xlsx']);
const MAX_EXPORT_ROWS = 10000;

function parseRequestParams(request) {
  const { searchParams } = new URL(request.url);
  const type = (searchParams.get('type') || 'leads').toLowerCase();
  const format = (searchParams.get('format') || 'csv').toLowerCase();
  const rawDays = Number.parseInt(searchParams.get('days') || '30', 10);
  const days = Number.isNaN(rawDays) || rawDays <= 0 ? 30 : rawDays;

  return { type, format, days };
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

function escapeCsvCell(value) {
  const normalized = value === null || value === undefined ? '' : String(value);

  if (!/[",\n\r]/.test(normalized)) {
    return normalized;
  }

  return `"${normalized.replace(/"/g, '""')}"`;
}

function buildCsvBuffer(columns, rows) {
  const lines = [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => escapeCsvCell(row[column])).join(',')),
  ];

  return new TextEncoder().encode(`\uFEFF${lines.join('\r\n')}`);
}

function buildStream(payload) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(payload);
      controller.close();
    },
  });
}

function buildFilename(type, extension) {
  const date = new Date().toISOString().split('T')[0];
  return `"report-${type}-${date}.${extension}"`;
}

function formatPercent(value) {
  return `${Math.round(value)}%`;
}

function resolveLeadContact(lead) {
  return lead.contact?.company_name
    || lead.contact?.name
    || lead.contact?.wa_id
    || '';
}

async function getLeadsRows(fromISO, toISO) {
  const { data, error } = await supabase
    .from('leads')
    .select(`
      id,
      created_at,
      inquiry_quality,
      business_value,
      route,
      destination_country,
      car_model,
      product_name,
      qty_bucket,
      contact:contacts(
        name,
        company_name,
        wa_id
      )
    `)
    .gte('created_at', fromISO)
    .lte('created_at', toISO)
    .order('created_at', { ascending: false })
    .limit(MAX_EXPORT_ROWS);

  if (error) throw error;

  return (data || []).map((lead) => ({
    Contact: resolveLeadContact(lead),
    Country: lead.destination_country || '',
    Product: lead.car_model || lead.product_name || '',
    Quantity: lead.qty_bucket || '',
    Quality: lead.inquiry_quality || '',
    'Business Value': lead.business_value || '',
    Route: lead.route || '',
    'Created At': lead.created_at || '',
  }));
}

function chunkValues(values, size) {
  const chunks = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

async function getCampaignRows(fromISO, toISO) {
  const { data: conversations, error: conversationsError } = await supabase
    .from('conversations')
    .select('id, meta_ad_id, created_at, last_message_at')
    .not('meta_ad_id', 'is', null)
    .gte('created_at', fromISO)
    .lte('created_at', toISO)
    .order('created_at', { ascending: false })
    .limit(MAX_EXPORT_ROWS);

  if (conversationsError) throw conversationsError;

  const adMap = new Map();
  const conversationMetaAdMap = new Map();

  for (const conversation of conversations || []) {
    const metaAdId = String(conversation.meta_ad_id || '').trim();
    if (!metaAdId) continue;

    conversationMetaAdMap.set(conversation.id, metaAdId);

    if (!adMap.has(metaAdId)) {
      adMap.set(metaAdId, {
        metaAdId,
        conversationCount: 0,
        qualifyConversationIds: new Set(),
        proofConversationIds: new Set(),
        lastActivity: null,
      });
    }

    const bucket = adMap.get(metaAdId);
    bucket.conversationCount += 1;

    const lastActivity = conversation.last_message_at || conversation.created_at || null;
    if (!bucket.lastActivity || (lastActivity && lastActivity > bucket.lastActivity)) {
      bucket.lastActivity = lastActivity;
    }
  }

  const conversationIds = Array.from(conversationMetaAdMap.keys());
  const leadResponses = conversationIds.length > 0
    ? await Promise.all(
        chunkValues(conversationIds, 200).map((ids) => (
          supabase
            .from('leads')
            .select('conversation_id, inquiry_quality')
            .in('conversation_id', ids)
            .limit(MAX_EXPORT_ROWS)
        ))
      )
    : [];

  for (const response of leadResponses) {
    if (response.error) throw response.error;
  }

  const leads = leadResponses.flatMap((response) => response.data || []);

  for (const lead of leads) {
    const conversationId = lead.conversation_id || null;
    const metaAdId = conversationId ? conversationMetaAdMap.get(conversationId) : null;
    if (!metaAdId) continue;

    const bucket = adMap.get(metaAdId);
    const quality = String(lead.inquiry_quality || '').toUpperCase();

    if (conversationId && quality === 'QUALIFY') {
      bucket.qualifyConversationIds.add(conversationId);
    }

    if (conversationId && quality === 'PROOF') {
      bucket.proofConversationIds.add(conversationId);
    }
  }

  return Array.from(adMap.values())
    .map((bucket) => ({
      'Ad ID': bucket.metaAdId,
      Conversations: bucket.conversationCount,
      'Qualify Rate': formatPercent(
        bucket.conversationCount > 0
          ? (bucket.qualifyConversationIds.size / bucket.conversationCount) * 100
          : 0
      ),
      'Proof Rate': formatPercent(
        bucket.conversationCount > 0
          ? (bucket.proofConversationIds.size / bucket.conversationCount) * 100
          : 0
      ),
      'Last Activity': bucket.lastActivity || '',
    }))
    .sort((a, b) => {
      if (b.Conversations !== a.Conversations) {
        return b.Conversations - a.Conversations;
      }

      return String(a['Ad ID']).localeCompare(String(b['Ad ID']));
    });
}

function toDateKey(value) {
  return value ? value.split('T')[0] : null;
}

function buildDateSeries(fromDate, toDate) {
  const dates = [];
  const cursor = new Date(fromDate);

  while (cursor <= toDate) {
    dates.push(cursor.toISOString().split('T')[0]);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return dates;
}

async function getAnalyticsRows(fromDate, toDate, fromISO, toISO) {
  const [conversationsResponse, leadsResponse] = await Promise.all([
    supabase
      .from('conversations')
      .select('id, created_at')
      .gte('created_at', fromISO)
      .lte('created_at', toISO)
      .limit(MAX_EXPORT_ROWS),
    supabase
      .from('leads')
      .select('conversation_id, inquiry_quality, created_at')
      .gte('created_at', fromISO)
      .lte('created_at', toISO)
      .limit(MAX_EXPORT_ROWS),
  ]);

  if (conversationsResponse.error) throw conversationsResponse.error;
  if (leadsResponse.error) throw leadsResponse.error;

  const conversations = conversationsResponse.data || [];
  const leads = leadsResponse.data || [];

  const dates = buildDateSeries(fromDate, toDate);
  const conversationCounts = {};
  const leadCounts = {};
  const qualifyCounts = {};
  const proofCounts = {};
  const conversationDateMap = {};
  const qualifyConversationIdsByDate = {};

  for (const conversation of conversations) {
    const dateKey = toDateKey(conversation.created_at);
    if (!dateKey) continue;

    conversationCounts[dateKey] = (conversationCounts[dateKey] || 0) + 1;
    conversationDateMap[conversation.id] = dateKey;
  }

  for (const lead of leads) {
    const leadDate = toDateKey(lead.created_at);
    if (leadDate) {
      leadCounts[leadDate] = (leadCounts[leadDate] || 0) + 1;
    }

    const quality = String(lead.inquiry_quality || '').toUpperCase();
    if (leadDate && quality === 'QUALIFY') {
      qualifyCounts[leadDate] = (qualifyCounts[leadDate] || 0) + 1;
    }
    if (leadDate && quality === 'PROOF') {
      proofCounts[leadDate] = (proofCounts[leadDate] || 0) + 1;
    }

    if (!['QUALIFY', 'PROOF'].includes(quality)) continue;

    const conversationDate = conversationDateMap[lead.conversation_id];
    if (!conversationDate) continue;

    if (!qualifyConversationIdsByDate[conversationDate]) {
      qualifyConversationIdsByDate[conversationDate] = new Set();
    }
    qualifyConversationIdsByDate[conversationDate].add(lead.conversation_id);
  }

  return dates.map((date) => {
    const newConversations = conversationCounts[date] || 0;
    const qualifiedConversations = qualifyConversationIdsByDate[date]?.size || 0;

    return {
      Date: date,
      'New Conversations': newConversations,
      'New Leads': leadCounts[date] || 0,
      'Qualify Count': qualifyCounts[date] || 0,
      'Proof Count': proofCounts[date] || 0,
      'Qualify Rate': formatPercent(
        newConversations > 0 ? (qualifiedConversations / newConversations) * 100 : 0
      ),
    };
  });
}

function getDemoRows(type) {
  if (type === 'campaign') {
    return [{
      'Ad ID': 'demo-ad-001',
      Conversations: 12,
      'Qualify Rate': '25%',
      'Proof Rate': '8%',
      'Last Activity': new Date().toISOString(),
    }];
  }

  if (type === 'analytics') {
    return [{
      Date: new Date().toISOString().split('T')[0],
      'New Conversations': 8,
      'New Leads': 4,
      'Qualify Count': 2,
      'Proof Count': 1,
      'Qualify Rate': '25%',
    }];
  }

  return [{
    Contact: 'Demo Contact',
    Country: 'China',
    Product: 'Demo Product',
    Quantity: '1-5',
    Quality: 'QUALIFY',
    'Business Value': 'HIGH',
    Route: 'HUMAN_NOW',
    'Created At': new Date().toISOString(),
  }];
}

async function getExportRows(type, range, useDemoData) {
  if (useDemoData) {
    return getDemoRows(type);
  }

  if (type === 'campaign') {
    return getCampaignRows(range.fromISO, range.toISO);
  }

  if (type === 'analytics') {
    return getAnalyticsRows(range.fromDate, range.toDate, range.fromISO, range.toISO);
  }

  return getLeadsRows(range.fromISO, range.toISO);
}

function buildCsvResponse(type, columns, rows, extraHeaders = {}) {
  const payload = buildCsvBuffer(columns, rows);

  return new Response(buildStream(payload), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename=${buildFilename(type, 'csv')}`,
      ...extraHeaders,
    },
  });
}

async function buildXlsxResponse(type, columns, rows) {
  const xlsxModule = await import('xlsx');
  const xlsx = xlsxModule.default || xlsxModule;
  const worksheet = xlsx.utils.json_to_sheet(rows, { header: columns });
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Report');

  const payload = xlsx.write(workbook, {
    type: 'buffer',
    bookType: 'xlsx',
  });

  return new Response(buildStream(payload), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename=${buildFilename(type, 'xlsx')}`,
    },
  });
}

export async function GET(request) {
  try {
    const isDemoMode = Boolean(demoGuard({ success: true }));
    const authClient = await createClient();
    const { data: { user } } = await authClient.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { type, format, days } = parseRequestParams(request);

    if (!VALID_TYPES.has(type)) {
      return NextResponse.json(
        { error: "Invalid type. Expected one of: 'leads', 'campaign', 'analytics'" },
        { status: 400 }
      );
    }

    if (!VALID_FORMATS.has(format)) {
      return NextResponse.json(
        { error: "Invalid format. Expected one of: 'csv', 'xlsx'" },
        { status: 400 }
      );
    }

    const range = buildDateRange(days);
    const rows = await getExportRows(type, range, isDemoMode);
    const columns = rows.length > 0 ? Object.keys(rows[0]) : (
      type === 'campaign'
        ? ['Ad ID', 'Conversations', 'Qualify Rate', 'Proof Rate', 'Last Activity']
        : type === 'analytics'
          ? ['Date', 'New Conversations', 'New Leads', 'Qualify Count', 'Proof Count', 'Qualify Rate']
          : ['Contact', 'Country', 'Product', 'Quantity', 'Quality', 'Business Value', 'Route', 'Created At']
    );

    if (format === 'csv') {
      return buildCsvResponse(type, columns, rows);
    }

    try {
      return await buildXlsxResponse(type, columns, rows);
    } catch (error) {
      console.warn('[reports/export] xlsx export unavailable, falling back to csv:', error);
      return buildCsvResponse(type, columns, rows, {
        'X-Export-Warning': 'xlsx unavailable; returned csv fallback',
      });
    }
  } catch (error) {
    console.error('[reports/export] Error:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to export report' },
      { status: 500 }
    );
  }
}
