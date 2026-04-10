import supabase from '@/lib/supabase';
import { anthropic, MODELS } from '@/src/llm-client.js';
import { streamSSE } from '@/lib/sse.js';
import { parseDashboardParams, fetchDashboardData } from '@/lib/inquiry-dashboard';

const SYSTEM_PROMPTS = {
  zh: '你是B2B外贸询盘数据分析师。根据以下询盘看板聚合数据，生成3-5句简洁的中文总结。包含：关键KPI及环比变化、业务线对比、Top国家、质量和买家类型分布亮点、值得关注的异常。使用 Markdown 格式。',
  en: 'You are a B2B trade inquiry data analyst. Based on the following inquiry dashboard aggregated data, generate a concise summary in 3-5 sentences in English. Include: key KPIs with period-over-period changes, business line comparisons, top countries, quality and buyer type distribution highlights, and noteworthy anomalies. Use Markdown format.',
};

const TTL_DAYS = 7;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;
const CHUNK_SIZE = 80;
const MAX_DATA_CHARS = 20000;

/* ─────────────────────────  param parsing & cache key  ───────────────────────── */

function parseSummaryParams(searchParams) {
  const { windows, productLines } = parseDashboardParams(searchParams);
  const lang = searchParams.get('lang') || 'zh';
  const productLinesKey = [...productLines].sort().join(',');
  const dateFrom = windows.current.fromDate;
  const dateTo = windows.current.toDate;
  const periodKey = `${dateFrom}:${dateTo}:${lang}`;

  return {
    windows,
    productLines,
    productLinesKey,
    periodKey,
    dateFrom,
    dateTo,
    lang,
  };
}

/* ─────────────────────────  cache  ───────────────────────── */

async function readCache({ productLinesKey, periodKey }) {
  const { data } = await supabase
    .from('inquiry_dashboard_summaries')
    .select('content, generated_at')
    .eq('product_lines', productLinesKey)
    .eq('period_key', periodKey)
    .single();
  if (!data) return null;
  const age = Date.now() - new Date(data.generated_at).getTime();
  return age < TTL_MS ? data : null;
}

async function writeCache({ productLinesKey, periodKey, dateFrom, dateTo }, content) {
  await supabase
    .from('inquiry_dashboard_summaries')
    .upsert({
      product_lines: productLinesKey,
      period_key: periodKey,
      date_from: dateFrom,
      date_to: dateTo,
      content,
      generated_at: new Date().toISOString(),
    }, { onConflict: 'product_lines,period_key' });
}

/* ─────────────────────────  LLM  ───────────────────────── */

async function callLLM(model, systemPrompt, userPrompt) {
  const result = await anthropic.messages.create({
    model,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    max_tokens: 1500,
  });
  return result.content?.find((b) => b.type === 'text')?.text?.trim() || '';
}

// Try MINIMAX first (fast & cheap); fall back to HAIKU if it fails or returns empty.
async function generateSummary(dashboardData, lang) {
  const dataStr = JSON.stringify(dashboardData, null, 2);
  const truncated = dataStr.length > MAX_DATA_CHARS
    ? dataStr.slice(0, MAX_DATA_CHARS) + '\n...(truncated)'
    : dataStr;

  const systemPrompt = SYSTEM_PROMPTS[lang] || SYSTEM_PROMPTS.zh;
  const userPrompt = lang === 'en'
    ? `Generate a summary strictly based on the following data. Do not fabricate information not provided.\n\nData:\n${truncated}`
    : `请严格基于以下数据生成总结，不要编造未提供的信息。\n\n数据:\n${truncated}`;

  try {
    const text = await callLLM(MODELS.MINIMAX, systemPrompt, userPrompt);
    if (text) return text;
    console.warn('[inquiry-summary] MINIMAX returned empty, falling back to HAIKU');
  } catch (err) {
    console.warn('[inquiry-summary] MINIMAX failed, falling back to HAIKU:', err.message);
  }

  return callLLM(MODELS.HAIKU, systemPrompt, userPrompt);
}

/* ─────────────────────────  SSE stream  ───────────────────────── */

function* streamChunks(text) {
  for (let i = 0; i < text.length; i += CHUNK_SIZE) {
    yield { event: 'chunk', data: { text: text.slice(i, i + CHUNK_SIZE) } };
  }
}

const MSG = {
  collecting: { zh: '正在收集询盘数据…', en: 'Collecting inquiry data...' },
  generating: { zh: '正在生成询盘总结…', en: 'Generating summary...' },
  regenerating: { zh: '正在重新生成询盘总结…', en: 'Regenerating summary...' },
  failed: { zh: '总结生成失败', en: 'Summary generation failed' },
};

async function* streamSummary(params, { skipCache }) {
  if (!skipCache) {
    const cached = await readCache(params);
    if (cached) {
      yield { event: 'cache_hit', data: { cached: true } };
      yield* streamChunks(cached.content);
      yield { event: 'done', data: { text: cached.content, cached: true } };
      return;
    }
  }

  yield { event: 'status', data: { message: MSG.collecting[params.lang] || MSG.collecting.zh } };
  const dashboardData = await fetchDashboardData(supabase, params);

  const statusKey = skipCache ? 'regenerating' : 'generating';
  yield { event: 'status', data: { message: MSG[statusKey][params.lang] || MSG[statusKey].zh } };

  let fullText;
  try {
    fullText = await generateSummary(dashboardData, params.lang);
  } catch (err) {
    console.error('[inquiry-summary] All models failed:', err.message);
    yield { event: 'error', data: { message: `${MSG.failed[params.lang] || MSG.failed.zh}: ${err.message}` } };
    return;
  }
  if (!fullText) {
    yield { event: 'error', data: { message: MSG.failed[params.lang] || MSG.failed.zh } };
    return;
  }

  yield* streamChunks(fullText);
  yield { event: 'done', data: { text: fullText, cached: false } };
  await writeCache(params, fullText);
}

/* ─────────────────────────  handlers  ───────────────────────── */

function runStream(request, { skipCache }) {
  const { searchParams } = new URL(request.url);
  const params = parseSummaryParams(searchParams);
  return streamSSE(streamSummary(params, { skipCache }), { heartbeatIntervalMs: 10000 });
}

export const GET = (request) => runStream(request, { skipCache: false });
export const POST = (request) => runStream(request, { skipCache: true });
