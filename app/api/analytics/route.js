import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { getWaCountryLabel } from '@/lib/wa-country';

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') || '30');
    const country = searchParams.get('country') || '';
    const startDate = searchParams.get('startDate') || '';
    const endDate = searchParams.get('endDate') || '';

    let fromDate, toDate;
    if (startDate && endDate) {
      fromDate = new Date(startDate);
      toDate = new Date(endDate);
    } else {
      toDate = new Date();
      fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - days);
    }

    const fromISO = fromDate.toISOString();
    const toISO = toDate.toISOString();

    // 1. Daily conversations
    let convQuery = supabase
      .from('conversations')
      .select('id, created_at, is_human_takeover, human_takeover_at')
      .gte('created_at', fromISO)
      .lte('created_at', toISO)
      .limit(10000);

    // If country filter, join through leads
    const { data: conversations, error: convError } = await convQuery;
    if (convError) throw convError;

    // 2. Leads with details
    let leadsQuery = supabase
      .from('leads')
      .select('id, inquiry_quality, business_value, conversation_intent, route, buyer_type, destination_country, car_model, qty_bucket, approved, approved_at, conversation_id, contact_id, created_at, updated_at, handoff_summary, company_name, score')
      .gte('created_at', fromISO)
      .lte('created_at', toISO)
      .limit(10000);

    if (country) {
      leadsQuery = leadsQuery.eq('destination_country', country);
    }

    const { data: leads, error: leadsError } = await leadsQuery;
    if (leadsError) throw leadsError;

    // 3. HUMAN_NOW leads (filtered by humanNowDays param, default today)
    const humanNowDays = parseInt(searchParams.get('humanNowDays') || '1');
    const humanNowFrom = new Date();
    humanNowFrom.setDate(humanNowFrom.getDate() - humanNowDays);
    // For "today" (1 day), use start of today
    if (humanNowDays === 1) {
      humanNowFrom.setHours(0, 0, 0, 0);
    }

    let humanNowQuery = supabase
      .from('leads')
      .select('id, conversation_id, contact_id, destination_country, car_model, qty_bucket, handoff_summary, company_name, created_at, updated_at, inquiry_quality, business_value')
      .eq('route', 'HUMAN_NOW')
      .gte('created_at', humanNowFrom.toISOString())
      .order('created_at', { ascending: false })
      .limit(10000);

    if (country) {
      humanNowQuery = humanNowQuery.eq('destination_country', country);
    }

    const { data: humanNowLeads, error: humanNowError } = await humanNowQuery;
    if (humanNowError) throw humanNowError;

    // 4. Get contact names for HUMAN_NOW leads
    const contactIds = [...new Set(humanNowLeads.map(l => l.contact_id).filter(Boolean))];
    let contactMap = {};
    if (contactIds.length > 0) {
      const { data: contacts, error: contactsError } = await supabase
        .from('contacts')
        .select('id, name, wa_id')
        .in('id', contactIds);
      if (contactsError) throw contactsError;
      if (contacts) {
        contacts.forEach(c => { contactMap[c.id] = c; });
      }
    }

    // 5. Messages for response time calculation
    const { data: messages, error: msgError } = await supabase
      .from('messages')
      .select('conversation_id, role, sent_at, sent_by')
      .gte('sent_at', fromISO)
      .lte('sent_at', toISO)
      .in('role', ['user', 'assistant'])
      .order('sent_at', { ascending: true })
      .limit(10000);
    if (msgError) throw msgError;

    // --- Aggregation ---

    // Helper: group by date
    const groupByDate = (items, dateField = 'created_at') => {
      const map = {};
      items.forEach(item => {
        const date = item[dateField]?.split('T')[0];
        if (date) {
          map[date] = (map[date] || 0) + 1;
        }
      });
      return map;
    };

    // Fill missing dates
    const fillDates = (map) => {
      const result = [];
      const current = new Date(fromDate);
      while (current <= toDate) {
        const dateStr = current.toISOString().split('T')[0];
        result.push({ date: dateStr, count: map[dateStr] || 0 });
        current.setDate(current.getDate() + 1);
      }
      return result;
    };

    // Filter conversations by country if needed (through leads)
    let filteredConvIds = null;
    if (country) {
      filteredConvIds = new Set(leads.map(l => l.conversation_id));
    }

    const filteredConversations = country
      ? conversations.filter(c => filteredConvIds.has(c.id))
      : conversations;

    // Daily conversations
    const dailyConversations = fillDates(groupByDate(filteredConversations));

    // Daily leads by quality
    const leadsByQuality = {};
    leads.forEach(lead => {
      const date = lead.created_at?.split('T')[0];
      if (!date) return;
      if (!leadsByQuality[date]) leadsByQuality[date] = { PROOF: 0, QUALIFY: 0, GOOD: 0, BAD: 0, total: 0 };
      leadsByQuality[date][lead.inquiry_quality] = (leadsByQuality[date][lead.inquiry_quality] || 0) + 1;
      leadsByQuality[date].total += 1;
    });

    const dailyLeads = [];
    const current = new Date(fromDate);
    while (current <= toDate) {
      const dateStr = current.toISOString().split('T')[0];
      const day = leadsByQuality[dateStr] || { PROOF: 0, QUALIFY: 0, GOOD: 0, BAD: 0, total: 0 };
      dailyLeads.push({ date: dateStr, ...day });
      current.setDate(current.getDate() + 1);
    }

    // Qualify conversion rate: conversations with at least 1 QUALIFY+ lead / total conversations per day
    // Group by CONVERSATION created_at date (not lead date) to match denominator
    const convDateMap = {};
    filteredConversations.forEach(c => {
      convDateMap[c.id] = c.created_at?.split('T')[0];
    });

    const qualifyConvByDate = {};
    leads.forEach(lead => {
      if (['QUALIFY', 'PROOF'].includes(lead.inquiry_quality)) {
        const date = convDateMap[lead.conversation_id];
        if (date) {
          if (!qualifyConvByDate[date]) qualifyConvByDate[date] = new Set();
          qualifyConvByDate[date].add(lead.conversation_id);
        }
      }
    });

    const convByDate = groupByDate(filteredConversations);
    const qualifyRate = dailyConversations.map(day => {
      const totalConv = convByDate[day.date] || 0;
      const qualifyConv = qualifyConvByDate[day.date]?.size || 0;
      return {
        date: day.date,
        rate: totalConv > 0 ? Math.round((qualifyConv / totalConv) * 100) : 0,
        qualifyConv,
        totalConv,
      };
    });

    // Human takeover trend
    const takeoverConvs = filteredConversations.filter(c => c.is_human_takeover);
    const dailyTakeover = fillDates(groupByDate(takeoverConvs, 'human_takeover_at'));

    // Business value distribution
    const bvDist = {};
    leads.forEach(lead => {
      const bv = lead.business_value || 'Unknown';
      bvDist[bv] = (bvDist[bv] || 0) + 1;
    });
    const businessValueDist = Object.entries(bvDist)
      .map(([name, value]) => ({ name, value }));

    // Conversation intent distribution (normalized)
    const intentDist = {};
    leads.forEach(lead => {
      let raw = lead.conversation_intent;
      if (!raw) return;
      // Normalize: strip JSON array brackets like ["business_inquiry"]
      if (typeof raw === 'string' && raw.startsWith('[')) {
        try { raw = JSON.parse(raw).join(','); } catch { raw = raw.replace(/[\[\]"]/g, ''); }
      }
      // Split comma-separated intents and count each
      const intents = raw.split(',').map(s => s.trim()).filter(Boolean);
      intents.forEach(intent => {
        intentDist[intent] = (intentDist[intent] || 0) + 1;
      });
    });
    const intentDistribution = Object.entries(intentDist)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    // Lead approval rate trend
    const approvedByDate = {};
    const totalLeadsByDate = {};
    leads.forEach(lead => {
      const date = lead.created_at?.split('T')[0];
      if (!date) return;
      totalLeadsByDate[date] = (totalLeadsByDate[date] || 0) + 1;
      if (lead.approved) {
        approvedByDate[date] = (approvedByDate[date] || 0) + 1;
      }
    });

    const approvalRate = dailyConversations.map(day => {
      const total = totalLeadsByDate[day.date] || 0;
      const approved = approvedByDate[day.date] || 0;
      return {
        date: day.date,
        rate: total > 0 ? Math.round((approved / total) * 100) : 0,
        approved,
        total,
      };
    });

    // Average response time trend (first bot reply - first user msg per conversation per day)
    const convFirstMessages = {};
    messages.forEach(msg => {
      const convId = msg.conversation_id;
      if (!convFirstMessages[convId]) {
        convFirstMessages[convId] = { user: null, bot: null };
      }
      if ((msg.role === 'user' || msg.sent_by === 'customer') && !convFirstMessages[convId].user) {
        convFirstMessages[convId].user = msg.sent_at;
      }
      if ((msg.role === 'assistant' || msg.sent_by === 'bot') && !convFirstMessages[convId].bot) {
        convFirstMessages[convId].bot = msg.sent_at;
      }
    });

    const responseTimeByDate = {};
    const responseCountByDate = {};
    Object.values(convFirstMessages).forEach(({ user, bot }) => {
      if (user && bot) {
        const diff = (new Date(bot) - new Date(user)) / 1000; // seconds
        if (diff > 0 && diff < 3600) { // reasonable range: 0-1 hour
          const date = user.split('T')[0];
          responseTimeByDate[date] = (responseTimeByDate[date] || 0) + diff;
          responseCountByDate[date] = (responseCountByDate[date] || 0) + 1;
        }
      }
    });

    const avgResponseTime = dailyConversations.map(day => ({
      date: day.date,
      avgSeconds: responseCountByDate[day.date]
        ? Math.round(responseTimeByDate[day.date] / responseCountByDate[day.date])
        : 0,
    }));

    // HUMAN_NOW leads with contact info
    const humanNowList = humanNowLeads.map(lead => ({
      id: lead.id,
      conversationId: lead.conversation_id,
      contactName: contactMap[lead.contact_id]?.name || contactMap[lead.contact_id]?.wa_id || 'Unknown',
      country: lead.destination_country || '-',
      carModel: lead.car_model || '-',
      qty: lead.qty_bucket || '-',
      handoffSummary: lead.handoff_summary || '-',
      companyName: lead.company_name || '-',
      inquiryQuality: lead.inquiry_quality,
      businessValue: lead.business_value,
      createdAt: lead.created_at,
      updatedAt: lead.updated_at,
    }));

    // KPI summary (today vs yesterday)
    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    const kpi = {
      newConversations: {
        today: convByDate[today] || 0,
        yesterday: convByDate[yesterday] || 0,
      },
      qualifyRate: {
        today: qualifyRate.find(d => d.date === today)?.rate || 0,
        yesterday: qualifyRate.find(d => d.date === yesterday)?.rate || 0,
      },
      newLeads: {
        today: totalLeadsByDate[today] || 0,
        yesterday: totalLeadsByDate[yesterday] || 0,
      },
      humanNowCount: humanNowList.length,
    };

    // Available countries for filter (always unfiltered so dropdown doesn't collapse)
    const { data: allLeadsCountries } = await supabase
      .from('leads')
      .select('destination_country')
      .gte('created_at', fromISO)
      .lte('created_at', toISO)
      .not('destination_country', 'is', null)
      .limit(10000);
    const countries = [...new Set((allLeadsCountries || []).map(l => l.destination_country))].sort();

    // Country distribution (all leads in period, sorted by count desc)
    // For leads with missing destination_country, infer from contact phone prefix
    const unknownContactIds = [...new Set(
      leads.filter(l => !l.destination_country).map(l => l.contact_id).filter(Boolean),
    )];
    // Fetch contacts not already in contactMap
    const missingContactIds = unknownContactIds.filter(id => !contactMap[id]);
    if (missingContactIds.length > 0) {
      const batchSize = 200;
      for (let i = 0; i < missingContactIds.length; i += batchSize) {
        const batch = missingContactIds.slice(i, i + batchSize);
        const { data: extraContacts } = await supabase
          .from('contacts')
          .select('id, name, wa_id')
          .in('id', batch);
        if (extraContacts) {
          extraContacts.forEach(c => { contactMap[c.id] = c; });
        }
      }
    }

    const countryDist = {};
    leads.forEach(l => {
      let c = l.destination_country;
      if (!c && l.contact_id && contactMap[l.contact_id]?.wa_id) {
        c = getWaCountryLabel(contactMap[l.contact_id].wa_id) || null;
      }
      c = c || 'Unknown';
      countryDist[c] = (countryDist[c] || 0) + 1;
    });
    const countryDistribution = Object.entries(countryDist)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    // Supply chain distribution (leads by agent product_line in period)
    // Need agent info — query conversations with agent product_line for lead conversation_ids
    const leadConvIds = [...new Set(leads.map(l => l.conversation_id).filter(Boolean))];
    let supplyChainDistribution = [];
    if (leadConvIds.length > 0) {
      const batchSize = 200;
      const convAgentRows = [];
      for (let i = 0; i < leadConvIds.length; i += batchSize) {
        const batch = leadConvIds.slice(i, i + batchSize);
        const { data } = await supabase
          .from('conversations')
          .select('id, agents(product_line)')
          .in('id', batch);
        if (data) convAgentRows.push(...data);
      }
      const convAgentMap = {};
      convAgentRows.forEach(c => {
        convAgentMap[c.id] = c.agents?.product_line || 'Unknown';
      });

      const chainDist = {};
      leads.forEach(l => {
        const line = convAgentMap[l.conversation_id] || 'Unknown';
        chainDist[line] = (chainDist[line] || 0) + 1;
      });
      supplyChainDistribution = Object.entries(chainDist)
        .map(([name, value]) => ({ name, value }))
        .sort((a, b) => b.value - a.value);
    }

    return NextResponse.json({
      kpi,
      dailyConversations,
      qualifyRate,
      dailyLeads,
      dailyTakeover,
      businessValueDist,
      intentDistribution,
      approvalRate,
      avgResponseTime,
      humanNowList,
      countries,
      countryDistribution,
      supplyChainDistribution,
    });
  } catch (error) {
    console.error('Analytics API error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
