import { NextResponse } from 'next/server';
import { config } from '@/src/config';
import supabase from '@/lib/supabase';
import { getTenantContext } from '@/lib/tenant-context';
import {
  findActiveConnectionByTenant,
  upsertPhone,
  upsertAdAccount,
} from '@/lib/repositories/meta-connection.repository';
import { decryptToken } from '@/lib/meta-token-crypto';
import { invalidateTokenCache } from '@/src/whatsapp.service';

const META_API_VERSION = config.meta?.apiVersion || 'v21.0';

async function graphGet(path, token, params = {}) {
  const qs = new URLSearchParams({ access_token: token, ...params });
  const res = await fetch(`https://graph.facebook.com/${META_API_VERSION}${path}?${qs}`);
  const data = await res.json();
  if (!res.ok || data?.error) {
    throw new Error(data?.error?.message || `Meta API ${path} failed (${res.status})`);
  }
  return data;
}

/** 与 connect/preview 一致的可用号码判定 */
function isPhoneUsable(p) {
  if (!p.verified_name) return false;
  if (p.verified_name === 'Test Number') return false;
  if (p.quality_rating === 'RED') return false;
  return true;
}

/**
 * POST /api/meta/refresh
 *
 * 重新拉一次当前 tenant active 连接的 phones + ad accounts。每步落 logs[]。
 */
export async function POST() {
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

    const conn = await findActiveConnectionByTenant(ctx.tenantId);
    if (!conn) {
      log('error', 'connection', '当前 tenant 没有 active Meta 连接');
      return NextResponse.json({ error: '当前 tenant 没有 active Meta 连接', logs }, { status: 404 });
    }
    log('success', 'connection', `active connection`, { connection_id: conn.id, bm_id: conn.bm_id });

    const token = decryptToken(conn.system_user_token_encrypted);
    log('success', 'token', '解密 token 成功');

    let wabas = [];
    // 只刷新已绑 WABA（不重新列 BM 全集，否则用户没勾的 WABA 会被刷回来）
    const { data: existingPhones } = await supabase
      .from('meta_phone_numbers')
      .select('phone_number_id, waba_id')
      .eq('meta_connection_id', conn.id);
    const existingPhoneIds = new Set((existingPhones || []).map(p => p.phone_number_id));
    const boundWabaIds = [...new Set((existingPhones || []).map(p => p.waba_id).filter(Boolean))];
    wabas = boundWabaIds.map(id => ({ id }));
    log('info', 'waba', `已绑 WABA ${wabas.length} 个，逐个刷新`);

    let phonesCount = 0;
    let phonesSkipped = 0;
    const seenPhoneIds = new Set();
    for (const waba of wabas) {
      log('info', 'phones', `同步 WABA ${waba.id} 名下号码`);
      try {
        const phonesRes = await graphGet(`/${waba.id}/phone_numbers`, token);
        for (const p of phonesRes.data || []) {
          // 与 connect/preview 一致：过滤不可用号码
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
          seenPhoneIds.add(p.id);
          invalidateTokenCache(p.id);
          phonesCount++;
          log('success', 'phones', `phone ${p.display_phone_number} (${p.verified_name || '-'}, ${p.quality_rating || '-'})`);
        }
      } catch (err) {
        log('error', 'phones', `WABA ${waba.id} 号码同步失败：${err.message}`);
      }
    }
    if (phonesSkipped > 0) {
      log('warn', 'phones', `跳过 ${phonesSkipped} 个不可用号码（之前可能可用，现在被 Meta 标记为 RED/Test/未认证）`);
    }

    // 之前有但这次没看到 → 标 removed
    const goneIds = [...existingPhoneIds].filter(id => !seenPhoneIds.has(id));
    if (goneIds.length > 0) {
      await supabase.from('meta_phone_numbers')
        .update({ status: 'removed' })
        .in('phone_number_id', goneIds);
      log('warn', 'phones', `${goneIds.length} 个号码本次未在 Meta 看到 → 标 removed（产品线绑定保留）`, { phone_ids: goneIds });
    }

    // ad accounts —— 只刷新已绑定的那 1 个（连接时已限制单选），不重新列 BM
    let adAccountsCount = 0;
    const { data: boundAds } = await supabase
      .from('meta_ad_accounts')
      .select('ad_account_id')
      .eq('meta_connection_id', conn.id)
      .eq('status', 'active');
    const boundAdIds = (boundAds || []).map(r => r.ad_account_id);
    log('info', 'ads', `已绑定广告账户 ${boundAdIds.length} 个，逐个刷新`);
    for (const id of boundAdIds) {
      try {
        const info = await graphGet(`/${id}`, token, {
          fields: 'id,name,currency,timezone_name,account_status',
        });
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
        log('success', 'ads', `ad_account ${info.id} (${info.name || '-'})`);
      } catch (err) {
        log('error', 'ads', `广告账户 ${id} 刷新失败：${err.message}`);
      }
    }

    log('success', 'done', `完成：phones=${phonesCount}, ad_accounts=${adAccountsCount}, phones_removed=${goneIds.length}`);

    return NextResponse.json({
      success: true,
      counts: { phones: phonesCount, ad_accounts: adAccountsCount, phones_removed: goneIds.length },
      logs,
    });
  } catch (err) {
    console.error('[meta/refresh] failed:', err);
    log('error', 'fatal', err.message || '未知异常');
    return NextResponse.json({ error: err.message, logs }, { status: 500 });
  }
}
