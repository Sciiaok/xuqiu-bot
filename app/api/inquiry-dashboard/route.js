import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import {
  buildDateWindows,
  buildInquiryRecords,
  createDateSeries,
} from '@/lib/inquiry-dashboard';

async function fetchAllPages(buildQuery, pageSize = 1000) {
  const rows = [];
  let from = 0;

  while (true) {
    const to = from + pageSize - 1;
    const { data, error } = await buildQuery().range(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;

    rows.push(...data);

    if (data.length < pageSize) break;
    from += pageSize;
  }

  return rows;
}

async function queryConversations(agentIds, fromISO, toISO) {
  if (agentIds.length === 0) return [];

  const batchSize = 200;
  const conversations = [];

  for (let i = 0; i < agentIds.length; i += batchSize) {
    const batch = agentIds.slice(i, i + batchSize);
    const data = await fetchAllPages(() => (
      supabase
        .from('conversations')
        .select('id, agent_id, created_at')
        .in('agent_id', batch)
        .gte('created_at', fromISO)
        .lte('created_at', toISO)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
    ));

    conversations.push(...data);
  }

  return conversations;
}

async function queryLeads(conversationIds) {
  if (conversationIds.length === 0) return [];

  const batchSize = 200;
  const leads = [];

  for (let i = 0; i < conversationIds.length; i += batchSize) {
    const batch = conversationIds.slice(i, i + batchSize);
    const data = await fetchAllPages(() => (
      supabase
        .from('leads')
        .select('id, inquiry_quality, business_value, conversation_intent, buyer_type, destination_country, car_model, brand, product_name, details, conversation_id, agent_id, created_at')
        .in('conversation_id', batch)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
    ));

    leads.push(...data);
  }

  return leads;
}

function roundRate(numerator, denominator) {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function computeKpi(inquiries) {
  const totalInquiries = inquiries.length;
  const proofInquiries = inquiries.filter(inquiry => inquiry.quality === 'PROOF').length;
  const highValueInquiries = inquiries.filter(inquiry => inquiry.businessValue === 'HIGH').length;

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
    if (!groups[inquiry.date]) {
      groups[inquiry.date] = { total: 0, proof: 0 };
    }
    groups[inquiry.date].total += 1;
    if (inquiry.quality === 'PROOF') {
      groups[inquiry.date].proof += 1;
    }
  }

  return createDateSeries(fromDate, toDate).map(date => ({
    date,
    total: groups[date]?.total || 0,
    proof: groups[date]?.proof || 0,
  }));
}

function buildAgentDistribution(inquiries) {
  const groups = {};

  for (const inquiry of inquiries) {
    const group = groups[inquiry.agentId] || {
      agentName: inquiry.agentName,
      productLine: inquiry.productLine,
      inquiryCount: 0,
      proofCount: 0,
      quality: { PROOF: 0, QUALIFY: 0, GOOD: 0, BAD: 0 },
    };

    group.inquiryCount += 1;
    if (inquiry.quality === 'PROOF') group.proofCount += 1;
    group.quality[inquiry.quality] += 1;
    groups[inquiry.agentId] = group;
  }

  return Object.values(groups)
    .map(group => ({
      ...group,
      proofRate: roundRate(group.proofCount, group.inquiryCount),
    }))
    .sort((left, right) => right.inquiryCount - left.inquiryCount);
}

function buildCountryDistribution(inquiries) {
  const groups = {};

  for (const inquiry of inquiries) {
    const key = inquiry.country || 'Unknown';
    const group = groups[key] || { country: key, inquiryCount: 0, proofCount: 0 };
    group.inquiryCount += 1;
    if (inquiry.quality === 'PROOF') group.proofCount += 1;
    groups[key] = group;
  }

  let rows = Object.values(groups)
    .map(group => ({
      country: group.country,
      inquiryCount: group.inquiryCount,
      proofRate: roundRate(group.proofCount, group.inquiryCount),
    }))
    .sort((left, right) => right.inquiryCount - left.inquiryCount);

  if (rows.length > 10) {
    const top10 = rows.slice(0, 10);
    const others = rows.slice(10);
    top10.push({
      country: 'Others',
      inquiryCount: others.reduce((sum, row) => sum + row.inquiryCount, 0),
      proofRate: 0,
    });
    rows = top10;
  }

  return rows;
}

function buildQualityDistribution(inquiries) {
  const counts = { PROOF: 0, QUALIFY: 0, GOOD: 0, BAD: 0 };

  for (const inquiry of inquiries) {
    counts[inquiry.quality] += 1;
  }

  return Object.entries(counts).map(([name, value]) => ({ name, value }));
}

function buildBuyerTypeDistribution(inquiries) {
  const counts = {};

  for (const inquiry of inquiries) {
    const key = inquiry.buyerType || 'other';
    counts[key] = (counts[key] || 0) + 1;
  }

  return Object.entries(counts)
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value);
}

function buildIntentDistribution(inquiries) {
  const counts = {};

  for (const inquiry of inquiries) {
    const key = inquiry.intent || 'other';
    counts[key] = (counts[key] || 0) + 1;
  }

  return Object.entries(counts)
    .map(([name, value]) => ({ name, value }))
    .sort((left, right) => right.value - left.value);
}

function buildTopProducts(inquiries) {
  const groups = {};

  for (const inquiry of inquiries) {
    if (!inquiry.productName) continue;

    const key = `${inquiry.productName}|||${inquiry.productLine}`;
    const group = groups[key] || {
      productName: inquiry.productName,
      productLine: inquiry.productLine,
      inquiryCount: 0,
      proofCount: 0,
    };

    group.inquiryCount += 1;
    if (inquiry.quality === 'PROOF') group.proofCount += 1;
    groups[key] = group;
  }

  return Object.values(groups)
    .map(group => ({
      productName: group.productName,
      productLine: group.productLine,
      inquiryCount: group.inquiryCount,
      proofRate: roundRate(group.proofCount, group.inquiryCount),
    }))
    .sort((left, right) => right.inquiryCount - left.inquiryCount)
    .slice(0, 10);
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '7', 10);
    const preset = searchParams.get('preset') || '';
    const startDate = searchParams.get('startDate') || '';
    const endDate = searchParams.get('endDate') || '';
    const productLines = (searchParams.get('productLines') || 'vehicle,auto_parts,agri_machinery')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);

    const windows = buildDateWindows({ days, preset, startDate, endDate });

    const { data: agents, error: agentsError } = await supabase
      .from('agents')
      .select('id, name, product_line')
      .in('product_line', productLines);

    if (agentsError) throw agentsError;

    const agentIds = agents.map(agent => agent.id);
    const agentMap = Object.fromEntries(agents.map(agent => [agent.id, agent]));

    if (agentIds.length === 0) {
      return NextResponse.json({
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
        buyerTypeDistribution: [],
        intentDistribution: [],
        topProducts: [],
      });
    }

    const [currentConversations, previousConversations] = await Promise.all([
      queryConversations(agentIds, windows.current.fromISO, windows.current.toISO),
      queryConversations(agentIds, windows.previous.fromISO, windows.previous.toISO),
    ]);

    const [currentLeads, previousLeads] = await Promise.all([
      queryLeads(currentConversations.map(conversation => conversation.id)),
      queryLeads(previousConversations.map(conversation => conversation.id)),
    ]);

    const currentInquiries = buildInquiryRecords({
      conversations: currentConversations,
      leads: currentLeads,
      agentMap,
    });
    const previousInquiries = buildInquiryRecords({
      conversations: previousConversations,
      leads: previousLeads,
      agentMap,
    });

    const currentKpi = computeKpi(currentInquiries);
    const previousKpi = computeKpi(previousInquiries);

    return NextResponse.json({
      kpi: {
        totalInquiries: { current: currentKpi.totalInquiries, previous: previousKpi.totalInquiries },
        proofInquiries: { current: currentKpi.proofInquiries, previous: previousKpi.proofInquiries },
        proofRate: { current: currentKpi.proofRate, previous: previousKpi.proofRate },
        highValueRate: { current: currentKpi.highValueRate, previous: previousKpi.highValueRate },
      },
      dailyTrend: buildDailyTrend(currentInquiries, windows.current.fromDate, windows.current.toDate),
      agentDistribution: buildAgentDistribution(currentInquiries),
      countryDistribution: buildCountryDistribution(currentInquiries),
      qualityDistribution: buildQualityDistribution(currentInquiries),
      buyerTypeDistribution: buildBuyerTypeDistribution(currentInquiries),
      intentDistribution: buildIntentDistribution(currentInquiries),
      topProducts: buildTopProducts(currentInquiries),
    });
  } catch (error) {
    console.error('Inquiry Dashboard API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
