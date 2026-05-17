/**
 * GET /api/product-lines/[id]/cost-stats?preset=all|1d|7d|30d|365d|custom&from=&to=
 *
 * 成本分析 tab 的数据源。从 2026-05-17 起 Ogilvy 工作台也按产品线绑定,
 * 这里把"能挂到本产品线的所有 LLM 成本"分两块返回:
 *
 *   - medici:   medici.qualify / kb.* / knowledge.teach.extract /
 *               contacts.profile.summary / report-generator.* / kb.image-extract.*
 *               (运营产品线本身花的钱)
 *   - ogilvy:   ogilvy.turn / ogilvy.web_search / ogilvy.read_webpage /
 *               ogilvy.image-gen (策划广告创意花的钱)
 *
 * 时间窗口跟 leadhub 一致:lib/date-range-presets.js,yesterday-aligned 北京时区。
 *
 * 量化指标 (volume) + 上期对比 (medici_prev / ogilvy_prev) 一并返回。
 *
 * 不在此返回:
 *   - Meta 广告花费(前端单独调 /api/ads/dashboard?productLine=<id>)
 *   - inquiry-dashboard.summary / dev-tools.ai-sql / ai-report.* (租户级)
 */
import { getTenantContext } from '../../../../../lib/tenant-context.js';
import { findProductLineById } from '../../../../../lib/repositories/product-line.repository.js';
import { getSupabaseAdmin } from '../../../../../lib/supabase-admin.js';
import { resolveDateRange, resolvePrevDateRange, PRESET_DAYS } from '../../../../../lib/date-range-presets.js';
import {
  COST_STATS_FLOOR_ISO,
  COST_STATS_FLOOR_LABEL,
  clampToCostFloor,
} from '../../../../../lib/cost-stats-floor.js';

// 区分 medici-class vs ogilvy-class 的 call_site 前缀
const OGILVY_CALL_SITE_PREFIX = 'ogilvy.';
const OGILVY_IMAGE_CALL_SITE = 'ogilvy.image-gen';

function parseRange(searchParams) {
  const preset = String(searchParams.get('preset') || 'all');
  const customFrom = searchParams.get('from') || '';
  const customTo = searchParams.get('to') || '';
  const { dateFrom, dateTo } = resolveDateRange(preset, customFrom, customTo);
  const prev = resolvePrevDateRange(preset);
  return {
    preset,
    from: dateFrom || null,
    to: dateTo || null,
    prev_from: prev.dateFrom || null,
    prev_to: prev.dateTo || null,
    days: PRESET_DAYS[preset] || null,
  };
}

function emptyTotals() {
  return { prompt: 0, completion: 0, cache_read: 0, cache_create: 0, cost_usd: 0, count: 0 };
}

function bumpBucket(b, row) {
  b.prompt += row.prompt_tokens || 0;
  b.completion += row.completion_tokens || 0;
  b.cache_read += row.cache_read_input_tokens || 0;
  b.cache_create += row.cache_creation_input_tokens || 0;
  b.cost_usd += Number(row.cost_usd) || 0;
  b.count += 1;
}

function dayBucket(createdAt) {
  // YYYY-MM-DD 切片;dayBucket 算的是 UTC 日历日。UI 把柱图横轴标签转成
  // 本地展示即可,聚合本身与时区无关。
  return String(createdAt || '').slice(0, 10);
}

const LLM_PAGE = 1000;
async function* streamLlmRows(builder) {
  let offset = 0;
  while (true) {
    const { data, error } = await builder().range(offset, offset + LLM_PAGE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return;
    for (const row of data) yield row;
    if (data.length < LLM_PAGE) return;
    offset += LLM_PAGE;
  }
}

/**
 * 拉本产品线在窗内所有 LLM 调用,按 medici-class / ogilvy-class 分桶 ——
 * 一次扫描两份结果,避免两次往返。
 */
async function aggregateLlmSplit({ admin, tenantId, productLine, fromISO, toISO }) {
  const medici = { totals: emptyTotals(), by_call_site: {}, by_model: {}, by_day: {} };
  const ogilvy = {
    totals: emptyTotals(),
    reasoning_usd: 0,
    reasoning_count: 0,
    image_usd: 0,
    image_count: 0,
    by_call_site: {},
    by_model: {},
    by_day: {},
  };

  const builderBase = () => admin
    .from('llm_usage_logs')
    .select('call_site, model, prompt_tokens, completion_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd, created_at')
    .eq('tenant_id', tenantId)
    .eq('product_line', productLine);
  const builder = () => {
    let q = builderBase();
    if (fromISO) q = q.gte('created_at', fromISO);
    if (toISO) q = q.lt('created_at', toISO);
    return q
      .order('created_at', { ascending: true })
      .order('id', { ascending: true });
  };

  for await (const row of streamLlmRows(builder)) {
    const isOgilvy = (row.call_site || '').startsWith(OGILVY_CALL_SITE_PREFIX);
    const target = isOgilvy ? ogilvy : medici;

    bumpBucket(target.totals, row);
    const cs = row.call_site || 'unknown';
    if (!target.by_call_site[cs]) target.by_call_site[cs] = emptyTotals();
    bumpBucket(target.by_call_site[cs], row);
    const m = row.model || 'unknown';
    if (!target.by_model[m]) target.by_model[m] = emptyTotals();
    bumpBucket(target.by_model[m], row);
    const d = dayBucket(row.created_at);
    if (!target.by_day[d]) target.by_day[d] = { day: d, cost_usd: 0, count: 0 };
    target.by_day[d].cost_usd += Number(row.cost_usd) || 0;
    target.by_day[d].count += 1;

    if (isOgilvy) {
      const v = Number(row.cost_usd) || 0;
      if (row.call_site === OGILVY_IMAGE_CALL_SITE) {
        ogilvy.image_usd += v;
        ogilvy.image_count += 1;
      } else {
        ogilvy.reasoning_usd += v;
        ogilvy.reasoning_count += 1;
      }
    }
  }

  // by_day 数组化排序,by_call_site / by_model 在前端排序方便
  medici.by_day = Object.values(medici.by_day).sort((a, b) => a.day.localeCompare(b.day));
  ogilvy.by_day = Object.values(ogilvy.by_day).sort((a, b) => a.day.localeCompare(b.day));
  return { medici, ogilvy };
}

async function aggregateLlmTotals({ admin, tenantId, productLine, fromISO, toISO }) {
  // 上期对比只要总数,不展开分桶 —— 单查 head=true 的两组 sum 也行但 PostgREST
  // 不原生支持 SUM,只能跑普通 select 用流式扫一遍。范围小不是问题。
  let mediciCost = 0;
  let ogilvyCost = 0;
  const builderBase = () => admin
    .from('llm_usage_logs')
    .select('call_site, cost_usd')
    .eq('tenant_id', tenantId)
    .eq('product_line', productLine);
  const builder = () => {
    let q = builderBase();
    if (fromISO) q = q.gte('created_at', fromISO);
    if (toISO) q = q.lt('created_at', toISO);
    return q.order('created_at', { ascending: true }).order('id', { ascending: true });
  };
  for await (const row of streamLlmRows(builder)) {
    const v = Number(row.cost_usd) || 0;
    if ((row.call_site || '').startsWith(OGILVY_CALL_SITE_PREFIX)) ogilvyCost += v;
    else mediciCost += v;
  }
  return { medici_cost_usd: mediciCost, ogilvy_cost_usd: ogilvyCost };
}

const QUALIFIED_LEADS = ['GOOD', 'QUALIFY', 'PROOF'];

async function countMessagesByRole({ admin, tenantId, productLine, role, fromISO, toISO }) {
  let q = admin
    .from('messages')
    .select('id, conversations!inner(product_line)', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('conversations.product_line', productLine)
    .eq('role', role);
  if (fromISO) q = q.gte('sent_at', fromISO);
  if (toISO) q = q.lt('sent_at', toISO);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

async function countQualifiedLeads({ admin, tenantId, productLine, fromISO, toISO }) {
  let q = admin
    .from('leads')
    .select('id, conversations!inner(product_line)', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('conversations.product_line', productLine)
    .in('inquiry_quality', QUALIFIED_LEADS);
  if (fromISO) q = q.gte('created_at', fromISO);
  if (toISO) q = q.lt('created_at', toISO);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

async function countNewConversations({ admin, tenantId, productLine, fromISO, toISO }) {
  let q = admin
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('product_line', productLine);
  if (fromISO) q = q.gte('started_at', fromISO);
  if (toISO) q = q.lt('started_at', toISO);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count || 0;
}

async function aggregateVolume({ admin, tenantId, productLine, fromISO, toISO }) {
  const kbBuilder = (() => {
    let q = admin
      .from('kb_documents')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('product_line_id', productLine);
    if (fromISO) q = q.gte('created_at', fromISO);
    if (toISO) q = q.lt('created_at', toISO);
    return q;
  })();
  const [conversations, msgsIn, msgsOut, leadsQualified, { count: kbDocs, error: kbErr }] = await Promise.all([
    countNewConversations({ admin, tenantId, productLine, fromISO, toISO }),
    countMessagesByRole({ admin, tenantId, productLine, role: 'user', fromISO, toISO }),
    countMessagesByRole({ admin, tenantId, productLine, role: 'assistant', fromISO, toISO }),
    countQualifiedLeads({ admin, tenantId, productLine, fromISO, toISO }),
    kbBuilder,
  ]);
  if (kbErr) throw new Error(kbErr.message);

  return {
    conversations,
    msgs_in: msgsIn,
    msgs_out: msgsOut,
    leads_qualified: leadsQualified,
    kb_docs: kbDocs || 0,
  };
}

export async function GET(request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const line = await findProductLineById({ tenantId: ctx.tenantId, id });
  if (!line) return Response.json({ error: 'Not found' }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const range = parseRange(searchParams);

  // 硬下限 —— 优先级高于用户选择的时间窗。详见 lib/cost-stats-floor.js。
  const curr = clampToCostFloor(range.from, range.to);
  const prevClamp = range.prev_from && range.prev_to
    ? clampToCostFloor(range.prev_from, range.prev_to)
    : { empty: true };
  // 下限抬升后,前一年/三十天的 days 数字已与实际可绘制天数不符 —— 让前端
  // 跳过"按 N 天补零"分支,直接画返回的天数。
  const effectiveRange = {
    ...range,
    from: curr.fromISO,
    to: curr.toISO,
    days: curr.floored ? null : range.days,
    floor_iso: COST_STATS_FLOOR_ISO,
    floor_label: COST_STATS_FLOOR_LABEL,
    floored: curr.floored,
  };

  try {
    const admin = getSupabaseAdmin();
    const emptyLlmTotals = { medici_cost_usd: 0, ogilvy_cost_usd: 0 };
    const [split, prev, volume] = await Promise.all([
      curr.empty
        ? Promise.resolve({
            medici: { totals: emptyTotals(), by_call_site: {}, by_model: {}, by_day: [] },
            ogilvy: {
              totals: emptyTotals(), reasoning_usd: 0, reasoning_count: 0,
              image_usd: 0, image_count: 0,
              by_call_site: {}, by_model: {}, by_day: [],
            },
          })
        : aggregateLlmSplit({ admin, tenantId: ctx.tenantId, productLine: id, fromISO: curr.fromISO, toISO: curr.toISO }),
      // 'all' / 'custom' 上期没意义,prev_from/to 为空 → empty=true → 直接 0。
      // 同样,如果上期窗口整段在 floor 之前(目前常态),也回 0。
      prevClamp.empty
        ? Promise.resolve(emptyLlmTotals)
        : aggregateLlmTotals({ admin, tenantId: ctx.tenantId, productLine: id, fromISO: prevClamp.fromISO, toISO: prevClamp.toISO }),
      curr.empty
        ? Promise.resolve({ conversations: 0, msgs_in: 0, msgs_out: 0, leads_qualified: 0, kb_docs: 0 })
        : aggregateVolume({ admin, tenantId: ctx.tenantId, productLine: id, fromISO: curr.fromISO, toISO: curr.toISO }),
    ]);

    return Response.json({
      product_line: id,
      range: effectiveRange,
      medici: split.medici,
      ogilvy: split.ogilvy,
      medici_prev: { cost_usd: prev.medici_cost_usd },
      ogilvy_prev: { cost_usd: prev.ogilvy_cost_usd },
      volume,
    });
  } catch (err) {
    console.error('[product-lines/[id]/cost-stats GET]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
