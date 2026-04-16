/**
 * AI Report Generator Service
 *
 * Generates daily/weekly/monthly/manual reports by:
 * 1. Collecting aggregated data (KPIs, quality distribution, etc.)
 * 2. For weekly+: adding conversation summaries (intent + handoff)
 * 3. Calling LLM with structured prompts
 * 4. Saving structured content to ai_reports table
 */

import supabase from '../supabase.js';
import { openrouter, MODELS } from '../../src/llm-client.js';
import { buildReportData } from '../../app/api/ai/report/route.js';

// ── Date helpers (China time = UTC+8) ────────────────────────────────

function chinaDate(date = new Date()) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000);
}

function formatDate(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Compute period_start and period_end for a report type.
 * All dates are in China timezone (UTC+8).
 */
export function computePeriod(type, referenceDate = new Date()) {
  const china = chinaDate(referenceDate);

  if (type === 'daily') {
    // Yesterday in China time
    const yesterday = new Date(china);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const date = formatDate(yesterday);
    return { periodStart: date, periodEnd: date };
  }

  if (type === 'weekly') {
    // Last week Monday ~ Sunday (China time)
    const dayOfWeek = china.getUTCDay(); // 0=Sun
    const thisMon = new Date(china);
    thisMon.setUTCDate(thisMon.getUTCDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    const lastMon = new Date(thisMon);
    lastMon.setUTCDate(lastMon.getUTCDate() - 7);
    const lastSun = new Date(lastMon);
    lastSun.setUTCDate(lastSun.getUTCDate() + 6);
    return { periodStart: formatDate(lastMon), periodEnd: formatDate(lastSun) };
  }

  if (type === 'monthly') {
    // Last month 1st ~ last day (China time)
    const year = china.getUTCFullYear();
    const month = china.getUTCMonth(); // 0-indexed, so this IS last month if we just passed the 1st
    const lastMonthStart = new Date(Date.UTC(year, month - 1, 1));
    const lastMonthEnd = new Date(Date.UTC(year, month, 0)); // day 0 = last day of prev month
    return { periodStart: formatDate(lastMonthStart), periodEnd: formatDate(lastMonthEnd) };
  }

  throw new Error(`Cannot compute period for type: ${type}`);
}

// ── Data collection ──────────────────────────────────────────────────

function periodToISO(periodStart, periodEnd) {
  const fromISO = `${periodStart}T00:00:00+08:00`;
  // End of day in China time
  const endDate = new Date(`${periodEnd}T23:59:59.999+08:00`);
  const toISO = endDate.toISOString();
  const fromDate = new Date(`${periodStart}T00:00:00+08:00`);
  return { fromISO, toISO, fromDate, toDate: endDate };
}

async function fetchConversationSummaries(fromISO, toISO, agentIds) {
  let query = supabase
    .from('leads')
    .select('conversation_intent_summary, agent_id')
    .gte('created_at', fromISO)
    .lte('created_at', toISO)
    .not('conversation_intent_summary', 'is', null)
    .limit(10000);

  if (agentIds && agentIds.length > 0) {
    query = query.in('agent_id', agentIds);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(r => r.conversation_intent_summary).filter(Boolean);
}

async function fetchHandoffSummaries(fromISO, toISO, agentIds) {
  let query = supabase
    .from('leads')
    .select('handoff_summary, agent_id')
    .gte('created_at', fromISO)
    .lte('created_at', toISO)
    .eq('route', 'HUMAN_NOW')
    .not('handoff_summary', 'is', null)
    .limit(10000);

  if (agentIds && agentIds.length > 0) {
    query = query.in('agent_id', agentIds);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(r => r.handoff_summary).filter(Boolean);
}

async function fetchSupplyChainBreakdown(fromISO, toISO) {
  const { data, error } = await supabase
    .from('leads')
    .select('inquiry_quality, agent:agents(product_line)')
    .gte('created_at', fromISO)
    .lte('created_at', toISO)
    .limit(10000);

  if (error) throw error;

  const chains = {};
  for (const lead of data || []) {
    const line = lead.agent?.product_line || 'Unknown';
    if (!chains[line]) chains[line] = { total: 0, PROOF: 0, QUALIFY: 0, GOOD: 0, BAD: 0 };
    chains[line].total += 1;
    const q = String(lead.inquiry_quality || '').toUpperCase();
    if (chains[line][q] !== undefined) chains[line][q] += 1;
  }

  return Object.entries(chains).map(([name, counts]) => ({ name, ...counts }));
}

async function fetchCountryDistribution(fromISO, toISO) {
  const { data, error } = await supabase
    .from('leads')
    .select('destination_country, inquiry_quality')
    .gte('created_at', fromISO)
    .lte('created_at', toISO)
    .not('destination_country', 'is', null)
    .limit(10000);

  if (error) throw error;

  const countries = {};
  for (const lead of data || []) {
    const c = lead.destination_country;
    if (!c) continue;
    if (!countries[c]) countries[c] = { total: 0, PROOF: 0 };
    countries[c].total += 1;
    if (String(lead.inquiry_quality || '').toUpperCase() === 'PROOF') countries[c].PROOF += 1;
  }

  return Object.entries(countries)
    .map(([country, counts]) => ({ country, ...counts }))
    .sort((a, b) => b.total - a.total);
}

async function fetchTopProducts(fromISO, toISO) {
  const { data, error } = await supabase
    .from('leads')
    .select('details')
    .gte('created_at', fromISO)
    .lte('created_at', toISO)
    .limit(10000);

  if (error) throw error;

  const products = {};
  for (const lead of data || []) {
    const items = lead.details?.items || lead.details?.inquiries || [];
    for (const item of items) {
      const name = item.product_name || item.part_name || item.model || 'Unknown';
      products[name] = (products[name] || 0) + 1;
    }
  }

  return Object.entries(products)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

// ── KPI computation ──────────────────────────────────────────────────

async function computeKPI(fromISO, toISO, prevFromISO, prevToISO) {
  // Current period
  const [{ count: convCount }, { data: leads }] = await Promise.all([
    supabase.from('conversations').select('id', { count: 'exact', head: true })
      .gte('created_at', fromISO).lte('created_at', toISO),
    supabase.from('leads').select('inquiry_quality, business_value')
      .gte('created_at', fromISO).lte('created_at', toISO).limit(10000),
  ]);

  const totalLeads = leads?.length || 0;
  const proofCount = (leads || []).filter(l => String(l.inquiry_quality).toUpperCase() === 'PROOF').length;
  const qualifyPlusCount = (leads || []).filter(l => ['PROOF', 'QUALIFY'].includes(String(l.inquiry_quality).toUpperCase())).length;
  const highBVCount = (leads || []).filter(l => String(l.business_value).toUpperCase() === 'HIGH').length;
  const proofRate = totalLeads > 0 ? Math.round((proofCount / totalLeads) * 100) : 0;
  const highBVRate = totalLeads > 0 ? Math.round((highBVCount / totalLeads) * 100) : 0;

  // Previous period (for comparison)
  const [{ count: prevConvCount }, { data: prevLeads }] = await Promise.all([
    supabase.from('conversations').select('id', { count: 'exact', head: true })
      .gte('created_at', prevFromISO).lte('created_at', prevToISO),
    supabase.from('leads').select('inquiry_quality, business_value')
      .gte('created_at', prevFromISO).lte('created_at', prevToISO).limit(10000),
  ]);

  const prevTotalLeads = prevLeads?.length || 0;
  const prevProofCount = (prevLeads || []).filter(l => String(l.inquiry_quality).toUpperCase() === 'PROOF').length;
  const prevHighBVCount = (prevLeads || []).filter(l => String(l.business_value).toUpperCase() === 'HIGH').length;
  const prevProofRate = prevTotalLeads > 0 ? Math.round((prevProofCount / prevTotalLeads) * 100) : 0;
  const prevHighBVRate = prevTotalLeads > 0 ? Math.round((prevHighBVCount / prevTotalLeads) * 100) : 0;

  function delta(current, previous) {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
  }

  return {
    totalInquiries: { value: totalLeads, delta: delta(totalLeads, prevTotalLeads) },
    proofCount: { value: proofCount, delta: delta(proofCount, prevProofCount) },
    proofRate: { value: proofRate, delta: proofRate - prevProofRate },
    highBVRate: { value: highBVRate, delta: highBVRate - prevHighBVRate },
  };
}

function computePreviousPeriod(periodStart, periodEnd) {
  const start = new Date(periodStart + 'T00:00:00Z');
  const end = new Date(periodEnd + 'T23:59:59.999Z');
  const durationMs = end.getTime() - start.getTime();

  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - durationMs);

  return {
    prevFromISO: prevStart.toISOString(),
    prevToISO: prevEnd.toISOString(),
  };
}

// ── LLM prompts ──────────────────────────────────────────────────────

const DAILY_PROMPT = `你是B2B外贸数据分析师。根据提供的数据生成日报分析。

要求输出 JSON 格式，包含以下字段：
{
  "highlights": ["亮点1", "亮点2"],
  "problems": ["问题1", "问题2"],
  "summary_line": "一句话总结今日表现"
}

规则：
- highlights: 1-2条亮点，基于聚合数据分析
- problems: 1-2条问题/异常，基于聚合数据分析
- summary_line: 不超过50字的一句话摘要
- 所有内容用中文
- 严格基于数据，不要编造`;

const FULL_PROMPT = `你是B2B外贸数据分析师。根据提供的数据生成完整分析报告。

要求输出 JSON 格式，包含以下字段：
{
  "highlights": ["亮点1", "亮点2", "亮点3"],
  "problems": ["问题1（含原因分析）", "问题2（含原因分析）"],
  "customer_insights": ["洞察1", "洞察2", "洞察3"],
  "action_suggestions": {
    "operations": ["运营层建议1"],
    "communication": ["话术层建议1"],
    "product": ["产品层建议1"]
  },
  "summary_line": "一句话总结本期表现"
}

规则：
- highlights: 3-5条亮点，综合聚合数据和客户洞察
- problems: 3-5条问题/异常，须包含原因分析
- customer_insights: 基于对话摘要提取客户群体的共性关注点、痛点、趋势变化
- action_suggestions: 分三层（运营层=投放/渠道，话术层=沟通优化，产品层=供应链/产品策略），每层1-3条可执行建议
- summary_line: 不超过50字的一句话摘要
- 所有内容用中文
- 严格基于数据，不要编造`;

// ── Core generation ──────────────────────────────────────────────────

async function collectReportInput(type, periodStart, periodEnd, agentIds) {
  const { fromISO, toISO, fromDate, toDate } = periodToISO(periodStart, periodEnd);

  // All reports get aggregated data
  const [dailyData, supplyChains, countries, topProducts, kpi] = await Promise.all([
    buildReportData('daily_report', fromISO, toISO, fromDate, toDate),
    fetchSupplyChainBreakdown(fromISO, toISO),
    fetchCountryDistribution(fromISO, toISO),
    fetchTopProducts(fromISO, toISO),
    computeKPI(fromISO, toISO, ...Object.values(computePreviousPeriod(periodStart, periodEnd))),
  ]);

  const input = {
    period: `${periodStart} ~ ${periodEnd}`,
    kpi,
    ...dailyData,
    supplyChains,
    countryTop5: countries.slice(0, 5),
    topProducts,
  };

  // Weekly/monthly/manual: add conversation summaries
  if (type !== 'daily') {
    const [intentSummaries, handoffSummaries] = await Promise.all([
      fetchConversationSummaries(fromISO, toISO, agentIds),
      fetchHandoffSummaries(fromISO, toISO, agentIds),
    ]);
    input.intentSummaries = intentSummaries;
    input.handoffSummaries = handoffSummaries;
  }

  return { input, kpi };
}

async function callLLM(type, input) {
  const systemPrompt = type === 'daily' ? DAILY_PROMPT : FULL_PROMPT;
  const dataStr = JSON.stringify(input, null, 2);
  const truncated = dataStr.length > 50000 ? dataStr.slice(0, 50000) + '\n...(数据已截断)' : dataStr;

  const result = await openrouter.messages.create({
    models: [MODELS.SONNET],
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `报告类型: ${type}\n\n数据:\n${truncated}`,
      },
    ],
    max_tokens: 4000,
  });

  const text = result.choices[0].message.content?.trim();
  if (!text) throw new Error('LLM returned empty response');

  // Parse JSON from response (strip markdown fences if present)
  let raw = text;
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) raw = fenceMatch[1].trim();

  return JSON.parse(raw);
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Generate a single report and save to ai_reports table.
 * Returns the created report row.
 */
export async function generateReport({ type, periodStart, periodEnd, agentIds = [] }) {
  // Create the report row in "generating" status
  const { data: report, error: insertError } = await supabase
    .from('ai_reports')
    .insert({
      type,
      status: 'generating',
      agent_ids: agentIds,
      period_start: periodStart,
      period_end: periodEnd,
    })
    .select()
    .single();

  if (insertError) throw insertError;

  try {
    const { input, kpi } = await collectReportInput(type, periodStart, periodEnd, agentIds);
    const content = await callLLM(type, input);

    // Build appendix for full reports
    if (type !== 'daily') {
      content.appendix = {
        supplyChains: input.supplyChains,
        countryDistribution: input.countryTop5,
        topProducts: input.topProducts,
      };
    }

    const { data: updated, error: updateError } = await supabase
      .from('ai_reports')
      .update({
        status: 'completed',
        content,
        summary_line: content.summary_line || null,
        kpi_snapshot: kpi,
        generated_at: new Date().toISOString(),
      })
      .eq('id', report.id)
      .select()
      .single();

    if (updateError) throw updateError;
    return updated;
  } catch (err) {
    // Mark as failed
    await supabase
      .from('ai_reports')
      .update({
        status: 'failed',
        retry_count: report.retry_count + 1,
        error_message: err.message,
      })
      .eq('id', report.id);

    throw err;
  }
}

/**
 * Retry a failed report. Increments retry_count, re-generates content.
 */
export async function retryReport(reportId) {
  const { data: report, error } = await supabase
    .from('ai_reports')
    .select('*')
    .eq('id', reportId)
    .single();

  if (error) throw error;
  if (!report) throw new Error(`Report ${reportId} not found`);
  if (report.status !== 'failed') throw new Error(`Report ${reportId} is not in failed status`);

  // Set back to generating
  await supabase
    .from('ai_reports')
    .update({ status: 'generating', error_message: null })
    .eq('id', reportId);

  try {
    const { input, kpi } = await collectReportInput(
      report.type, report.period_start, report.period_end, report.agent_ids
    );
    const content = await callLLM(report.type, input);

    if (report.type !== 'daily') {
      content.appendix = {
        supplyChains: input.supplyChains,
        countryDistribution: input.countryTop5,
        topProducts: input.topProducts,
      };
    }

    const { data: updated, error: updateError } = await supabase
      .from('ai_reports')
      .update({
        status: 'completed',
        content,
        summary_line: content.summary_line || null,
        kpi_snapshot: kpi,
        generated_at: new Date().toISOString(),
        retry_count: report.retry_count + 1,
      })
      .eq('id', reportId)
      .select()
      .single();

    if (updateError) throw updateError;
    return updated;
  } catch (err) {
    await supabase
      .from('ai_reports')
      .update({
        status: 'failed',
        retry_count: report.retry_count + 1,
        error_message: err.message,
      })
      .eq('id', reportId);

    throw err;
  }
}

/**
 * Check if a report already exists for the given type and period.
 */
export async function reportExists(type, periodStart, periodEnd) {
  const { data, error } = await supabase
    .from('ai_reports')
    .select('id, status')
    .eq('type', type)
    .eq('period_start', periodStart)
    .eq('period_end', periodEnd)
    .eq('agent_ids', '{}')
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows
  return data || null;
}
