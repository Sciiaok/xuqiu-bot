import supabase from '@/lib/supabase';
import { anthropic, MODELS } from '@/src/llm-client.js';
import { streamSSE } from '@/lib/sse.js';
import { buildDateWindows } from '@/lib/inquiry-dashboard';

const SYSTEM_PROMPTS = {
  zh: '你是B2B外贸询盘数据分析师。根据以下询盘看板聚合数据，生成3-5句简洁的中文总结。包含：关键KPI及环比变化、业务线对比、Top国家、质量和买家类型分布亮点、值得关注的异常。使用 Markdown 格式。',
  en: 'You are a B2B trade inquiry data analyst. Based on the following inquiry dashboard aggregated data, generate a concise summary in 3-5 sentences in English. Include: key KPIs with period-over-period changes, business line comparisons, top countries, quality and buyer type distribution highlights, and noteworthy anomalies. Use Markdown format.',
};

const TTL_DAYS = 7;

function buildCacheParams(searchParams) {
  const days = parseInt(searchParams.get('days') || '7');
  const preset = searchParams.get('preset') || '';
  const startDate = searchParams.get('startDate') || '';
  const endDate = searchParams.get('endDate') || '';
  const lang = searchParams.get('lang') || 'zh';
  const productLines = (searchParams.get('productLines') || 'vehicle,auto_parts,agri_machinery')
    .split(',').map(s => s.trim()).filter(Boolean).sort().join(',');

  let periodKey, dateFrom, dateTo;
  if (startDate && endDate) {
    periodKey = `custom:${startDate}:${endDate}:${lang}`;
    dateFrom = startDate;
    dateTo = endDate;
  } else {
    const windows = buildDateWindows({ days, preset });
    dateFrom = windows.current.fromDate;
    dateTo = windows.current.toDate;
    periodKey = `${preset || `${days}d`}:${dateFrom}:${dateTo}:${lang}`;
  }

  return { productLines, periodKey, dateFrom, dateTo, days, preset, startDate, endDate, lang };
}

async function fetchDashboardData(params) {
  const { days, preset, startDate, endDate, productLines } = params;
  const qs = new URLSearchParams();
  if (startDate && endDate) {
    qs.set('startDate', startDate);
    qs.set('endDate', endDate);
  } else {
    qs.set('days', String(days));
    if (preset) qs.set('preset', preset);
  }
  qs.set('productLines', productLines);

  // Import and call the GET handler directly to avoid HTTP round-trip
  const { GET } = await import('../route.js');
  const fakeUrl = `http://localhost/api/inquiry-dashboard?${qs}`;
  const fakeRequest = new Request(fakeUrl);
  const response = await GET(fakeRequest);
  return response.json();
}

async function generateSummary(dashboardData, lang = 'zh') {
  const dataStr = JSON.stringify(dashboardData, null, 2);
  const truncated = dataStr.length > 20000 ? dataStr.slice(0, 20000) + '\n...(truncated)' : dataStr;
  const systemPrompt = SYSTEM_PROMPTS[lang] || SYSTEM_PROMPTS.zh;
  const userPrompt = lang === 'en'
    ? `Generate a summary strictly based on the following data. Do not fabricate information not provided.\n\nData:\n${truncated}`
    : `请严格基于以下数据生成总结，不要编造未提供的信息。\n\n数据:\n${truncated}`;

  const result = await anthropic.messages.create({
    model: MODELS.MINIMAX,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    max_tokens: 1500,
  });

  return result.content?.find(b => b.type === 'text')?.text?.trim() || '';
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const { productLines, periodKey, dateFrom, dateTo, days, preset, startDate, endDate, lang } = buildCacheParams(searchParams);

  async function* generate() {
    // 1. Check cache
    const { data: cached } = await supabase
      .from('inquiry_dashboard_summaries')
      .select('content, generated_at')
      .eq('product_lines', productLines)
      .eq('period_key', periodKey)
      .single();

    if (cached) {
      const age = Date.now() - new Date(cached.generated_at).getTime();
      if (age < TTL_DAYS * 24 * 60 * 60 * 1000) {
        yield { event: 'cache_hit', data: { cached: true } };
        const chunkSize = 80;
        for (let i = 0; i < cached.content.length; i += chunkSize) {
          yield { event: 'chunk', data: { text: cached.content.slice(i, i + chunkSize) } };
        }
        yield { event: 'done', data: { text: cached.content, cached: true } };
        return;
      }
    }

    // 2. Generate
    yield { event: 'status', data: { message: lang === 'en' ? 'Collecting inquiry data...' : '正在收集询盘数据…' } };

    const dashboardData = await fetchDashboardData({ days, preset, startDate, endDate, productLines });

    yield { event: 'status', data: { message: lang === 'en' ? 'Generating summary...' : '正在生成询盘总结…' } };

    const fullText = await generateSummary(dashboardData, lang);
    if (!fullText) {
      yield { event: 'error', data: { message: lang === 'en' ? 'Summary generation failed' : '总结生成失败' } };
      return;
    }

    // Stream in chunks
    const chunkSize = 80;
    for (let i = 0; i < fullText.length; i += chunkSize) {
      yield { event: 'chunk', data: { text: fullText.slice(i, i + chunkSize) } };
    }

    yield { event: 'done', data: { text: fullText, cached: false } };

    // 3. Upsert cache
    await supabase
      .from('inquiry_dashboard_summaries')
      .upsert({
        product_lines: productLines,
        period_key: periodKey,
        date_from: dateFrom,
        date_to: dateTo,
        content: fullText,
        generated_at: new Date().toISOString(),
      }, { onConflict: 'product_lines,period_key' });
  }

  return streamSSE(generate(), { heartbeatIntervalMs: 10000 });
}

export async function POST(request) {
  const { searchParams } = new URL(request.url);
  const { productLines, periodKey, dateFrom, dateTo, days, preset, startDate, endDate, lang } = buildCacheParams(searchParams);

  async function* generate() {
    yield { event: 'status', data: { message: lang === 'en' ? 'Collecting inquiry data...' : '正在收集询盘数据…' } };

    const dashboardData = await fetchDashboardData({ days, preset, startDate, endDate, productLines });

    yield { event: 'status', data: { message: lang === 'en' ? 'Regenerating summary...' : '正在重新生成询盘总结…' } };

    const fullText = await generateSummary(dashboardData, lang);
    if (!fullText) {
      yield { event: 'error', data: { message: lang === 'en' ? 'Summary generation failed' : '总结生成失败' } };
      return;
    }

    const chunkSize = 80;
    for (let i = 0; i < fullText.length; i += chunkSize) {
      yield { event: 'chunk', data: { text: fullText.slice(i, i + chunkSize) } };
    }

    yield { event: 'done', data: { text: fullText, cached: false } };

    await supabase
      .from('inquiry_dashboard_summaries')
      .upsert({
        product_lines: productLines,
        period_key: periodKey,
        date_from: dateFrom,
        date_to: dateTo,
        content: fullText,
        generated_at: new Date().toISOString(),
      }, { onConflict: 'product_lines,period_key' });
  }

  return streamSSE(generate(), { heartbeatIntervalMs: 10000 });
}
