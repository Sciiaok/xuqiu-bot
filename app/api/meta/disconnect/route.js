import { NextResponse } from 'next/server';
import { config } from '@/src/config';
import supabase from '@/lib/supabase';
import { getTenantContext } from '@/lib/tenant-context';
import {
  findActiveConnectionByTenant,
  markConnectionDisconnected,
  removePhonesByConnection,
  removeAdAccountsByConnection,
} from '@/lib/repositories/meta-connection.repository';
import { decryptToken } from '@/lib/meta-token-crypto';
import { invalidateTokenCache } from '@/src/whatsapp.service';
import { recordAudit } from '@/lib/repositories/audit-log.repository';

const META_API_VERSION = config.meta?.apiVersion || 'v21.0';

/**
 * POST /api/meta/disconnect
 *
 * 断开当前 tenant 的 active Meta 连接。每步落 logs[] 返前端可视化。
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
    log('success', 'connection', `找到 active connection`, { connection_id: conn.id, bm_id: conn.bm_id });

    // 1. 解密 token（用来 unsubscribe webhook）
    let token = null;
    try {
      token = decryptToken(conn.system_user_token_encrypted);
      log('success', 'token', '解密 token 成功');
    } catch (err) {
      log('warn', 'token', `解密失败 → 跳过 webhook 取消订阅：${err.message}`);
    }

    // 2. 收集 phone_number_ids + waba_ids
    const { data: phones } = await supabase
      .from('meta_phone_numbers')
      .select('phone_number_id, waba_id')
      .eq('meta_connection_id', conn.id);
    const phoneIds = (phones || []).map(p => p.phone_number_id);
    const wabaIds = [...new Set((phones || []).map(p => p.waba_id))];
    log('info', 'inventory', `这条 connection 涉及 ${phoneIds.length} 个 phone / ${wabaIds.length} 个 WABA`);

    // 3. 取消 WABA webhook 订阅
    if (token && wabaIds.length > 0) {
      for (const wabaId of wabaIds) {
        log('info', 'webhook', `取消订阅 WABA ${wabaId}`);
        try {
          const url = `https://graph.facebook.com/${META_API_VERSION}/${wabaId}/subscribed_apps?access_token=${encodeURIComponent(token)}`;
          const res = await fetch(url, { method: 'DELETE' });
          if (res.ok) {
            log('success', 'webhook', `WABA ${wabaId} 订阅已取消`);
          } else {
            const err = await res.json().catch(() => null);
            log('warn', 'webhook', `WABA ${wabaId} 取消失败：${err?.error?.message || res.status}（继续）`);
          }
        } catch (err) {
          log('warn', 'webhook', `WABA ${wabaId} 取消请求异常：${err.message}（继续）`);
        }
      }
    } else if (!token) {
      log('warn', 'webhook', '无可用 token，跳过 WABA 取消订阅（Meta 侧仍可能保留订阅）');
    }

    // 4. 解绑 product_lines.wa_phone_number_id
    if (phoneIds.length > 0) {
      const { data: unbound, error: unbindErr } = await supabase
        .from('product_lines')
        .update({ wa_phone_number_id: null })
        .eq('tenant_id', ctx.tenantId)
        .in('wa_phone_number_id', phoneIds)
        .select('id');
      if (unbindErr) {
        log('error', 'product_lines', `解绑失败：${unbindErr.message}`);
      } else {
        log('success', 'product_lines', `解绑 ${unbound?.length || 0} 条产品线的 wa_phone_number_id（产品线本身保留）`);
      }
    }

    // 5. 删 phones + ad_accounts
    await removePhonesByConnection(conn.id);
    log('success', 'phones', `删除 meta_phone_numbers ${phoneIds.length} 行`);
    await removeAdAccountsByConnection(conn.id);
    log('success', 'ads', `删除 meta_ad_accounts`);

    // 6. 标记 connection
    await markConnectionDisconnected(conn.id);
    log('success', 'connection', 'meta_connections.status → disconnected');

    // 7. 清 token cache
    for (const id of phoneIds) invalidateTokenCache(id);
    invalidateTokenCache();
    log('success', 'cache', '清空 whatsapp.service token cache');

    // 8. audit
    await recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: 'meta.connection.disconnected',
      details: {
        connection_id: conn.id,
        bm_id: conn.bm_id,
        phone_ids: phoneIds,
        waba_ids: wabaIds,
      },
    });
    log('success', 'audit', '写入 audit_log: meta.connection.disconnected');

    log('success', 'done', '断开完成');
    return NextResponse.json({ success: true, logs });
  } catch (err) {
    console.error('[meta/disconnect] failed:', err);
    log('error', 'fatal', err.message || '未知异常');
    return NextResponse.json({ error: err.message, logs }, { status: 500 });
  }
}
