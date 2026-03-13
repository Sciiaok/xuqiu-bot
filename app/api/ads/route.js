import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';

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

function toDateKey(value) {
  return value ? value.split('T')[0] : null;
}

function buildDateSeries(fromDate, toDate, countsByDate) {
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

function ensureAdBucket(map, metaAdId) {
  if (!map.has(metaAdId)) {
    map.set(metaAdId, {
      metaAdId,
      conversationCount: 0,
      qualifyConversationIds: new Set(),
      proofConversationIds: new Set(),
      lastConversationAt: null,
      dailyConversationCounts: new Map(),
    });
  }

  return map.get(metaAdId);
}

function chunkValues(values, size) {
  const chunks = [];

  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }

  return chunks;
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const { days, fromDate, toDate } = parseDateRange(searchParams);
    const fromISO = fromDate.toISOString();
    const toISO = toDate.toISOString();

    const { data: conversations, error: conversationsError } = await supabase
      .from('conversations')
      .select('id, meta_ad_id, created_at')
      .not('meta_ad_id', 'is', null)
      .gte('created_at', fromISO)
      .lte('created_at', toISO)
      .order('created_at', { ascending: false })
      .limit(10000);

    if (conversationsError) throw conversationsError;

    const adMap = new Map();
    const conversationMetaAdMap = new Map();

    for (const conversation of conversations || []) {
      const metaAdId = String(conversation.meta_ad_id || '').trim();
      if (!metaAdId) continue;

      conversationMetaAdMap.set(conversation.id, metaAdId);

      const bucket = ensureAdBucket(adMap, metaAdId);
      bucket.conversationCount += 1;

      const dateKey = toDateKey(conversation.created_at);
      if (dateKey) {
        bucket.dailyConversationCounts.set(
          dateKey,
          (bucket.dailyConversationCounts.get(dateKey) || 0) + 1
        );
      }

      if (!bucket.lastConversationAt || conversation.created_at > bucket.lastConversationAt) {
        bucket.lastConversationAt = conversation.created_at;
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
              .limit(10000)
          ))
        )
      : [];

    for (const response of leadResponses) {
      if (response.error) throw response.error;
    }

    const leads = leadResponses.flatMap((response) => response.data || []);

    for (const lead of leads || []) {
      const conversationId = lead.conversation_id || null;
      const metaAdId = conversationId ? conversationMetaAdMap.get(conversationId) : null;
      if (!metaAdId) continue;

      const bucket = ensureAdBucket(adMap, metaAdId);
      const normalizedQuality = String(lead.inquiry_quality || '').toUpperCase();

      if (conversationId && normalizedQuality === 'QUALIFY') {
        bucket.qualifyConversationIds.add(conversationId);
      }

      if (conversationId && normalizedQuality === 'PROOF') {
        bucket.proofConversationIds.add(conversationId);
      }
    }

    const summary = Array.from(adMap.values())
      .map((bucket) => ({
        metaAdId: bucket.metaAdId,
        conversationCount: bucket.conversationCount,
        qualifyConversationCount: bucket.qualifyConversationIds.size,
        proofConversationCount: bucket.proofConversationIds.size,
        qualifyConversationRate: bucket.conversationCount > 0
          ? Math.round((bucket.qualifyConversationIds.size / bucket.conversationCount) * 100)
          : 0,
        proofConversationRate: bucket.conversationCount > 0
          ? Math.round((bucket.proofConversationIds.size / bucket.conversationCount) * 100)
          : 0,
        lastConversationAt: bucket.lastConversationAt,
        dailyConversations: buildDateSeries(fromDate, toDate, bucket.dailyConversationCounts),
      }))
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
