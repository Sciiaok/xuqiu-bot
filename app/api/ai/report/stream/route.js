import { createClient } from '../../../../../lib/supabase-server.js';
import { getRedis } from '../../../../../lib/redis.js';
import { demoGuard } from '../../../../../lib/demo-mode.js';
import { streamSSE } from '../../../../../lib/sse.js';
import { generateSummaryWithFallback } from '../../../../../lib/ai-summary.js';

const REPORT_PROMPTS = {
  market_insight: '你是国际市场分析师。分析各市场的询盘数据，识别热门市场、新兴机会和风险信号。用中文回复，使用 Markdown 格式。',
  daily_report: '你是B2B外贸数据分析师。根据以下数据生成简洁的中文日报分析。包含：关键指标变化、线索质量分布、值得关注的趋势、建议的行动项。使用 Markdown 格式。',
  attribution: '你是广告归因分析专家。分析广告到线索的转化路径，识别高效广告、问题广告，给出优化建议。用中文回复，使用 Markdown 格式。',
  campaign_analysis: '你是数字营销策略师。综合分析广告投放效果，评估各广告的表现，提供全局优化策略建议。用中文回复，使用 Markdown 格式。',
};

/**
 * Seconds until next midnight China time (UTC+8).
 * Reports cache expires at 00:00 CST so each new day gets fresh data.
 */
function secondsUntilChinaMidnight() {
  const now = new Date();
  // China midnight = UTC 16:00 previous day
  const chinaHour = (now.getUTCHours() + 8) % 24;
  const chinaMin = now.getUTCMinutes();
  const chinaSec = now.getUTCSeconds();

  const secondsSinceChinaMidnight = chinaHour * 3600 + chinaMin * 60 + chinaSec;
  const ttl = 86400 - secondsSinceChinaMidnight;
  // Minimum 60s to avoid edge-case 0-TTL
  return Math.max(60, ttl);
}

function parseDays(value) {
  const parsed = Number.parseInt(String(value ?? '7'), 10);
  if (Number.isNaN(parsed) || parsed <= 0) return 7;
  return Math.min(parsed, 90);
}

function cacheKey(type, days) {
  return `ai_report_cache:${type}:${days}`;
}

function buildDateRange(days) {
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days + 1);
  fromDate.setHours(0, 0, 0, 0);
  return { fromDate, toDate, fromISO: fromDate.toISOString(), toISO: toDate.toISOString() };
}

/**
 * GET /api/ai/report/stream?type=market_insight&days=7
 *
 * SSE stream that:
 * 1. Checks Redis cache — if hit, streams cached text in chunks
 * 2. If miss, calls LLM, streams response chunks, caches until next China midnight
 */
export async function GET(request) {
  const demoResponse = demoGuard({ event: 'done', data: { text: '演示模式' } });
  if (demoResponse) return demoResponse;

  const authClient = await createClient();
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') || 'market_insight';
  const days = parseDays(searchParams.get('days'));

  if (!REPORT_PROMPTS[type]) {
    return Response.json({ error: `Unsupported type: ${type}` }, { status: 400 });
  }

  const key = cacheKey(type, days);

  async function* generateReport() {
    let redis;
    try { redis = getRedis(); } catch { redis = null; }

    // 1. Check Redis cache
    if (redis) {
      try {
        const cached = await redis.get(key);
        if (cached) {
          yield { event: 'cache_hit', data: { cached: true } };
          const chunkSize = 80;
          for (let i = 0; i < cached.length; i += chunkSize) {
            yield { event: 'chunk', data: { text: cached.slice(i, i + chunkSize) } };
          }
          yield { event: 'done', data: { text: cached, cached: true } };
          return;
        }
      } catch (err) {
        console.warn('[ai/report/stream] Redis GET failed:', err.message);
      }
    }

    // 2. Cache miss — build data + call LLM
    yield { event: 'status', data: { message: '正在收集数据…' } };

    const { buildReportData } = await import('../route.js');
    const { fromDate, toDate, fromISO, toISO } = buildDateRange(days);
    const reportData = await buildReportData(type, fromISO, toISO, fromDate, toDate);

    yield { event: 'status', data: { message: '正在生成报告…' } };

    const dataStr = JSON.stringify(reportData, null, 2);
    const truncated = dataStr.length > 30000 ? dataStr.slice(0, 30000) + '\n...(数据已截断)' : dataStr;
    const userPrompt = `请严格基于以下数据生成报告，不要编造未提供的信息。若数据不足，请明确指出。\n\n报告类型: ${type}\n时间范围: ${fromISO} 至 ${toISO}\n\n数据:\n${truncated}`;

    let fullText;
    try {
      fullText = await generateSummaryWithFallback({
        system: REPORT_PROMPTS[type],
        userPrompt,
        maxTokens: 2000,
        logTag: `ai/report/stream:${type}`,
      });
    } catch (err) {
      console.error('[ai/report/stream] All models failed:', err.message);
      yield { event: 'error', data: { message: `报告生成失败: ${err.message}` } };
      return;
    }

    // Stream in chunks
    const chunkSize = 80;
    for (let i = 0; i < fullText.length; i += chunkSize) {
      yield { event: 'chunk', data: { text: fullText.slice(i, i + chunkSize) } };
    }

    yield { event: 'done', data: { text: fullText, cached: false } };

    // 3. Cache until next China midnight (UTC+8 00:00)
    if (redis) {
      try {
        const ttl = secondsUntilChinaMidnight();
        await redis.set(key, fullText, 'EX', ttl);
      } catch (err) {
        console.warn('[ai/report/stream] Redis SET failed:', err.message);
      }
    }
  }

  return streamSSE(generateReport(), { heartbeatIntervalMs: 10000 });
}
