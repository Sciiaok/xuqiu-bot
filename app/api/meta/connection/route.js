import { NextResponse } from 'next/server';
import { config } from '@/src/config';
import { getTenantContext } from '@/lib/tenant-context';
import {
  findActiveConnectionByTenant,
  listPhonesByTenant,
  listAdAccountsByTenant,
} from '@/lib/repositories/meta-connection.repository';

/**
 * GET /api/meta/connection
 *
 * 给设置页用：返回当前 tenant 的 active 连接 + 同步过来的 phones + ad_accounts。
 * 没连接则返 { connected: false }。
 *
 * 同时返回 platform.app_id —— 用户在 BM 后台「添加应用程序」+「生成令牌时
 * 选择 App」都要用这个 ID。
 */
export async function GET() {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const platform = { app_id: config.meta?.appId || null };

    const conn = await findActiveConnectionByTenant(ctx.tenantId);
    if (!conn) {
      return NextResponse.json({ connected: false, platform });
    }

    const [phones, adAccounts] = await Promise.all([
      listPhonesByTenant(ctx.tenantId),
      listAdAccountsByTenant(ctx.tenantId),
    ]);

    return NextResponse.json({
      connected: true,
      platform,
      connection: {
        id: conn.id,
        bm_id: conn.bm_id,
        business_name: conn.business_name,
        connected_at: conn.connected_at,
        last_health_check_at: conn.last_health_check_at,
        health_check_failed_count: conn.health_check_failed_count,
        scopes: conn.scopes,
      },
      phones: (phones || []).map(p => ({
        phone_number_id: p.phone_number_id,
        display_number: p.display_number,
        verified_name: p.verified_name,
        quality_rating: p.quality_rating,
        waba_id: p.waba_id,
        is_registered: p.is_registered,
      })),
      ad_accounts: (adAccounts || []).map(a => ({
        ad_account_id: a.ad_account_id,
        name: a.name,
        currency: a.currency,
        timezone: a.timezone,
        account_status: a.account_status,
      })),
    });
  } catch (err) {
    console.error('[meta/connection GET] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
