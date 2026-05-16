/**
 * GET /api/product-lines/[id]/cost-stats?range=7d|30d|90d
 *
 * 成本分析 tab 的数据源。聚合「能挂到这条产品线的」LLM token 成本
 * (medici.qualify / kb.search.* / kb_asset_linker.match / kb.upload.* /
 * knowledge.teach.extract / contacts.profile.summary / report-generator.*)
 * + 量化指标(对话数 / 消息数 / 合格线索数)。
 *
 * 不在此返回:
 *   - Meta 广告花费(前端单独调 /api/ads/dashboard?productLine=<id> 拿,
 *     避免重复实现 Meta API 拉取 + 缓存)
 *   - Ogilvy 工作台调用 (ogilvy.turn / ogilvy.web_search / ogilvy.read_webpage)
 *     和 ogilvy.image-gen 图片生成:这部分 product_line=NULL,单独算租户级,
 *     UI 上以"工作台占用"独立 section 展示
 *   - inquiry-dashboard.summary / dev-tools.ai-sql / ai-report.* (租户级)
 *
 * 老行处理:product_line 列上线前的所有数据 product_line IS NULL,这部分对
 * 单产品线视图不可见;UI 上若需要历史数据由 supabase/operations 的 backfill
 * 脚本反推后再显示。
 */
import { getTenantContext } from '../../../../../lib/tenant-context.js';
import { findProductLineById } from '../../../../../lib/repositories/product-line.repository.js';
import { getSupabaseAdmin } from '../../../../../lib/supabase-admin.js';

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

function parseRange(searchParams) {
  const key = String(searchParams.get('range') || '30d');
  const days = RANGE_DAYS[key] || 30;
  // 对齐 UTC 整天边界:to = 明天 UTC 00:00 (exclusive 上限,覆盖今天到 24:00),
  // from = to - days*86400000。这样和 dayBucket()(取 ISO yyyy-mm-dd UTC)
  // / UI 的 fillMissingDays(按 UTC 日历日填充)三者口径一致,KPI 总和不会和
  // 柱图各天加总对不上。
  const now = new Date();
  const todayMidnightUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const DAY_MS = 24 * 60 * 60 * 1000;
  const toMs = todayMidnightUtc + DAY_MS;
  const fromMs = toMs - days * DAY_MS;
  const prevToMs = fromMs;
  const prevFromMs = prevToMs - days * DAY_MS;
  return {
    range_key: RANGE_DAYS[key] ? key : '30d',
    days,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    prev_from: new Date(prevFromMs).toISOString(),
    prev_to: new Date(prevToMs).toISOString(),
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
  // YYYY-MM-DD (UTC),前端按本地时区显示堆叠柱图
  return String(createdAt || '').slice(0, 10);
}

// PostgREST 默认 max_rows=1000;30 天产品线 LLM 调用动辄上千行,要翻页。
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

async function aggregateLlm({ admin, tenantId, productLine, fromISO, toISO }) {
  const totals = emptyTotals();
  const byCallSite = {};
  const byModel = {};
  const byDay = {};

  // tie-breaker by id 保证两条 created_at 完全相同的行不会跨页错位
  // (高并发写入下 microsecond 时间戳偶尔会撞)。
  const builder = () => admin
    .from('llm_usage_logs')
    .select('call_site, model, prompt_tokens, completion_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd, created_at')
    .eq('tenant_id', tenantId)
    .eq('product_line', productLine)
    .gte('created_at', fromISO)
    .lt('created_at', toISO)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  for await (const row of streamLlmRows(builder)) {
    bumpBucket(totals, row);
    const cs = row.call_site || 'unknown';
    if (!byCallSite[cs]) byCallSite[cs] = emptyTotals();
    bumpBucket(byCallSite[cs], row);

    const m = row.model || 'unknown';
    if (!byModel[m]) byModel[m] = emptyTotals();
    bumpBucket(byModel[m], row);

    const d = dayBucket(row.created_at);
    if (!byDay[d]) byDay[d] = { day: d, cost_usd: 0, count: 0 };
    byDay[d].cost_usd += Number(row.cost_usd) || 0;
    byDay[d].count += 1;
  }

  return {
    totals,
    by_call_site: byCallSite,
    by_model: byModel,
    by_day: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
  };
}

// Ogilvy + image-gen 是 tenant 级、不挂产品线。但用户问"本期 Ogilvy 用了多少"
// 仍然有意义,所以 dashboard 顶部会显示一个 informational 数字。
async function aggregateTenantOgilvy({ admin, tenantId, fromISO, toISO }) {
  const builder = () => admin
    .from('llm_usage_logs')
    .select('call_site, cost_usd')
    .eq('tenant_id', tenantId)
    .is('product_line', null)
    .gte('created_at', fromISO)
    .lt('created_at', toISO)
    .in('call_site', ['ogilvy.turn', 'ogilvy.web_search', 'ogilvy.read_webpage', 'ogilvy.image-gen'])
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });

  let reasoningUsd = 0;
  let imageUsd = 0;
  let reasoningCount = 0;
  let imageCount = 0;
  for await (const row of streamLlmRows(builder)) {
    const v = Number(row.cost_usd) || 0;
    if (row.call_site === 'ogilvy.image-gen') {
      imageUsd += v;
      imageCount += 1;
    } else {
      // ogilvy.turn / ogilvy.web_search / ogilvy.read_webpage 都是 LLM 推理
      reasoningUsd += v;
      reasoningCount += 1;
    }
  }
  return {
    total_usd: reasoningUsd + imageUsd,
    reasoning_usd: reasoningUsd,
    reasoning_count: reasoningCount,
    image_usd: imageUsd,
    image_count: imageCount,
  };
}

// "合格线索" = inquiry_quality 在 GOOD / QUALIFY / PROOF 中(详见 medici
// skill host §1-3:BAD < GOOD < QUALIFY < PROOF)。EXCELLENT 不是有效值;
// 早期实现写成 GOOD+EXCELLENT 会漏掉真正高质量的 PROOF/QUALIFY 行。
const QUALIFIED_LEADS = ['GOOD', 'QUALIFY', 'PROOF'];

// 用 PostgREST 的 !inner 嵌入资源过滤直接按 conversations.product_line = X
// 单次 count,免去把上千个 conv_id 拼进 .in() 撑爆 URL,数据库一次 join 完事。
// 关键:metrics 的时间口径必须跟 llm.totals 一致 —— 都是"本期发生 sent_at /
// created_at",不能只看"本期新开会话",否则单消息 LLM 成本这种比值的分子分母
// 会错位。
async function countMessagesByRole({ admin, tenantId, productLine, role, fromISO, toISO }) {
  const { count, error } = await admin
    .from('messages')
    .select('id, conversations!inner(product_line)', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('conversations.product_line', productLine)
    .eq('role', role)
    .gte('sent_at', fromISO)
    .lt('sent_at', toISO);
  if (error) throw new Error(error.message);
  return count || 0;
}

async function countQualifiedLeads({ admin, tenantId, productLine, fromISO, toISO }) {
  const { count, error } = await admin
    .from('leads')
    .select('id, conversations!inner(product_line)', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('conversations.product_line', productLine)
    .in('inquiry_quality', QUALIFIED_LEADS)
    .gte('created_at', fromISO)
    .lt('created_at', toISO);
  if (error) throw new Error(error.message);
  return count || 0;
}

async function countNewConversations({ admin, tenantId, productLine, fromISO, toISO }) {
  const { count, error } = await admin
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('product_line', productLine)
    .gte('started_at', fromISO)
    .lt('started_at', toISO);
  if (error) throw new Error(error.message);
  return count || 0;
}

async function aggregateVolume({ admin, tenantId, productLine, fromISO, toISO }) {
  // 四个 count 全部用 head=true,各自一次查询,彼此独立、并行。
  // 「对话数」= 本期新开 conv;其余三个 = 本期发生的入/出消息 + 合格线索,
  // 跟 llm.totals 的"本期发生"口径对齐。
  const [conversations, msgsIn, msgsOut, leadsQualified, { count: kbDocs, error: kbErr }] = await Promise.all([
    countNewConversations({ admin, tenantId, productLine, fromISO, toISO }),
    countMessagesByRole({ admin, tenantId, productLine, role: 'user', fromISO, toISO }),
    countMessagesByRole({ admin, tenantId, productLine, role: 'assistant', fromISO, toISO }),
    countQualifiedLeads({ admin, tenantId, productLine, fromISO, toISO }),
    admin
      .from('kb_documents')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('product_line_id', productLine)
      .gte('created_at', fromISO)
      .lt('created_at', toISO),
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

  try {
    const admin = getSupabaseAdmin();

    // 当前期 LLM + 上期 LLM + Ogilvy 租户级 + volume 并行
    const [current, previous, ogilvy, volume] = await Promise.all([
      aggregateLlm({ admin, tenantId: ctx.tenantId, productLine: id, fromISO: range.from, toISO: range.to }),
      aggregateLlm({ admin, tenantId: ctx.tenantId, productLine: id, fromISO: range.prev_from, toISO: range.prev_to }),
      aggregateTenantOgilvy({ admin, tenantId: ctx.tenantId, fromISO: range.from, toISO: range.to }),
      aggregateVolume({ admin, tenantId: ctx.tenantId, productLine: id, fromISO: range.from, toISO: range.to }),
    ]);

    return Response.json({
      product_line: id,
      range,
      llm: current,
      llm_prev: { totals: previous.totals },
      ogilvy_tenant: ogilvy,
      volume,
    });
  } catch (err) {
    console.error('[product-lines/[id]/cost-stats GET]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
