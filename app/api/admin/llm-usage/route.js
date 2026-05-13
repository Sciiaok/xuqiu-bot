import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';

/**
 * GET /api/admin/llm-usage?from=ISO&to=ISO
 *
 * Founder-only。聚合 llm_usage_logs，返回时间范围内：
 *   - range
 *   - totals: { calls, prompt_tokens, completion_tokens, total_tokens, cost_usd,
 *              avg_cost_per_call, avg_duration_ms, p50_duration_ms, p95_duration_ms,
 *              cost_per_day, calls_per_day, days, sampled_for_latency }
 *   - byTenant / byCallSite / byModel / byProvider:
 *       [{ key/name, calls, prompt_tokens, completion_tokens, cost_usd,
 *          avg_duration_ms, share }]   share = cost_usd / totals.cost_usd
 *   - byDay: [{ day:'YYYY-MM-DD', calls, prompt_tokens, completion_tokens, cost_usd }]
 *   - sampleSize, capped (true if hit 50000 limit)
 *
 * 没传 from/to 默认查最近 30 天。
 */
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
    const PAGE_SIZE = 1000;
    const ROW_LIMIT = 50000;
    const FULL_COLS = 'tenant_id, call_site, provider, model, prompt_tokens, completion_tokens, cache_creation_input_tokens, cache_read_input_tokens, cost_usd, duration_ms, created_at';
    const BASE_COLS = 'tenant_id, call_site, provider, model, prompt_tokens, completion_tokens, cost_usd, duration_ms, created_at';
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
      calls: 0, prompt_tokens: 0, completion_tokens: 0,
      cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      cost_usd: 0,
    };
    const byTenant = new Map();
    const byCallSite = new Map();
    const byModel = new Map();
    const byProvider = new Map();
    const byDay = new Map();
    const byHour = new Map();

    const bumpBucket = (map, key, row) => {
      const cur = map.get(key) || {
        key,
        calls: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        cost_usd: 0,
        duration_sum: 0,
        duration_count: 0,
      };
      cur.calls += 1;
      cur.prompt_tokens += row.prompt_tokens || 0;
      cur.completion_tokens += row.completion_tokens || 0;
      cur.cache_creation_input_tokens += row.cache_creation_input_tokens || 0;
      cur.cache_read_input_tokens += row.cache_read_input_tokens || 0;
      cur.cost_usd += Number(row.cost_usd) || 0;
      if (row.duration_ms != null) {
        cur.duration_sum += row.duration_ms;
        cur.duration_count += 1;
      }
      map.set(key, cur);
    };

    for (const r of rows || []) {
      totals.calls += 1;
      totals.prompt_tokens += r.prompt_tokens || 0;
      totals.completion_tokens += r.completion_tokens || 0;
      totals.cache_creation_input_tokens += r.cache_creation_input_tokens || 0;
      totals.cache_read_input_tokens += r.cache_read_input_tokens || 0;
      totals.cost_usd += Number(r.cost_usd) || 0;
      bumpBucket(byTenant, r.tenant_id || '__null__', r);
      bumpBucket(byCallSite, r.call_site || 'unknown', r);
      bumpBucket(byModel, r.model || 'unknown', r);
      bumpBucket(byProvider, r.provider || 'unknown', r);

      const day = (r.created_at || '').slice(0, 10);
      if (day) bumpBucket(byDay, day, r);
      // 'YYYY-MM-DDTHH:...' → 'YYYY-MM-DD HH:00'（UTC，与 byDay 一致）
      const hourSlice = (r.created_at || '').slice(0, 13);
      if (hourSlice.length === 13) {
        bumpBucket(byHour, hourSlice.replace('T', ' ') + ':00', r);
      }
    }

    // latency percentiles —— 一次性 sort 全量行，O(n log n)，n<=50000 没压力
    const durations = (rows || []).map(r => r.duration_ms).filter(d => d != null && d >= 0);
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

    const metrics = (b) => ({
      calls: b.calls,
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
      tenant_name: b.key === '__null__' ? '(no tenant)' : (tenantNameById.get(b.key) || b.key),
      ...metrics(b),
    })).sort(sortByCost);

    const callSiteList = [...byCallSite.values()].map(b => ({ call_site: b.key, ...metrics(b) })).sort(sortByCost);
    const modelList    = [...byModel.values()   ].map(b => ({ model:     b.key, ...metrics(b) })).sort(sortByCost);
    const providerList = [...byProvider.values()].map(b => ({ provider:  b.key, ...metrics(b) })).sort(sortByCost);

    // byDay：补齐范围内每一天，方便趋势图连续
    const dayKeys = enumerateDays(fromIso, toIso);
    const dayList = dayKeys.map(day => {
      const b = byDay.get(day);
      return {
        day,
        calls: b?.calls || 0,
        prompt_tokens: b?.prompt_tokens || 0,
        completion_tokens: b?.completion_tokens || 0,
        cost_usd: round6(b?.cost_usd || 0),
      };
    });

    // byHour：同上，按小时补齐
    const hourKeys = enumerateHours(fromIso, toIso);
    const hourList = hourKeys.map(hour => {
      const b = byHour.get(hour);
      return {
        hour,
        calls: b?.calls || 0,
        prompt_tokens: b?.prompt_tokens || 0,
        completion_tokens: b?.completion_tokens || 0,
        cost_usd: round6(b?.cost_usd || 0),
      };
    });

    return NextResponse.json({
      range: { from: fromIso, to: toIso, days },
      totals: {
        calls: totals.calls,
        prompt_tokens: totals.prompt_tokens,
        completion_tokens: totals.completion_tokens,
        total_tokens: totals.prompt_tokens + totals.completion_tokens,
        cache_creation_input_tokens: totals.cache_creation_input_tokens,
        cache_read_input_tokens: totals.cache_read_input_tokens,
        cost_usd: totalCost,
        avg_cost_per_call: totals.calls ? round6(totals.cost_usd / totals.calls) : 0,
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
  const out = [];
  const start = new Date(fromIso.slice(0, 10) + 'T00:00:00Z');
  const end = new Date(toIso.slice(0, 10) + 'T00:00:00Z');
  for (let t = start.getTime(); t <= end.getTime(); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function enumerateHours(fromIso, toIso) {
  const out = [];
  const start = new Date(fromIso);
  start.setUTCMinutes(0, 0, 0);
  const end = new Date(toIso);
  end.setUTCMinutes(0, 0, 0);
  for (let t = start.getTime(); t <= end.getTime(); t += 3600 * 1000) {
    const iso = new Date(t).toISOString();
    out.push(iso.slice(0, 13).replace('T', ' ') + ':00');
  }
  return out;
}
