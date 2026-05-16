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
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const prevTo = new Date(from.getTime());
  const prevFrom = new Date(prevTo.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    range_key: RANGE_DAYS[key] ? key : '30d',
    days,
    from: from.toISOString(),
    to: to.toISOString(),
    prev_from: prevFrom.toISOString(),
    prev_to: prevTo.toISOString(),
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

async function aggregateLlm({ admin, tenantId, productLine, fromISO, toISO }) {
  const { data, error } = await admin
    .from('llm_usage_logs')
    .select('call_site, model, prompt_tokens, completion_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd, created_at')
    .eq('tenant_id', tenantId)
    .eq('product_line', productLine)
    .gte('created_at', fromISO)
    .lt('created_at', toISO);

  if (error) throw new Error(error.message);

  const totals = emptyTotals();
  const byCallSite = {};
  const byModel = {};
  const byDay = {};

  for (const row of data || []) {
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
  const { data, error } = await admin
    .from('llm_usage_logs')
    .select('call_site, cost_usd')
    .eq('tenant_id', tenantId)
    .is('product_line', null)
    .gte('created_at', fromISO)
    .lt('created_at', toISO)
    .in('call_site', ['ogilvy.turn', 'ogilvy.web_search', 'ogilvy.read_webpage', 'ogilvy.image-gen']);

  if (error) throw new Error(error.message);

  const buckets = { 'ogilvy.turn': 0, 'ogilvy.web_search': 0, 'ogilvy.read_webpage': 0, 'ogilvy.image-gen': 0 };
  let total = 0;
  let imageCount = 0;
  for (const row of data || []) {
    const v = Number(row.cost_usd) || 0;
    buckets[row.call_site] = (buckets[row.call_site] || 0) + v;
    total += v;
    if (row.call_site === 'ogilvy.image-gen') imageCount += 1;
  }
  return {
    total_usd: total,
    by_call_site: buckets,
    image_count: imageCount,
  };
}

async function aggregateVolume({ admin, tenantId, productLine, fromISO, toISO }) {
  // 1) conversations 通过 product_line 直查
  const { data: convRows, error: convErr } = await admin
    .from('conversations')
    .select('id, started_at')
    .eq('tenant_id', tenantId)
    .eq('product_line', productLine)
    .gte('started_at', fromISO)
    .lt('started_at', toISO);
  if (convErr) throw new Error(convErr.message);

  const conversations = convRows?.length || 0;
  const convIds = (convRows || []).map(r => r.id);

  // 2) messages: 区分 inbound / outbound (role = 'user' / 'assistant')
  let msgsIn = 0;
  let msgsOut = 0;
  if (convIds.length > 0) {
    // 大产品线 conv 数会上千,select count + filter by conversation_id IN 太慢,
    // 拆 head=true count 跑两次更稳。
    const [{ count: inCount, error: e1 }, { count: outCount, error: e2 }] = await Promise.all([
      admin
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .in('conversation_id', convIds)
        .eq('role', 'user')
        .gte('sent_at', fromISO)
        .lt('sent_at', toISO),
      admin
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .in('conversation_id', convIds)
        .eq('role', 'assistant')
        .gte('sent_at', fromISO)
        .lt('sent_at', toISO),
    ]);
    if (e1) throw new Error(e1.message);
    if (e2) throw new Error(e2.message);
    msgsIn = inCount || 0;
    msgsOut = outCount || 0;
  }

  // 3) qualified leads
  let leadsQualified = 0;
  if (convIds.length > 0) {
    const { count, error } = await admin
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .in('conversation_id', convIds)
      .in('inquiry_quality', ['GOOD', 'EXCELLENT']);
    if (error) throw new Error(error.message);
    leadsQualified = count || 0;
  }

  // 4) KB documents processed in period
  const { count: kbDocs, error: kbErr } = await admin
    .from('kb_documents')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLine)
    .gte('created_at', fromISO)
    .lt('created_at', toISO);
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
