/**
 * GET /api/product-lines/[id]/ogilvy-ad-spend?from=ISO&to=ISO
 *
 * 严格按 "Ogilvy 创编 + 本产品线" 口径返回广告花费 + WA 对话数。
 *
 * 跟 /api/ads/dashboard 的区别:
 *   - dashboard 按 product_line→agent→phone_number→ad 反推 (包括手工建的广告)
 *   - 本 endpoint 严格按 autopilot_sessions.meta_campaign_ids 正推,
 *     只数从 Ogilvy launch 出去的活动
 *
 * 链路:
 *   autopilot_sessions[tenant, product_line, deleted_at=NULL].meta_campaign_ids
 *   → Meta /act_<X>/insights (level=campaign, filtering=campaign.id IN [...])
 *   → spend 汇总
 *   → Meta /act_<X>/ads 拿 ad_id → campaign 映射
 *   → ad_conversation_stats RPC 取每 ad 的对话数, 按 ad_id 过滤后汇总
 *
 * 时间窗口: 跟 cost-stats 一样,from / to ISO;省略 = lifetime。
 *
 * 已知限制:
 *   - 假设所有 campaign 在用户当前 default ad_account 下 (Ogilvy launch 路径
 *     固定走 getMetaAccountForUser 的 default;用户切了 default 之后老 campaign
 *     仍在原 account 下,这里 Meta 会拿不到 —— 接受,99% 场景一致)。
 */
import { getTenantContext } from '../../../../../lib/tenant-context.js';
import { findProductLineById } from '../../../../../lib/repositories/product-line.repository.js';
import { getSupabaseAdmin } from '../../../../../lib/supabase-admin.js';
import { getMetaAccountForUser } from '../../../../../src/agents/ogilvy/whatsapp-accounts.service.js';
import { META_API_VERSION } from '../../../../../src/meta-ads.service.js';

function isoToBjYmd(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

export async function GET(request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const line = await findProductLineById({ tenantId: ctx.tenantId, id });
  if (!line) return Response.json({ error: 'Not found' }, { status: 404 });

  const { searchParams } = new URL(request.url);
  const fromISO = searchParams.get('from') || null;
  const toISO = searchParams.get('to') || null;

  try {
    const admin = getSupabaseAdmin();

    // 1. 收集本产品线下所有 launched session 的 campaign_ids
    const { data: sessions, error: sessErr } = await admin
      .from('autopilot_sessions')
      .select('meta_campaign_ids')
      .eq('tenant_id', ctx.tenantId)
      .eq('product_line', id)
      .is('deleted_at', null);
    if (sessErr) throw new Error(sessErr.message);
    const campaignIds = [...new Set(
      (sessions || []).flatMap(s => Array.isArray(s.meta_campaign_ids) ? s.meta_campaign_ids : []),
    )].filter(Boolean);

    if (campaignIds.length === 0) {
      return Response.json({
        spend: 0,
        wa_conversations: 0,
        cpa: 0,
        campaign_count: 0,
        ad_count: 0,
        source: 'no_campaigns',
      });
    }

    // 2. 拿用户的 Meta token + ad_account
    const account = await getMetaAccountForUser(ctx.user.id);
    if (!account?.access_token || !account?.ad_account_id) {
      return Response.json({
        spend: 0, wa_conversations: 0, cpa: 0,
        campaign_count: campaignIds.length, ad_count: 0,
        source: 'meta_not_connected',
      });
    }
    const adAccountId = String(account.ad_account_id).replace(/^act_/, '');

    // 3. 拿 campaign-level spend (一次 API 调用,filtering 限定到 campaign IDs)
    const insightsParams = new URLSearchParams({
      access_token: account.access_token,
      fields: 'spend',
      level: 'campaign',
      filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campaignIds }]),
      limit: '500',
    });
    if (fromISO && toISO) {
      // Meta time_range 用 YYYY-MM-DD,Asia/Shanghai 视角
      insightsParams.set('time_range', JSON.stringify({
        since: isoToBjYmd(fromISO),
        until: isoToBjYmd(toISO),
      }));
    }
    const insightsRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/act_${adAccountId}/insights?${insightsParams}`,
    );
    if (!insightsRes.ok) {
      const body = await insightsRes.text();
      throw new Error(`Meta insights error ${insightsRes.status}: ${body.slice(0, 200)}`);
    }
    const insightsJson = await insightsRes.json();
    const spend = (insightsJson.data || []).reduce((s, r) => s + Number(r.spend || 0), 0);

    // 4. 拿 ad_id → campaign 映射 (同样 filtering 限定)
    const adsParams = new URLSearchParams({
      access_token: account.access_token,
      fields: 'id',
      filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: campaignIds }]),
      limit: '500',
    });
    const adsRes = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/act_${adAccountId}/ads?${adsParams}`,
    );
    if (!adsRes.ok) {
      const body = await adsRes.text();
      throw new Error(`Meta ads error ${adsRes.status}: ${body.slice(0, 200)}`);
    }
    const adsJson = await adsRes.json();
    const adIdSet = new Set((adsJson.data || []).map(a => a.id));

    // 5. ad_conversation_stats RPC → 内存 filter 出我们关心的 ad_ids
    //
    // ⚠️ RPC 的 WHERE 子句是 created_at >= from_ts AND created_at <= to_ts;
    // Postgres `value >= NULL` 永远是 NULL/false,直接传 null 会把所有行过滤掉
    // 导致 wa_conversations=0。lifetime 模式 (preset='all') 用 epoch + 当前
    // 时间兜底,跟"全部时间"语义一致。
    let waConversations = 0;
    if (adIdSet.size > 0) {
      const { data: convStats, error: convErr } = await admin.rpc('ad_conversation_stats', {
        p_tenant_id: ctx.tenantId,
        from_ts: fromISO || '1970-01-01T00:00:00Z',
        to_ts: toISO || new Date().toISOString(),
      });
      if (convErr) throw new Error(convErr.message);
      waConversations = (convStats || [])
        .filter(r => adIdSet.has(r.meta_ad_id))
        .reduce((s, r) => s + Number(r.conversation_count || 0), 0);
    }

    return Response.json({
      spend,
      wa_conversations: waConversations,
      cpa: waConversations > 0 ? spend / waConversations : 0,
      campaign_count: campaignIds.length,
      ad_count: adIdSet.size,
      source: 'meta_api',
    });
  } catch (err) {
    console.error('[product-lines/[id]/ogilvy-ad-spend GET]', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
