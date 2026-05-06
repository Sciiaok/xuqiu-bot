import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getTenantContext, FOUNDER_TENANT_ID } from '@/lib/tenant-context';

/**
 * GET /api/admin/llm-usage?from=ISO&to=ISO
 *
 * Founder-only：聚合 llm_usage_logs，返回时间范围内：
 *   - totals: { calls, prompt_tokens, completion_tokens, cost_usd }
 *   - byTenant: [{ tenant_id, tenant_name, calls, ..., cost_usd }]
 *   - byCallSite: [{ call_site, calls, ..., cost_usd }]
 *   - byModel: [{ model, calls, ..., cost_usd }]
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

    // 一次拉全期数据 —— 内存里聚合。日级聚合表是后续优化，当前 MVP 行数有限。
    // 上限 50000 行兜底，避免误查太久压垮内存。
    const { data: rows, error } = await admin
      .from('llm_usage_logs')
      .select('tenant_id, call_site, provider, model, prompt_tokens, completion_tokens, cost_usd, duration_ms, created_at')
      .gte('created_at', fromIso)
      .lte('created_at', toIso)
      .order('created_at', { ascending: false })
      .limit(50000);
    if (error) throw error;

    // 拉所有 tenant 名称用于显示 —— 一次性，几十行
    const { data: tenants } = await admin.from('tenants').select('id, name, slug');
    const tenantNameById = new Map((tenants || []).map(t => [t.id, t.name || t.slug || t.id]));

    const totals = { calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };
    const byTenant = new Map();
    const byCallSite = new Map();
    const byModel = new Map();

    const bumpBucket = (map, key, row) => {
      const cur = map.get(key) || { key, calls: 0, prompt_tokens: 0, completion_tokens: 0, cost_usd: 0 };
      cur.calls += 1;
      cur.prompt_tokens += row.prompt_tokens || 0;
      cur.completion_tokens += row.completion_tokens || 0;
      cur.cost_usd += Number(row.cost_usd) || 0;
      map.set(key, cur);
    };

    for (const r of rows || []) {
      totals.calls += 1;
      totals.prompt_tokens += r.prompt_tokens || 0;
      totals.completion_tokens += r.completion_tokens || 0;
      totals.cost_usd += Number(r.cost_usd) || 0;
      bumpBucket(byTenant, r.tenant_id || '__null__', r);
      bumpBucket(byCallSite, r.call_site || 'unknown', r);
      bumpBucket(byModel, r.model || 'unknown', r);
    }

    const sortByCost = (a, b) => b.cost_usd - a.cost_usd;
    const tenantList = [...byTenant.values()].map(b => ({
      tenant_id: b.key === '__null__' ? null : b.key,
      tenant_name: b.key === '__null__' ? '(no tenant)' : (tenantNameById.get(b.key) || b.key),
      calls: b.calls,
      prompt_tokens: b.prompt_tokens,
      completion_tokens: b.completion_tokens,
      cost_usd: round6(b.cost_usd),
    })).sort(sortByCost);

    const callSiteList = [...byCallSite.values()].map(b => ({
      call_site: b.key,
      calls: b.calls,
      prompt_tokens: b.prompt_tokens,
      completion_tokens: b.completion_tokens,
      cost_usd: round6(b.cost_usd),
    })).sort(sortByCost);

    const modelList = [...byModel.values()].map(b => ({
      model: b.key,
      calls: b.calls,
      prompt_tokens: b.prompt_tokens,
      completion_tokens: b.completion_tokens,
      cost_usd: round6(b.cost_usd),
    })).sort(sortByCost);

    return NextResponse.json({
      range: { from: fromIso, to: toIso },
      totals: { ...totals, cost_usd: round6(totals.cost_usd) },
      byTenant: tenantList,
      byCallSite: callSiteList,
      byModel: modelList,
      sampleSize: rows?.length || 0,
    });
  } catch (err) {
    console.error('[admin/llm-usage GET] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

function round6(n) {
  return Math.round(n * 1_000_000) / 1_000_000;
}
