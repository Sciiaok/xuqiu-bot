import { NextResponse } from 'next/server';
import { config } from '@/src/config';
import supabase from '@/lib/supabase';
import { getTenantContext } from '@/lib/tenant-context';
import { resolveBusinessManager } from '@/lib/meta-bm-resolver';

const META_API_VERSION = config.meta?.apiVersion || 'v21.0';

/**
 * 调一次 Graph API GET，把返回 + 错误细节都吐出来。
 * 不抛错 —— 让 caller 决定是 warn 还是 fatal。
 */
async function graphGetSafe(path, token, params = {}) {
  const qs = new URLSearchParams({ access_token: token, ...params });
  let res;
  try {
    res = await fetch(`https://graph.facebook.com/${META_API_VERSION}${path}?${qs}`);
  } catch (err) {
    return { ok: false, error: { message: `fetch failed: ${err.message}` } };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.error) {
    return {
      ok: false,
      status: res.status,
      error: data?.error || { message: `HTTP ${res.status}` },
    };
  }
  return { ok: true, data };
}

/** 失败信息提炼成一行 + 完整 raw 给 log data */
function fmtErr(err) {
  if (!err) return 'unknown error';
  return [err.code, err.error_subcode, err.type, err.message]
    .filter(Boolean).join(' / ');
}

/**
 * 判断一个 WhatsApp 号码是否对租户实际可用（与 autopilot 的 isUsable 同标准）：
 *   - 没认证业务名 → 不能发消息（Meta 拒）
 *   - "Test Number" → Meta 测试号码，不能投生产用
 *   - 质量评级 RED → Meta 已限流/封禁，发不出去
 */
function checkPhoneUsable(p) {
  if (!p.verified_name) return { ok: false, reason: '未认证业务名' };
  if (p.verified_name === 'Test Number') return { ok: false, reason: 'Meta 测试号码' };
  if (p.quality_rating === 'RED') return { ok: false, reason: '质量评级 RED（Meta 已限流）' };
  return { ok: true };
}

/**
 * 广告账户 account_status 含义（Meta 文档）：
 *   1=ACTIVE  2=DISABLED  3=UNSETTLED  7=PENDING_RISK_REVIEW
 *   8=PENDING_SETTLEMENT  9=IN_GRACE_PERIOD
 *   100=PENDING_CLOSURE  101=CLOSED
 * 只有 ACTIVE 才能正常投放 → 其余一律不让用户选。
 */
const AD_ACCOUNT_STATUS_REASON = {
  2: 'DISABLED（已禁用）',
  3: 'UNSETTLED（欠款未结）',
  7: 'PENDING_RISK_REVIEW（风险审查中）',
  8: 'PENDING_SETTLEMENT（待结算）',
  9: 'IN_GRACE_PERIOD（宽限期）',
  100: 'PENDING_CLOSURE（待关闭）',
  101: 'CLOSED（已关闭）',
};
function checkAdAccountUsable(a) {
  if (a.account_status === 1) return { ok: true };
  return {
    ok: false,
    reason: AD_ACCOUNT_STATUS_REASON[a.account_status] || `异常状态（status=${a.account_status ?? 'null'}）`,
  };
}

/**
 * POST /api/meta/connect/preview
 *
 * 验 token + 列出 BM 名下的所有 WABA（含每个 WABA 下的号码）+ 所有广告账户。
 * 不写 DB，仅供前端做选择 UI。
 *
 * Body: { token, bm_id? }
 * Resp: { bm, wabas: [{ id, name, phones: [...] }], ad_accounts: [...], logs }
 */
export async function POST(request) {
  const logs = [];
  const log = (level, step, msg, data) => {
    const entry = { ts: Date.now(), level, step, msg };
    if (data !== undefined) entry.data = data;
    logs.push(entry);
  };

  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized', logs }, { status: 401 });
    log('info', 'auth', `tenant=${ctx.tenantId.slice(0, 8)}… user=${ctx.user.email}`);

    const body = await request.json();
    const token = String(body?.token || '').trim();
    const bmIdInput = String(body?.bm_id || '').trim();
    if (!token) {
      log('error', 'token', '缺少 system user token');
      return NextResponse.json({ error: '请粘贴 system user token', logs }, { status: 400 });
    }
    log('success', 'token', `token 已收到（长度 ${token.length}）`);
    if (bmIdInput) log('info', 'bm', `用户手动指定 BM ID：${bmIdInput}`);

    // 1. 解析 BM
    log('info', 'bm', '解析 token 关联的 Business Manager');
    const { bm, attempts } = await resolveBusinessManager(token, { hintBmId: bmIdInput || null });
    for (const a of attempts) {
      log(a.ok ? 'info' : 'warn', 'bm', `${a.source}: ${a.msg}`, a.data);
    }

    // 校验 token App ID 必须等于本平台
    const expectedAppId = config.meta?.appId || null;
    const tokenAppId = attempts.find(a => a.source === '/debug_token' && a.ok)?.data?.app_id || null;
    if (expectedAppId && tokenAppId && String(tokenAppId) !== String(expectedAppId)) {
      log('error', 'app', `token 属于 App ${tokenAppId}，但本平台是 App ${expectedAppId}`);
      return NextResponse.json({
        error: `Token 属于另一个 Meta App（${tokenAppId}）。本平台 App ID 是 ${expectedAppId}。`,
        logs,
      }, { status: 400 });
    }
    if (expectedAppId && tokenAppId) {
      log('success', 'app', `token 所属 App 与本平台一致：${tokenAppId}`);
    }

    if (!bm?.id) {
      log('error', 'bm', '自动识别失败 —— 请在表单填写 BM ID 后重试');
      return NextResponse.json({
        error: '自动识别 Business Manager 失败。请在表单里手动粘贴 BM ID 后重试。',
        logs,
      }, { status: 400 });
    }
    log('success', 'bm', `BM 验证成功：${bm.name || '(未命名)'}（${bm.id}）`);

    // 2. 列 WABA —— 同时查 owned 和 client 两条边，合并去重
    const wabaMap = new Map(); // id -> { id, name, source }
    for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
      log('info', 'waba', `GET /${bm.id}/${edge}`);
      const r = await graphGetSafe(`/${bm.id}/${edge}`, token, { fields: 'id,name' });
      if (!r.ok) {
        log('warn', 'waba', `${edge} 失败：${fmtErr(r.error)}`, r.error);
        continue;
      }
      const list = r.data?.data || [];
      log('success', 'waba', `${edge}: ${list.length} 个`, list.map(w => ({ id: w.id, name: w.name })));
      for (const w of list) {
        if (!wabaMap.has(w.id)) wabaMap.set(w.id, { id: w.id, name: w.name || null, source: edge });
      }
    }
    const wabas = [...wabaMap.values()];
    log(wabas.length > 0 ? 'success' : 'warn', 'waba', `WABA 合计 ${wabas.length} 个`);

    // 3. 每个 WABA 拉号码 + 过滤不可用（Test Number / RED / 未认证）
    const wabasWithPhones = [];
    for (const waba of wabas) {
      const r = await graphGetSafe(`/${waba.id}/phone_numbers`, token);
      let phones = [];
      let filteredOut = [];
      if (!r.ok) {
        log('warn', 'phones', `WABA ${waba.id} 号码列表失败：${fmtErr(r.error)}`, r.error);
      } else {
        const all = (r.data?.data || []).map(p => ({
          phone_number_id: p.id,
          display_number: p.display_phone_number,
          verified_name: p.verified_name || null,
          quality_rating: p.quality_rating || null,
        }));
        for (const p of all) {
          const check = checkPhoneUsable(p);
          if (check.ok) phones.push(p);
          else filteredOut.push({ ...p, filter_reason: check.reason });
        }
        if (filteredOut.length > 0) {
          log('warn', 'phones',
            `WABA ${waba.id}: 过滤掉 ${filteredOut.length} 个不可用号码（${filteredOut.map(p => p.display_number).join(', ')}）`,
            filteredOut);
        }
        log(phones.length > 0 ? 'success' : 'warn', 'phones',
          `WABA ${waba.id}: ${phones.length} 个可用号码（共 ${all.length}，过滤 ${filteredOut.length}）`);
      }
      wabasWithPhones.push({
        id: waba.id,
        name: waba.name,
        phones,
        filtered_phones_count: filteredOut.length,
      });
    }

    // 4. 列广告账户 —— 同样查 owned + client 两条边
    const adAccountMap = new Map();
    for (const edge of ['owned_ad_accounts', 'client_ad_accounts']) {
      log('info', 'ads', `GET /${bm.id}/${edge}`);
      const r = await graphGetSafe(`/${bm.id}/${edge}`, token, {
        fields: 'id,name,currency,timezone_name,account_status',
      });
      if (!r.ok) {
        log('warn', 'ads', `${edge} 失败：${fmtErr(r.error)}`, r.error);
        continue;
      }
      const list = r.data?.data || [];
      log('success', 'ads', `${edge}: ${list.length} 个`, list.map(a => ({ id: a.id, name: a.name })));
      for (const a of list) {
        if (!adAccountMap.has(a.id)) {
          adAccountMap.set(a.id, {
            ad_account_id: a.id,
            name: a.name || null,
            currency: a.currency || null,
            timezone: a.timezone_name || null,
            account_status: a.account_status ?? null,
            source: edge,
          });
        }
      }
    }

    // 5. 兜底：如果 owned + client 都查不到，试 system user 自己被分配的 ad accounts
    //    （某些 BM 的设置下，ad account 是直接分配给 system user 而不是挂在 BM 边上）
    if (adAccountMap.size === 0) {
      log('info', 'ads', '兜底：GET /me/adaccounts（system user 直接被分配的）');
      const r = await graphGetSafe('/me/adaccounts', token, {
        fields: 'id,name,currency,timezone_name,account_status',
      });
      if (!r.ok) {
        log('warn', 'ads', `/me/adaccounts 失败：${fmtErr(r.error)}`, r.error);
      } else {
        const list = r.data?.data || [];
        log('success', 'ads', `/me/adaccounts: ${list.length} 个`, list.map(a => ({ id: a.id, name: a.name })));
        for (const a of list) {
          if (!adAccountMap.has(a.id)) {
            adAccountMap.set(a.id, {
              ad_account_id: a.id,
              name: a.name || null,
              currency: a.currency || null,
              timezone: a.timezone_name || null,
              account_status: a.account_status ?? null,
              source: '/me/adaccounts',
            });
          }
        }
      }
    }
    const allAdAccounts = [...adAccountMap.values()];

    // 6. 过滤掉非 ACTIVE 的广告账户 —— 只让用户在正常状态的里挑
    const adAccounts = [];
    const filteredAds = [];
    for (const a of allAdAccounts) {
      const check = checkAdAccountUsable(a);
      if (check.ok) adAccounts.push(a);
      else filteredAds.push({ ...a, filter_reason: check.reason });
    }
    if (filteredAds.length > 0) {
      log('warn', 'ads',
        `过滤掉 ${filteredAds.length} 个非正常状态广告账户：${filteredAds.map(a => `${a.name || a.ad_account_id}（${a.filter_reason}）`).join(', ')}`,
        filteredAds);
    }
    log(adAccounts.length > 0 ? 'success' : 'warn', 'ads',
      `可用广告账户 ${adAccounts.length} 个（共 ${allAdAccounts.length}，过滤 ${filteredAds.length}）`);

    // 7. 跨租户独占预检：BM / WABA / 广告账户已被其他租户绑定的，标记给前端
    {
      const { data: bmDup } = await supabase
        .from('meta_connections')
        .select('tenant_id')
        .eq('bm_id', bm.id)
        .eq('status', 'active')
        .neq('tenant_id', ctx.tenantId)
        .maybeSingle();
      if (bmDup) {
        log('error', 'exclusivity', `BM ${bm.id} 已被另一租户绑定 —— 无法继续`);
        return NextResponse.json({
          error: `BM ${bm.id} 已经被另一个租户绑定，每个 Meta BM 只能归属一个租户。`,
          logs,
        }, { status: 409 });
      }

      const wabaIds = wabasWithPhones.map(w => w.id);
      if (wabaIds.length > 0) {
        const { data: wabaDups } = await supabase
          .from('meta_phone_numbers')
          .select('waba_id, tenant_id')
          .in('waba_id', wabaIds)
          .eq('status', 'active')
          .neq('tenant_id', ctx.tenantId);
        const dupWabaSet = new Set((wabaDups || []).map(r => r.waba_id));
        for (const w of wabasWithPhones) {
          if (dupWabaSet.has(w.id)) w.conflict = 'bound_by_other_tenant';
        }
        if (dupWabaSet.size > 0) {
          log('warn', 'exclusivity', `WABA ${[...dupWabaSet].join(', ')} 已被其他租户绑定 —— 不可勾选`);
        }
      }

      const adIds = adAccounts.map(a => a.ad_account_id);
      if (adIds.length > 0) {
        const { data: adDups } = await supabase
          .from('meta_ad_accounts')
          .select('ad_account_id, tenant_id')
          .in('ad_account_id', adIds)
          .eq('status', 'active')
          .neq('tenant_id', ctx.tenantId);
        const dupAdSet = new Set((adDups || []).map(r => r.ad_account_id));
        for (const a of adAccounts) {
          if (dupAdSet.has(a.ad_account_id)) a.conflict = 'bound_by_other_tenant';
        }
        if (dupAdSet.size > 0) {
          log('warn', 'exclusivity', `广告账户 ${[...dupAdSet].join(', ')} 已被其他租户绑定 —— 不可选`);
        }
      }
    }

    log('success', 'done', `预览完成：${wabasWithPhones.length} 个 WABA, ${adAccounts.length} 个可用广告账户`);

    return NextResponse.json({
      success: true,
      bm: { id: bm.id, name: bm.name || null },
      wabas: wabasWithPhones,
      ad_accounts: adAccounts,
      logs,
    });
  } catch (err) {
    console.error('[meta/connect/preview] failed:', err);
    log('error', 'fatal', err.message || '未知异常');
    return NextResponse.json({ error: err.message || '预览失败', logs }, { status: 500 });
  }
}
