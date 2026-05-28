import { NextResponse } from 'next/server';
import { config } from '@/src/config';
import supabase from '@/lib/supabase';
import { getTenantContext } from '@/lib/tenant-context';
import {
  createConnection,
  upsertPhone,
  upsertAdAccount,
} from '@/lib/repositories/meta-connection.repository';
import { invalidateTokenCache } from '@/src/whatsapp.service';
import { markMetaConnected } from '@/lib/repositories/onboarding.repository';
import { recordAudit } from '@/lib/repositories/audit-log.repository';
import { resolveBusinessManager } from '@/lib/meta-bm-resolver';

const META_API_VERSION = config.meta?.apiVersion || 'v21.0';

async function graphGet(path, token, params = {}) {
  const qs = new URLSearchParams({ access_token: token, ...params });
  const url = `https://graph.facebook.com/${META_API_VERSION}${path}?${qs}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok || data?.error) {
    throw new Error(data?.error?.message || `Meta API ${path} failed (${res.status})`);
  }
  return data;
}

/** 与 preview 一致的可用号码判定 —— 测试号 / RED / 未认证全过滤掉。 */
function isPhoneUsable(p) {
  if (!p.verified_name) return false;
  if (p.verified_name === 'Test Number') return false;
  if (p.quality_rating === 'RED') return false;
  return true;
}

/**
 * 检测「资源跨租户独占冲突」错误：
 *   - Postgres unique_violation 23505（来自 PK / 唯一索引 / trigger RAISE）
 *   - 触发器 check_waba_tenant_exclusivity 抛的中文错误消息
 *
 * 预检（SELECT 后 NEQ tenant）和实际写入（upsert）之间存在 race 窗口：另一个
 * 租户可能正好在这之间认领走资源。出现该错误时，把它翻译成 409 让用户重试。
 */
function isCrossTenantConflictError(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  return /已经被另一个租户|cross[-_ ]tenant/i.test(err.message || '');
}

async function graphPost(path, token, body = {}) {
  const url = `https://graph.facebook.com/${META_API_VERSION}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  });
  const data = await res.json();
  if (!res.ok || data?.error) {
    throw new Error(data?.error?.message || `Meta API ${path} failed (${res.status})`);
  }
  return data;
}

/**
 * POST /api/meta/connect
 *
 * 当前内测阶段：每一步执行情况都收集到 logs[] 返回前端做 console 风格披露。
 *
 * 流程：
 *   1. 解析 token（manual 直接用；es 走 oauth/access_token）
 *   2. 拉 BM 信息
 *   3. 写 meta_connections 行（自动把旧 active 标 disconnected）
 *   4. 拉 WABA 下 phones + 写 meta_phone_numbers
 *   5. 拉 BM 下 ad_accounts + 写 meta_ad_accounts
 *   6. 订阅 webhook（POST /{waba_id}/subscribed_apps）
 *   7. onboarding 标记 + audit
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
    const mode = body?.mode || 'manual';
    log('info', 'mode', `连接模式：${mode}`);

    let token;
    if (mode === 'manual') {
      token = String(body?.token || '').trim();
      if (!token) {
        log('error', 'mode', '缺少 system user token');
        return NextResponse.json({ error: '请粘贴 system user token', logs }, { status: 400 });
      }
      log('success', 'mode', `token 已收到（长度 ${token.length}）`);
    } else if (mode === 'es') {
      const code = String(body?.code || '').trim();
      if (!code) return NextResponse.json({ error: '缺少 Embedded Signup code', logs }, { status: 400 });
      const appId = process.env.META_APP_ID;
      const appSecret = process.env.META_APP_SECRET;
      if (!appId || !appSecret) {
        log('error', 'mode', 'META_APP_ID / META_APP_SECRET 未配置');
        return NextResponse.json({
          error: 'Embedded Signup 未配置（缺 META_APP_ID / META_APP_SECRET）。请改用手动模式。',
          logs,
        }, { status: 501 });
      }
      log('info', 'mode', '正在用 ES code 换 access_token');
      const tokenRes = await graphGet('/oauth/access_token', appSecret, {
        client_id: appId,
        client_secret: appSecret,
        code,
      });
      token = tokenRes.access_token;
      log('success', 'mode', '已拿到 ES access_token');
    } else {
      return NextResponse.json({ error: `不支持的连接模式: ${mode}`, logs }, { status: 400 });
    }

    const bmIdInput = String(body?.bm_id || '').trim();
    if (bmIdInput) log('info', 'bm', `用户指定 BM ID：${bmIdInput}`);

    // 1. 解析 BM
    log('info', 'bm', '解析 token 关联的 Business Manager');
    const { bm, attempts } = await resolveBusinessManager(token, { hintBmId: bmIdInput || null });
    for (const a of attempts) {
      log(a.ok ? 'info' : 'warn', 'bm', `${a.source}: ${a.msg}`, a.data);
    }

    // 校验：token 必须属于本平台的 App，否则订阅 webhook 是给别人的 App 订阅
    const expectedAppId = config.meta?.appId || null;
    const tokenAppId = attempts.find(a => a.source === '/debug_token' && a.ok)?.data?.app_id || null;
    if (expectedAppId && tokenAppId && String(tokenAppId) !== String(expectedAppId)) {
      log('error', 'app', `token 属于 App ${tokenAppId}，本平台是 App ${expectedAppId}`);
      return NextResponse.json({
        error: `Token 属于另一个 Meta App（${tokenAppId}）。本平台 App ID 是 ${expectedAppId}。`,
        logs,
      }, { status: 400 });
    }

    if (!bm?.id) {
      log('error', 'bm', '所有 BM 解析路径都失败');
      return NextResponse.json({
        error: '无法识别该 token 关联的 Business Manager。详见日志面板的 [bm] 行。',
        logs,
      }, { status: 400 });
    }
    log('success', 'bm', `BM 解析成功：${bm.name || '(未命名)'}（${bm.id}）`);

    // 1.5 BM 跨租户共享自 2026-05-28 起允许 —— 不再在 BM 级别拒绝。
    //     BM 下面的 WABA / 广告账户 / phone 仍然各自独占；Facebook Page 允许跨租户共享。

    // 1.6 解析用户选定的 Facebook Page ID（来自 preview 勾选，可选）
    //     1 connection : 1 page；用户可暂不选，CTWA 广告投放前补即可。
    const pageIdRaw = body?.page_id;
    const pageId = pageIdRaw == null || pageIdRaw === '' ? null : String(pageIdRaw).trim();
    if (pageId && !/^\d{5,25}$/.test(pageId)) {
      log('error', 'page', `page_id 格式非法：${pageId}`);
      return NextResponse.json({
        error: 'page_id 必须是 5–25 位数字（Meta 主页 ID 都是数字串）',
        logs,
      }, { status: 400 });
    }

    // Facebook Page 允许跨租户共享 —— 不做独占校验。
    if (pageId) log('info', 'page', `用户选定 Page ${pageId}`);
    else log('info', 'page', '用户未选 page —— CTWA 广告投放前需要补绑');

    // 2. 写 meta_connections —— page_id 直接进 metadata，无需后续单独再 POST
    log('info', 'connection', '写 meta_connections（旧 active 会自动置 disconnected）');
    const conn = await createConnection({
      tenantId: ctx.tenantId,
      bmId: bm.id,
      businessName: bm.name || null,
      token,
      scopes: [],
      connectedByUserId: ctx.user.id,
      metadata: pageId ? { mode, page_id: pageId } : { mode },
    });
    log('success', 'connection', `meta_connections.id=${conn.id}（token AES-256-GCM 加密落库）`);

    // 3. 用户选定的 WABA ids（来自 preview 步骤的勾选）
    //    兼容老字段：单个 waba_id 也接受，转成数组。
    const wabaIds = Array.isArray(body?.waba_ids) && body.waba_ids.length > 0
      ? body.waba_ids.map(String).map(s => s.trim()).filter(Boolean)
      : (body?.waba_id ? [String(body.waba_id).trim()] : []);
    if (wabaIds.length === 0) {
      log('error', 'waba', '未选择任何 WABA —— 请先调 /api/meta/connect/preview 列出选项');
      return NextResponse.json({
        error: '请至少选择 1 个 WABA',
        logs,
      }, { status: 400 });
    }
    log('info', 'waba', `用户选定 ${wabaIds.length} 个 WABA：${wabaIds.join(', ')}`);

    // 跨租户独占校验：WABA 不能跟其他 active 租户重复
    {
      const { data: wabaConflicts } = await supabase
        .from('meta_phone_numbers')
        .select('waba_id, tenant_id')
        .in('waba_id', wabaIds)
        .eq('status', 'active')
        .neq('tenant_id', ctx.tenantId);
      if (wabaConflicts && wabaConflicts.length > 0) {
        const dup = [...new Set(wabaConflicts.map(r => r.waba_id))];
        log('error', 'exclusivity', `WABA ${dup.join(', ')} 已被其他租户绑定`);
        return NextResponse.json({
          error: `下列 WABA 已经被其他租户绑定：${dup.join(', ')}。每个 WABA 只能归属一个租户。`,
          logs,
        }, { status: 409 });
      }
    }

    const wabas = [];
    for (const id of wabaIds) {
      try {
        const w = await graphGet(`/${id}`, token, { fields: 'id,name' });
        wabas.push(w);
        log('success', 'waba', `WABA ${w.id} (${w.name || '-'})`);
      } catch (err) {
        log('warn', 'waba', `WABA ${id} 信息拉取失败，仍按 id 同步：${err.message}`);
        wabas.push({ id });
      }
    }

    let phonesCount = 0;
    let phonesSkipped = 0;
    for (const waba of wabas) {
      log('info', 'phones', `同步 WABA ${waba.id} 名下号码`);
      try {
        const phonesRes = await graphGet(`/${waba.id}/phone_numbers`, token);
        for (const p of phonesRes.data || []) {
          // 与 preview 一致：过滤掉测试号 / RED / 未认证号码，DB 只存可用的
          if (!isPhoneUsable(p)) {
            phonesSkipped++;
            log('info', 'phones', `跳过不可用号码 ${p.display_phone_number}（${p.verified_name || '未认证'} / ${p.quality_rating || '-'}）`);
            continue;
          }
          await upsertPhone({
            phoneNumberId: p.id,
            tenantId: ctx.tenantId,
            metaConnectionId: conn.id,
            wabaId: waba.id,
            displayNumber: p.display_phone_number,
            verifiedName: p.verified_name || null,
            qualityRating: p.quality_rating || null,
            codeVerificationStatus: p.code_verification_status || null,
            isRegistered: false,
          });
          invalidateTokenCache(p.id);
          phonesCount++;
          log('success', 'phones', `phone ${p.display_phone_number} (${p.verified_name || '-'}, ${p.quality_rating || '-'})`, {
            phone_number_id: p.id,
          });
        }
      } catch (err) {
        // 跨租户独占冲突（预检与写入之间被他人抢占）→ 直接 409 让用户重试
        if (isCrossTenantConflictError(err)) {
          log('error', 'exclusivity', `WABA ${waba.id} 号码已被其他租户抢占：${err.message}`);
          return NextResponse.json({
            error: `WABA ${waba.id} 名下号码已经被另一个租户绑定。请刷新预览后重新选择可用资源。`,
            logs,
          }, { status: 409 });
        }
        log('error', 'phones', `WABA ${waba.id} 号码同步失败：${err.message}`);
      }
    }
    log(phonesCount > 0 ? 'success' : 'warn', 'phones',
      `共同步 ${phonesCount} 个可用号码${phonesSkipped > 0 ? `，跳过 ${phonesSkipped} 个不可用` : ''}`);

    // 4. 用户选定的广告账户 —— 一个 BM 仅允许绑定 1 个广告账户
    const adAccountIdsRaw = Array.isArray(body?.ad_account_ids) && body.ad_account_ids.length > 0
      ? body.ad_account_ids.map(String).map(s => s.trim()).filter(Boolean)
      : (body?.ad_account_id ? [String(body.ad_account_id).trim()] : []);
    if (adAccountIdsRaw.length !== 1) {
      log('error', 'ads', `必须绑定且仅绑定 1 个广告账户，收到 ${adAccountIdsRaw.length} 个`);
      return NextResponse.json({
        error: adAccountIdsRaw.length === 0
          ? '请选择 1 个广告账户'
          : '仅支持绑定 1 个广告账户，请重新选择',
        logs,
      }, { status: 400 });
    }
    const adAccountIds = adAccountIdsRaw.map(id => id.startsWith('act_') ? id : `act_${id}`);
    log('info', 'ads', `用户选定 ${adAccountIds.length} 个广告账户`);

    // 跨租户独占校验：广告账户不能跟其他 active 租户重复
    {
      const { data: adConflicts } = await supabase
        .from('meta_ad_accounts')
        .select('ad_account_id, tenant_id')
        .in('ad_account_id', adAccountIds)
        .eq('status', 'active')
        .neq('tenant_id', ctx.tenantId);
      if (adConflicts && adConflicts.length > 0) {
        const dup = adConflicts.map(r => r.ad_account_id);
        log('error', 'exclusivity', `广告账户 ${dup.join(', ')} 已被其他租户绑定`);
        return NextResponse.json({
          error: `广告账户 ${dup.join(', ')} 已经被其他租户绑定，请重新选择。`,
          logs,
        }, { status: 409 });
      }
    }
    let adAccountsCount = 0;
    for (const id of adAccountIds) {
      try {
        const info = await graphGet(`/${id}`, token, { fields: 'id,name,currency,timezone_name,account_status' });
        await upsertAdAccount({
          adAccountId: info.id,
          tenantId: ctx.tenantId,
          metaConnectionId: conn.id,
          name: info.name || null,
          currency: info.currency || null,
          timezone: info.timezone_name || null,
          accountStatus: info.account_status ?? null,
        });
        adAccountsCount++;
        log('success', 'ads', `ad_account ${info.id} (${info.name || '-'} / ${info.currency || '-'})`);
      } catch (err) {
        // 跨租户独占冲突 → 409 让用户重试
        if (isCrossTenantConflictError(err)) {
          log('error', 'exclusivity', `广告账户 ${id} 已被其他租户抢占：${err.message}`);
          return NextResponse.json({
            error: `广告账户 ${id} 已经被另一个租户绑定。请刷新预览后重新选择。`,
            logs,
          }, { status: 409 });
        }
        log('error', 'ads', `广告账户 ${id} 同步失败：${err.message}`);
      }
    }

    // 5. 订阅 webhook
    let subscribedCount = 0;
    for (const waba of wabas) {
      log('info', 'webhook', `订阅 WABA ${waba.id} 的 webhook`);
      try {
        await graphPost(`/${waba.id}/subscribed_apps`, token);
        subscribedCount++;
        log('success', 'webhook', `WABA ${waba.id} 订阅成功`);
      } catch (err) {
        if (/already/i.test(err.message)) {
          subscribedCount++;
          log('info', 'webhook', `WABA ${waba.id} 之前已订阅`);
        } else {
          log('error', 'webhook', `WABA ${waba.id} 订阅失败：${err.message}`);
        }
      }
    }

    // 6. onboarding + audit
    await markMetaConnected(ctx.tenantId);
    log('success', 'onboarding', '标记 onboarding_progress.meta_connected_at');

    await recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: 'meta.connection.created',
      details: {
        mode,
        bm_id: bm.id,
        business_name: bm.name || null,
        phones_count: phonesCount,
        ad_accounts_count: adAccountsCount,
        webhook_subscribed: subscribedCount,
      },
    });
    log('success', 'audit', '写入 audit_log: meta.connection.created');

    log('success', 'done', `完成：phones=${phonesCount}, ad_accounts=${adAccountsCount}, webhook=${subscribedCount}`);

    return NextResponse.json({
      success: true,
      connection: { id: conn.id, bm_id: conn.bm_id, business_name: conn.business_name },
      counts: { phones: phonesCount, ad_accounts: adAccountsCount, webhook_subscribed: subscribedCount },
      logs,
    }, { status: 201 });
  } catch (err) {
    console.error('[meta/connect] failed:', err);
    log('error', 'fatal', err.message || '未知异常');
    return NextResponse.json({ error: err.message || '连接失败', logs }, { status: 500 });
  }
}
