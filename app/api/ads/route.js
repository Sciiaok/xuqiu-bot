import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { getTenantContext } from '@/lib/tenant-context';

function parseDateRange(searchParams) {
  const days = parseInt(searchParams.get('days') || '30', 10);
  const startDate = searchParams.get('startDate') || '';
  const endDate = searchParams.get('endDate') || '';

  let fromDate;
  let toDate;

  if (startDate && endDate) {
    fromDate = new Date(`${startDate}T00:00:00.000Z`);
    toDate = new Date(`${endDate}T23:59:59.999Z`);
  } else {
    toDate = new Date();
    fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days + 1);
    fromDate.setHours(0, 0, 0, 0);
  }

  return { days, fromDate, toDate };
}

function buildDateSeries(fromDate, toDate, dailyCounts) {
  const countsByDate = new Map();
  for (const entry of dailyCounts || []) {
    countsByDate.set(entry.date, entry.count);
  }

  const series = [];
  const cursor = new Date(fromDate);

  while (cursor <= toDate) {
    const date = cursor.toISOString().split('T')[0];
    series.push({
      date,
      count: countsByDate.get(date) || 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return series;
}

export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const { days, fromDate, toDate } = parseDateRange(searchParams);
    const fromISO = fromDate.toISOString();
    const toISO = toDate.toISOString();

    const { data: rows, error } = await supabase.rpc('ad_conversation_stats', {
      p_tenant_id: ctx.tenantId,
      from_ts: fromISO,
      to_ts: toISO,
    });

    if (error) throw error;

    const summary = (rows || [])
      .map((row) => {
        const convCount = Number(row.conversation_count);
        const qualifyCount = Number(row.qualify_count);
        const proofCount = Number(row.proof_count);

        return {
          metaAdId: row.meta_ad_id,
          conversationCount: convCount,
          qualifyConversationCount: qualifyCount,
          proofConversationCount: proofCount,
          qualifyConversationRate: convCount > 0 ? Math.round((qualifyCount / convCount) * 100) : 0,
          proofConversationRate: convCount > 0 ? Math.round((proofCount / convCount) * 100) : 0,
          lastConversationAt: row.last_conversation,
          dailyConversations: buildDateSeries(fromDate, toDate, row.daily_counts),
        };
      })
      .sort((a, b) => {
        if (b.conversationCount !== a.conversationCount) {
          return b.conversationCount - a.conversationCount;
        }
        return a.metaAdId.localeCompare(b.metaAdId);
      });

    const totals = summary.reduce((acc, item) => {
      acc.adsCount += 1;
      acc.conversationCount += item.conversationCount;
      acc.qualifyConversationCount += item.qualifyConversationCount;
      acc.proofConversationCount += item.proofConversationCount;
      return acc;
    }, {
      adsCount: 0,
      conversationCount: 0,
      qualifyConversationCount: 0,
      proofConversationCount: 0,
    });

    return NextResponse.json({
      range: {
        days,
        from: fromISO,
        to: toISO,
      },
      totals: {
        ...totals,
        qualifyConversationRate: totals.conversationCount > 0
          ? Math.round((totals.qualifyConversationCount / totals.conversationCount) * 100)
          : 0,
        proofConversationRate: totals.conversationCount > 0
          ? Math.round((totals.proofConversationCount / totals.conversationCount) * 100)
          : 0,
      },
      summary,
    });
  } catch (error) {
    console.error('Error fetching ad analytics:', error);
    return NextResponse.json(
      { error: error.message || 'Failed to fetch ad analytics' },
      { status: 500 }
    );
  }
}
