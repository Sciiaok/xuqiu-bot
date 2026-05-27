/**
 * GET /api/ogilvy/creatives?productLine=<id>
 *
 * 为 Ogilvy 工作台的「创意素材中心」面板供数据。两类素材并排返回:
 *
 *   - ai  — 本租户内由 generate_ad_creative 工具产出的所有图片。
 *           来源:autopilot_messages.tool_result.url
 *           过滤:同 url 只保留最早一条(避免同图被多个 session 引用时刷屏)
 *
 *   - kb  — 本租户当前产品线的 kb_assets 图片(is_sendable=true)。
 *           来源:kb_assets,storage_path 现场签 1h URL
 *
 * 两组都强制锁当前 productLine —— 跨产品线复用是 KB 没有意义、AI 偶尔有
 * 但用户决定先不暴露(简化心智)。要切产品线就切 session。
 *
 * 租户粒度隔离;不按 user_id 二次过滤(LeadEngine 是单用户单租户)。
 */
import { NextResponse } from 'next/server';
import supabase from '../../../../lib/supabase.js';
import { getSupabaseAdmin } from '../../../../lib/supabase-admin.js';
import { getTenantContext } from '../../../../lib/tenant-context.js';
import { findProductLineById } from '../../../../lib/repositories/product-line.repository.js';

const STORAGE_BUCKET = 'kb-assets';
const LIMIT = 200;

export async function GET(request) {
  const ctx = await getTenantContext();
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const productLine = new URL(request.url).searchParams.get('productLine');
  if (!productLine) {
    return NextResponse.json({ error: 'productLine required' }, { status: 400 });
  }

  // 名字回显用 —— 不阻塞主查询。失败就用 id 当 label。
  const plRow = await findProductLineById({ tenantId: ctx.tenantId, id: productLine })
    .catch(() => null);
  const productLineName = plRow?.name || productLine;

  try {
    const [ai, kb] = await Promise.all([
      loadAiCreatives({ tenantId: ctx.tenantId, productLine }),
      loadKbCreatives({ tenantId: ctx.tenantId, productLine }),
    ]);
    return NextResponse.json({ product_line_name: productLineName, ai, kb });
  } catch (err) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'ogilvy.load_creatives.failed',
      component: 'ogilvy/creatives',
      tenant_id: ctx.tenantId,
      product_line: productLine,
      pg_code: err.code || null,
      error: err.message,
    }));
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * AI creatives:autopilot_messages × autopilot_sessions inner join via tenant
 * scope。一次 IN-list 查 session_ids 比 RLS-joined select 简单且更快。
 */
async function loadAiCreatives({ tenantId, productLine }) {
  // 1. 先拿本租户 + 该产品线下的 session_ids
  const { data: sessRows, error: sessErr } = await supabase
    .from('autopilot_sessions')
    .select('id, plan_json')
    .eq('tenant_id', tenantId)
    .eq('product_line', productLine)
    .is('deleted_at', null);
  if (sessErr) throw sessErr;
  const sessionIds = (sessRows || []).map(r => r.id);
  if (sessionIds.length === 0) return [];

  // session summary 顺手缓存,展示用
  const sessionSummary = {};
  for (const r of sessRows || []) {
    sessionSummary[r.id] = r.plan_json?.summary || '';
  }

  // 2. 同时拉 tool 和 assistant 两类 row。tool 行带 url(在 tool_result);
  //    assistant 行带完整 tool_input(headline、product_description、targeting…)。
  //    两类行通过 tool_use_id 配对。Supabase 这边一次查两类比两次往返简单。
  const { data, error } = await supabase
    .from('autopilot_messages')
    .select('id, session_id, role, tool_use_id, tool_input, tool_result, created_at')
    .in('session_id', sessionIds)
    .eq('tool_name', 'generate_ad_creative')
    .order('created_at', { ascending: true })
    .limit(LIMIT * 8);
  if (error) throw error;

  // 3. 索引 assistant rows 的 tool_input,by tool_use_id
  const inputByUseId = new Map();
  for (const row of data || []) {
    if (row.role === 'assistant' && row.tool_use_id) {
      inputByUseId.set(row.tool_use_id, row.tool_input || {});
    }
  }

  // 4. 按 url 去重 tool rows(只保留首次出现),merge assistant 那边的 tool_input
  const seen = new Map();  // url -> shape
  for (const row of data || []) {
    if (row.role !== 'tool') continue;
    const url = row.tool_result?.url;
    if (!url || row.tool_result?.error) continue;
    if (seen.has(url)) continue;
    const input = (row.tool_use_id && inputByUseId.get(row.tool_use_id)) || {};
    seen.set(url, {
      id: row.id,
      url,
      // Title for the AI tab = the generation prompt (product_description) —
      // 80-300 字的视觉脚本,告诉用户"我当时让 AI 画什么"。之前用
      // headline(图上字幕文案)被用户指出不对:headline 是图上文字,
      // 跟 prompt 是两回事。fallback 链保留 headline/product_name/默认串
      // 以防老 session 缺 description 字段。
      title:
        input.product_description ||
        input.headline ||
        row.tool_result?.headline ||
        input.product_name ||
        row.tool_result?.product_name ||
        '广告素材',
      // Keep headline as a secondary field — visible as tag if we want later.
      headline: input.headline || row.tool_result?.headline || '',
      prompt: input.product_description || '',
      session_id: row.session_id,
      session_summary: sessionSummary[row.session_id] || '',
      target_countries: input.target_countries || [],
      language: input.language || '',
      created_at: row.created_at,
    });
  }
  const out = Array.from(seen.values()).sort(
    (a, b) => (b.created_at || '').localeCompare(a.created_at || ''),
  );
  return out.slice(0, LIMIT);
}

/**
 * KB creatives:kb_assets where mime_type LIKE 'image/%' AND is_sendable.
 * 签名 URL 走 admin(bucket 私有);失败的不返回,前端少一条胜过整个挂掉。
 */
async function loadKbCreatives({ tenantId, productLine }) {
  const { data, error } = await supabase
    .from('kb_assets')
    .select('id, filename, description, description_en, mime_type, storage_path, view, color, scenario, language, linked_skus, tags, created_at')
    .eq('tenant_id', tenantId)
    .eq('product_line_id', productLine)
    .eq('is_sendable', true)
    .like('mime_type', 'image/%')
    .order('created_at', { ascending: false })
    .limit(LIMIT);
  if (error) throw error;

  if ((data || []).length === 0) return [];

  // Sign all URLs in parallel(每条独立,失败不应连坐)。
  const admin = getSupabaseAdmin();
  const signed = await Promise.all(
    data.map(async (row) => {
      try {
        const { data: s, error: sErr } = await admin.storage
          .from(STORAGE_BUCKET)
          .createSignedUrl(row.storage_path, 3600);
        if (sErr || !s?.signedUrl) return null;
        return {
          id: row.id,
          url: s.signedUrl,
          title: row.description || row.filename || '知识库素材',
          description: row.description_en || '',
          tags: [row.view, row.color, row.scenario].filter(Boolean),
          linked_skus: row.linked_skus || [],
          mime_type: row.mime_type,
          created_at: row.created_at,
        };
      } catch {
        return null;
      }
    }),
  );
  return signed.filter(Boolean);
}
