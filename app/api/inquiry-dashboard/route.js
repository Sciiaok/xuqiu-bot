import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';

// Intent keys are returned as-is; frontend maps them via i18n

function parseIntents(raw) {
  if (!raw) return [];
  if (typeof raw === 'string' && raw.startsWith('[')) {
    try { raw = JSON.parse(raw).join(','); } catch { raw = raw.replace(/[\[\]"]/g, ''); }
  }
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function getProductName(lead, productLine) {
  const details = lead.details || {};
  switch (productLine) {
    case 'vehicle':
      return lead.car_model || lead.brand || lead.product_name || null;
    case 'auto_parts':
      return details.part_name || lead.product_name || details.oem_code || null;
    case 'agri_machinery':
      return details.machinery_type || lead.product_name || null;
    default:
      return lead.product_name || lead.car_model || null;
  }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '7');
    const startDate = searchParams.get('startDate') || '';
    const endDate = searchParams.get('endDate') || '';
    const productLines = (searchParams.get('productLines') || 'vehicle,auto_parts,agri_machinery')
      .split(',').map(s => s.trim()).filter(Boolean);

    // 1. Compute two time windows: current + previous (equal-length comparison)
    let fromDate, toDate, prevFrom, prevTo;
    if (startDate && endDate) {
      fromDate = new Date(startDate);
      toDate = new Date(endDate);
      toDate.setHours(23, 59, 59, 999);
      const span = toDate - fromDate;
      prevTo = new Date(fromDate.getTime() - 1);
      prevFrom = new Date(prevTo.getTime() - span);
    } else {
      toDate = new Date();
      fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - days);
      fromDate.setHours(0, 0, 0, 0);
      prevTo = new Date(fromDate.getTime() - 1);
      prevFrom = new Date(prevTo);
      prevFrom.setDate(prevFrom.getDate() - days);
      prevFrom.setHours(0, 0, 0, 0);
    }

    const fromISO = fromDate.toISOString();
    const toISO = toDate.toISOString();
    const prevFromISO = prevFrom.toISOString();
    const prevToISO = prevTo.toISOString();

    // 2. Query agents by productLines
    const { data: agents, error: agentsError } = await supabase
      .from('agents')
      .select('id, name, product_line')
      .in('product_line', productLines);
    if (agentsError) throw agentsError;

    const agentIds = agents.map(a => a.id);
    const agentMap = {};
    agents.forEach(a => { agentMap[a.id] = a; });

    if (agentIds.length === 0) {
      return NextResponse.json({
        kpi: { totalInquiries: { current: 0, previous: 0 }, proofInquiries: { current: 0, previous: 0 }, proofRate: { current: 0, previous: 0 }, highValueRate: { current: 0, previous: 0 } },
        dailyTrend: [], agentDistribution: [], countryDistribution: [], qualityDistribution: [],
        buyerTypeDistribution: [], intentDistribution: [], topProducts: [],
      });
    }

    // 3. Query conversations for both periods
    const batchSize = 200;

    async function queryConversations(from, to) {
      const allConvs = [];
      for (let i = 0; i < agentIds.length; i += batchSize) {
        const batch = agentIds.slice(i, i + batchSize);
        const { data, error } = await supabase
          .from('conversations')
          .select('id, agent_id, created_at')
          .in('agent_id', batch)
          .gte('created_at', from)
          .lte('created_at', to)
          .limit(10000);
        if (error) throw error;
        if (data) allConvs.push(...data);
      }
      return allConvs;
    }

    const [currentConvs, prevConvs] = await Promise.all([
      queryConversations(fromISO, toISO),
      queryConversations(prevFromISO, prevToISO),
    ]);

    // 4. Query leads for both periods (batch by conversation_id)
    async function queryLeads(convIds) {
      if (convIds.length === 0) return [];
      const allLeads = [];
      for (let i = 0; i < convIds.length; i += batchSize) {
        const batch = convIds.slice(i, i + batchSize);
        const { data, error } = await supabase
          .from('leads')
          .select('id, inquiry_quality, business_value, conversation_intent, buyer_type, destination_country, car_model, brand, product_name, details, conversation_id, agent_id, created_at')
          .in('conversation_id', batch)
          .limit(10000);
        if (error) throw error;
        if (data) allLeads.push(...data);
      }
      return allLeads;
    }

    const currentConvIds = currentConvs.map(c => c.id);
    const prevConvIds = prevConvs.map(c => c.id);

    const [currentLeads, prevLeads] = await Promise.all([
      queryLeads(currentConvIds),
      queryLeads(prevConvIds),
    ]);

    // Build convId→agentId map from conversations
    const convAgentMap = {};
    currentConvs.forEach(c => { convAgentMap[c.id] = c.agent_id; });

    // 5. Aggregation

    // KPI helpers
    function computeKpi(leads, convs) {
      const convIdsWithLead = new Set(leads.map(l => l.conversation_id));
      const totalInquiries = convIdsWithLead.size;

      const proofConvIds = new Set();
      leads.forEach(l => {
        if (l.inquiry_quality === 'PROOF') proofConvIds.add(l.conversation_id);
      });
      const proofInquiries = proofConvIds.size;
      const proofRate = totalInquiries > 0 ? Math.round((proofInquiries / totalInquiries) * 1000) / 10 : 0;

      const highValueCount = leads.filter(l => l.business_value === 'HIGH').length;
      const highValueRate = leads.length > 0 ? Math.round((highValueCount / leads.length) * 1000) / 10 : 0;

      return { totalInquiries, proofInquiries, proofRate, highValueRate };
    }

    const currentKpi = computeKpi(currentLeads, currentConvs);
    const prevKpi = computeKpi(prevLeads, prevConvs);

    const kpi = {
      totalInquiries: { current: currentKpi.totalInquiries, previous: prevKpi.totalInquiries },
      proofInquiries: { current: currentKpi.proofInquiries, previous: prevKpi.proofInquiries },
      proofRate: { current: currentKpi.proofRate, previous: prevKpi.proofRate },
      highValueRate: { current: currentKpi.highValueRate, previous: prevKpi.highValueRate },
    };

    // dailyTrend — by day
    const dailyMap = {};
    currentConvs.forEach(c => {
      const date = c.created_at?.split('T')[0];
      if (!date) return;
      if (!dailyMap[date]) dailyMap[date] = { total: new Set(), proof: new Set() };
      dailyMap[date].total.add(c.id);
    });
    currentLeads.forEach(l => {
      const conv = currentConvs.find(c => c.id === l.conversation_id);
      const date = conv?.created_at?.split('T')[0];
      if (!date || !dailyMap[date]) return;
      dailyMap[date].total.add(l.conversation_id);
      if (l.inquiry_quality === 'PROOF') dailyMap[date].proof.add(l.conversation_id);
    });

    // Fill all dates in range
    const dailyTrend = [];
    const cursor = new Date(fromDate);
    while (cursor <= toDate) {
      const dateStr = cursor.toISOString().split('T')[0];
      const day = dailyMap[dateStr];
      dailyTrend.push({
        date: dateStr,
        total: day?.total.size || 0,
        proof: day?.proof.size || 0,
      });
      cursor.setDate(cursor.getDate() + 1);
    }

    // agentDistribution
    const agentGroups = {};
    currentLeads.forEach(l => {
      const agentId = convAgentMap[l.conversation_id] || l.agent_id;
      if (!agentId) return;
      if (!agentGroups[agentId]) agentGroups[agentId] = { convIds: new Set(), proofConvIds: new Set(), quality: { PROOF: 0, QUALIFY: 0, GOOD: 0, BAD: 0 } };
      agentGroups[agentId].convIds.add(l.conversation_id);
      if (l.inquiry_quality === 'PROOF') agentGroups[agentId].proofConvIds.add(l.conversation_id);
      const q = l.inquiry_quality || 'BAD';
      if (agentGroups[agentId].quality[q] !== undefined) agentGroups[agentId].quality[q]++;
    });

    const agentDistribution = Object.entries(agentGroups).map(([agentId, g]) => {
      const agent = agentMap[agentId];
      const inquiryCount = g.convIds.size;
      const proofCount = g.proofConvIds.size;
      return {
        agentName: agent?.name || 'Unknown',
        productLine: agent?.product_line || 'unknown',
        inquiryCount,
        proofCount,
        proofRate: inquiryCount > 0 ? Math.round((proofCount / inquiryCount) * 1000) / 10 : 0,
        quality: g.quality,
      };
    }).sort((a, b) => b.inquiryCount - a.inquiryCount);

    // countryDistribution — Top 10 + Others
    const countryGroups = {};
    currentLeads.forEach(l => {
      const country = l.destination_country || 'Unknown';
      if (!countryGroups[country]) countryGroups[country] = { convIds: new Set(), proofConvIds: new Set() };
      countryGroups[country].convIds.add(l.conversation_id);
      if (l.inquiry_quality === 'PROOF') countryGroups[country].proofConvIds.add(l.conversation_id);
    });

    let countryList = Object.entries(countryGroups)
      .map(([country, g]) => ({
        country,
        inquiryCount: g.convIds.size,
        proofRate: g.convIds.size > 0 ? Math.round((g.proofConvIds.size / g.convIds.size) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.inquiryCount - a.inquiryCount);

    if (countryList.length > 10) {
      const top10 = countryList.slice(0, 10);
      const others = countryList.slice(10);
      const othersTotal = others.reduce((s, c) => s + c.inquiryCount, 0);
      top10.push({ country: 'Others', inquiryCount: othersTotal, proofRate: 0 });
      countryList = top10;
    }
    const countryDistribution = countryList;

    // qualityDistribution
    const qualityCounts = { PROOF: 0, QUALIFY: 0, GOOD: 0, BAD: 0 };
    currentLeads.forEach(l => {
      const q = l.inquiry_quality || 'BAD';
      if (qualityCounts[q] !== undefined) qualityCounts[q]++;
    });
    const qualityDistribution = Object.entries(qualityCounts).map(([name, value]) => ({ name, value }));

    // buyerTypeDistribution
    const buyerCounts = {};
    currentLeads.forEach(l => {
      const bt = l.buyer_type || 'other';
      buyerCounts[bt] = (buyerCounts[bt] || 0) + 1;
    });
    const buyerTypeDistribution = Object.entries(buyerCounts)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    // intentDistribution
    const intentCounts = {};
    currentLeads.forEach(l => {
      const intents = parseIntents(l.conversation_intent);
      intents.forEach(intent => {
        intentCounts[intent] = (intentCounts[intent] || 0) + 1;
      });
    });
    const intentDistribution = Object.entries(intentCounts)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    // topProducts — by (productName, productLine)
    const productGroups = {};
    currentLeads.forEach(l => {
      const agentId = convAgentMap[l.conversation_id] || l.agent_id;
      const agent = agentMap[agentId];
      const pl = agent?.product_line || 'unknown';
      const name = getProductName(l, pl);
      if (!name) return;
      const key = `${name}|||${pl}`;
      if (!productGroups[key]) productGroups[key] = { productName: name, productLine: pl, convIds: new Set(), proofConvIds: new Set() };
      productGroups[key].convIds.add(l.conversation_id);
      if (l.inquiry_quality === 'PROOF') productGroups[key].proofConvIds.add(l.conversation_id);
    });

    const topProducts = Object.values(productGroups)
      .map(g => ({
        productName: g.productName,
        productLine: g.productLine,
        inquiryCount: g.convIds.size,
        proofRate: g.convIds.size > 0 ? Math.round((g.proofConvIds.size / g.convIds.size) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.inquiryCount - a.inquiryCount)
      .slice(0, 10);

    return NextResponse.json({
      kpi,
      dailyTrend,
      agentDistribution,
      countryDistribution,
      qualityDistribution,
      buyerTypeDistribution,
      intentDistribution,
      topProducts,
    });
  } catch (error) {
    console.error('Inquiry Dashboard API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
