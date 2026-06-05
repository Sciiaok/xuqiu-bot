import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';

/**
 * GET /api/admin/llm-usage?from=ISO&to=ISO
 *
 * Founder-only。聚合 llm_usage_logs，返回时间范围内：
 *   - range: { from, to, days, tz }
 *   - totals: { calls, errors, prompt_tokens, completion_tokens, total_tokens, cost_usd,
 *              avg_cost_per_call, avg_duration_ms, p50_duration_ms, p95_duration_ms,
 *              cost_per_day, calls_per_day, sampled_for_latency, cache_*_tokens }
 *     注：avg_cost_per_call / avg_duration_ms / 百分位 都只算"成功调用"，排除 finish_reason='error:%'。
 *   - byTenant / byCallSite / byModel / byProvider:
 *       [{ key/name, calls, errors, prompt_tokens, completion_tokens, cost_usd,
 *          avg_duration_ms, share }]   share = cost_usd / totals.cost_usd
 *     注：byCallSite 会折叠掉 'foo(chunk-info)' 这种分块后缀，归并到 'foo'。
 *   - byDay: [{ day:'YYYY-MM-DD' (Asia/Shanghai), calls, prompt_tokens, completion_tokens, cost_usd }]
 *   - byHour: 同上，按小时（CN 时区）
 *   - notes.untracked_paths / notes.untagged_rows: 给前端的方法论披露
 *   - sampleSize, capped (true if hit 50000 limit), hasCacheCols
 *
 * 没传 from/to 默认查最近 30 天。
 */

// 报表展示一律用 Asia/Shanghai。created_at 存的是 UTC，分桶时要换算到这个 tz；
// 不依赖任何 tz 库，因为 CN 自 1991 起常年 UTC+8 无 DST，直接以 ms 偏移处理即可。
const TZ = 'Asia/Shanghai';
const TZ_OFFSET_MS = 8 * 3600 * 1000;

// 失败行用 finish_reason 前缀识别。llm-client 在抛错时写入 'error: <message>'，
// 0 tokens / 0 cost / 有 duration_ms。从延迟百分位 / 平均成本里剔除，否则失败
// 的 fast-fail 会把均值压偏。calls 计数照常算（用户要知道总调用次数）。
function isErrorRow(row) {
  const r = row?.finish_reason;
  return typeof r === 'string' && r.startsWith('error:');
}

// 分块 KB 抽取会把 chunk 信息塞进 call_site，比如：
//   kb.upload.extract-points(01-乘用车#82-161)
//   kb.upload.extract-points(01-乘用车#162-225)
// 这是单一逻辑调用部位的分片记录，按部位聚合时应折叠成 kb.upload.extract-points。
// 其它字段（tenant / 模型 / day / hour）不动。
function normalizeCallSite(s) {
  if (!s) return 'unknown';
  return s.replace(/\s*\([^)]*\)\s*$/, '');
}

// Format Date → 'YYYY-MM-DD' / 'YYYY-MM-DD HH:00' in Asia/Shanghai.
// 不用 Intl.DateTimeFormat 走 cache miss——直接在 UTC ms 上加 +8h 偏移再切片。
function dayKey(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t + TZ_OFFSET_MS).toISOString().slice(0, 10);
}
function hourKey(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t + TZ_OFFSET_MS).toISOString().slice(0, 13).replace('T', ' ') + ':00';
}

export async function GET(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (ctx.tenantId !== FOUNDER_TENANT_ID) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const url = new URL(request.url);
    const toIso = url.searchParams.get('to') || new Date().toISOString();
    const fromIso = url.searchParams.get('from') ||
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const admin = getSupabaseAdmin();

    // PostgREST 默认每次 1000 行上限，单纯 .limit(N) 不能突破。分页拉满上限。
    // cache_*_tokens 列在 2026-05-13 migration 才加上。第一页探测：失败（42703）
    // 退回老 schema，整窗口都按老列拉，避免每页都重试。
    //
    // 排序加 id 兜底：created_at DESC 单字段在并发写入产生同毫秒戳时不稳定，
    // 跨页边界可能漏行/重行。UUID 不可比但 PostgREST 接受字符串排序，足够稳。
    const PAGE_SIZE = 1000;
    const ROW_LIMIT = 50000;
    const FULL_COLS = 'tenant_id, call_site, provider, model, prompt_tokens, completion_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd, duration_ms, finish_reason, created_at, id';
    const BASE_COLS = 'tenant_id, call_site, provider, model, prompt_tokens, completion_tokens, cost_usd, duration_ms, finish_reason, created_at, id';
    let hasCacheCols = true;
    let selectCols = FULL_COLS;
    const rows = [];
    for (let from = 0; from < ROW_LIMIT; from += PAGE_SIZE) {
      const to = Math.min(from + PAGE_SIZE - 1, ROW_LIMIT - 1);
      const { data: page, error } = await admin
        .from('llm_usage_logs')
        .select(selectCols)
        .gte('created_at', fromIso)
        .lte('created_at', toIso)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, to);
      if (error) {
        // 仅首页且是 missing-column 时降级；其它情况直接抛
        if (from === 0 && hasCacheCols
            && (error.code === '42703' || /column .* does not exist/i.test(error.message || ''))) {
          hasCacheCols = false;
          selectCols = BASE_COLS;
          from -= PAGE_SIZE;  // 重试同一页
          continue;
        }
        throw error;
      }
      if (!page || page.length === 0) break;
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const { data: tenants } = await admin.from('tenants').select('id, name, slug');
    const tenantNameById = new Map((tenants || []).map(t => [t.id, t.name || t.slug || t.id]));

    const totals = {
      calls: 0, errors: 0,
      prompt_tokens: 0, completion_tokens: 0,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      cost_usd: 0,
    };
    const byTenant = new Map();
    const byCallSite = new Map();
    const byModel = new Map();
    const byProvider = new Map();
    const byDay = new Map();
    const byHour = new Map();

    const bumpBucket = (map, key, row, errored) => {
      const cur = map.get(key) || {
        key,
        calls: 0,
        errors: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cost_usd: 0,
        duration_sum: 0,
        duration_count: 0,
      };
      cur.calls += 1;
      if (errored) cur.errors += 1;
      cur.prompt_tokens += row.prompt_tokens || 0;
      cur.completion_tokens += row.completion_tokens || 0;
      cur.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
      cur.cache_read_input_tokens += row.cache_read_input_tokens || 0;
      cur.cost_usd += Number(row.cost_usd) || 0;
      // 延迟只统计成功行 —— 失败 fast-fail 会把均值压偏。
      if (!errored && row.duration_ms != null) {
        cur.duration_sum += row.duration_ms;
        cur.duration_count += 1;
      }
      map.set(key, cur);
    };

    // 诊断：未埋点（call_site === 'unknown' 或 tenant_id 为 null）。两个条件
    // 重合大概率指向同一缺埋点路径，分开统计便于排查。
    let untaggedCallSite = 0;
    let untaggedTenant = 0;

    for (const r of rows || []) {
      const errored = isErrorRow(r);
      totals.calls += 1;
      if (errored) totals.errors += 1;
      totals.prompt_tokens += r.prompt_tokens || 0;
      totals.completion_tokens += r.completion_tokens || 0;
      totals.cache_creation_input_tokens += r.cache_creation_input_tokens || 0;
      totals.cache_read_input_tokens += r.cache_read_input_tokens || 0;
      totals.cost_usd += Number(r.cost_usd) || 0;

      if (!r.call_site || r.call_site === 'unknown') untaggedCallSite += 1;
      if (!r.tenant_id) untaggedTenant += 1;

      bumpBucket(byTenant, r.tenant_id || '__null__', r, errored);
      bumpBucket(byCallSite, normalizeCallSite(r.call_site), r, errored);
      bumpBucket(byModel, r.model || 'unknown', r, errored);
      bumpBucket(byProvider, r.provider || 'unknown', r, errored);

      const day = dayKey(r.created_at);
      if (day) bumpBucket(byDay, day, r, errored);
      const hour = hourKey(r.created_at);
      if (hour) bumpBucket(byHour, hour, r, errored);
    }

    // 延迟百分位/均值：剔除错误行后排序。成功率高时这是 noop；失败行多时区别明显。
    const successRows = (rows || []).filter(r => !isErrorRow(r));
    const durations = successRows.map(r => r.duration_ms).filter(d => d != null && d >= 0);
    durations.sort((a, b) => a - b);
    const pct = (p) => {
      if (durations.length === 0) return null;
      const idx = Math.min(durations.length - 1, Math.floor(durations.length * p));
      return durations[idx];
    };
    const avgDur = durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null;

    const days = Math.max(1, Math.round((new Date(toIso) - new Date(fromIso)) / 86400000));
    const totalCost = round6(totals.cost_usd);
    // 成功调用：用于人均成本——失败 0 成本会把 avg_cost_per_call 压偏。
    const successfulCalls = totals.calls - totals.errors;

    const metrics = (b) => ({
      calls: b.calls,
      errors: b.errors,
      prompt_tokens: b.prompt_tokens,
      completion_tokens: b.completion_tokens,
      cache_creation_input_tokens: b.cache_creation_input_tokens,
      cache_read_input_tokens: b.cache_read_input_tokens,
      cost_usd: round6(b.cost_usd),
      avg_duration_ms: b.duration_count ? Math.round(b.duration_sum / b.duration_count) : null,
      share: totalCost > 0 ? b.cost_usd / totalCost : 0,
    });
    const sortByCost = (a, b) => b.cost_usd - a.cost_usd;

    const tenantList = [...byTenant.values()].map(b => ({
      tenant_id: b.key === '__null__' ? null : b.key,
      tenant_name: b.key === '__null__'
        ? '(未埋点 / tenant 已删除)'
        : (tenantNameById.get(b.key) || b.key),
      ...metrics(b),
    })).sort(sortByCost);

    const callSiteList = [...byCallSite.values()].map(b => ({ call_site: b.key, ...metrics(b) })).sort(sortByCost);
    const modelList    = [...byModel.values()   ].map(b => ({ model:     b.key, ...metrics(b) })).sort(sortByCost);
    const providerList = [...byProvider.values()].map(b => ({ provider:  b.key, ...metrics(b) })).sort(sortByCost);

    // byDay：补齐范围内每一天，方便趋势图连续（按 CN 时区枚举）
    const dayKeys = enumerateDays(fromIso, toIso);
    const dayList = dayKeys.map(day => {
      const b = byDay.get(day);
      return {
        day,
        calls: b?.calls || 0,
        errors: b?.errors || 0,
        prompt_tokens: b?.prompt_tokens || 0,
        completion_tokens: b?.completion_tokens || 0,
        cost_usd: round6(b?.cost_usd || 0),
      };
    });

    // byHour：同上，按小时补齐（按 CN 时区枚举）
    const hourKeys = enumerateHours(fromIso, toIso);
    const hourList = hourKeys.map(hour => {
      const b = byHour.get(hour);
      return {
        hour,
        calls: b?.calls || 0,
        errors: b?.errors || 0,
        prompt_tokens: b?.prompt_tokens || 0,
        completion_tokens: b?.completion_tokens || 0,
        cost_usd: round6(b?.cost_usd || 0),
      };
    });

    return NextResponse.json({
      range: { from: fromIso, to: toIso, days, tz: TZ },
      totals: {
        calls: totals.calls,
        errors: totals.errors,
        successful_calls: successfulCalls,
        prompt_tokens: totals.prompt_tokens,
        completion_tokens: totals.completion_tokens,
        total_tokens: totals.prompt_tokens + totals.completion_tokens,
        cache_creation_input_tokens: totals.cache_creation_input_tokens,
        cache_read_input_tokens: totals.cache_read_input_tokens,
        cost_usd: totalCost,
        avg_cost_per_call: successfulCalls ? round6(totals.cost_usd / successfulCalls) : 0,
        avg_duration_ms: avgDur,
        p50_duration_ms: pct(0.50),
        p95_duration_ms: pct(0.95),
        cost_per_day: round6(totals.cost_usd / days),
        calls_per_day: Math.round((totals.calls / days) * 10) / 10,
        sampled_for_latency: durations.length,
      },
      byTenant: tenantList,
      byCallSite: callSiteList,
      byModel: modelList,
      byProvider: providerList,
      byDay: dayList,
      byHour: hourList,
      notes: {
        // 方法论披露 —— 看板覆盖范围：
        //  - openrouter.messages.create / stream（所有 chat completion;含 WhatsApp
        //    语音转写,2026-06-05 起从 /audio/transcriptions + whisper-1 切到
        //    /chat/completions + input_audio + Gemini 2.5 Flash Lite）
        //  - openrouter.embeddings.create（KB 向量化，2026-05-18 起埋）
        //  - 图片生成（gpt-image-2 / gpt-image-1 / gemini flash image）
        //
        // 未覆盖：直接走 fetch / SDK 但没经 llm-client 的 ad-hoc 调用——目前没有
        // 已知此类路径。如果新增请走 llm-client。
        //
        // 历史限制：2026-05-18 之前的 embeddings / Whisper 调用未落表，那段时间
        // 这两类成本看板里看不到。
        untracked_paths: [],
        untagged_call_site_rows: untaggedCallSite,
        untagged_tenant_rows: untaggedTenant,
        cost_methodology: 'cost_usd 在写入时由 src/llm-pricing.js 静态价表估算。价格表与上游漂移、图片生成在 response.usage 缺失时回落 flat fee，整体口径仅供参考。',
        latency_excludes_errors: true,
        avg_cost_excludes_errors: true,
        call_site_chunk_suffix_collapsed: true,
        embeddings_tracked_since: '2026-05-18',
        whisper_tracked_since: '2026-05-18',
      },
      sampleSize: rows?.length || 0,
      capped: (rows?.length || 0) >= ROW_LIMIT,
      hasCacheCols,
    });
  } catch (err) {
    console.error('[admin/llm-usage GET] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function round6(n) {
  return Math.round(n * 1_000_000) / 1_000_000;
}

function enumerateDays(fromIso, toIso) {
  const start = dayKey(fromIso);
  const end = dayKey(toIso);
  if (!start || !end) return [];
  // 'YYYY-MM-DD' + CN 偏移 → UTC ms。CN 无 DST，固定 +08:00 安全。
  const startMs = Date.parse(`${start}T00:00:00+08:00`);
  const endMs = Date.parse(`${end}T00:00:00+08:00`);
  const out = [];
  for (let t = startMs; t <= endMs; t += 86400000) {
    out.push(dayKey(new Date(t).toISOString()));
  }
  return out;
}

function enumerateHours(fromIso, toIso) {
  const startKey = hourKey(fromIso);
  const endKey = hourKey(toIso);
  if (!startKey || !endKey) return [];
  const [sd, sh] = startKey.split(' ');
  const [ed, eh] = endKey.split(' ');
  const startMs = Date.parse(`${sd}T${sh}+08:00`);
  const endMs = Date.parse(`${ed}T${eh}+08:00`);
  const out = [];
  for (let t = startMs; t <= endMs; t += 3600 * 1000) {
    out.push(hourKey(new Date(t).toISOString()));
  }
  return out;
}
