import { NextResponse } from 'next/server';
import { config } from '@/src/config';
import supabase from '@/lib/supabase';
import { decryptToken } from '@/lib/meta-token-crypto';
import { recordHealthCheck } from '@/lib/repositories/meta-connection.repository';
import { recordAudit } from '@/lib/repositories/audit-log.repository';

const META_API_VERSION = config.meta?.apiVersion || 'v21.0';
const FAIL_THRESHOLD = 3;

/**
 * POST /api/cron/meta-health-check
 *
 * 每小时跑一次（PM2 / GitHub Actions / 任何 scheduler 都行）。
 *
 * 对每个 active meta_connection 调一次 /me 验 token 是否还有效。连续失败
 * FAIL_THRESHOLD（3）次 → status='revoked' + 写 audit log。下一刀前端 banner
 * 看到 != active 就提示重新连接。
 *
 * 用 cron secret 验证（同 generate-reports）。
 */
export async function POST(request) {
  try {
    const authHeader = request.headers.get('authorization');
    const cronSecret = config.secrets.cron;
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: connections, error } = await supabase
      .from('meta_connections')
      .select('id, tenant_id, bm_id, business_name, system_user_token_encrypted, health_check_failed_count')
      .eq('status', 'active');
    if (error) throw error;

    const results = { checked: 0, ok: 0, failed: 0, revoked: 0 };

    for (const conn of connections || []) {
      results.checked++;
      let token;
      try {
        token = decryptToken(conn.system_user_token_encrypted);
      } catch (err) {
        console.error(`[meta-health] decrypt failed for connection ${conn.id}:`, err.message);
        // 解密失败本身就是严重问题 —— 直接记录失败，不算 health-check 失败次数
        continue;
      }

      try {
        const url = `https://graph.facebook.com/${META_API_VERSION}/me?access_token=${encodeURIComponent(token)}`;
        const res = await fetch(url);
        const data = await res.json();
        if (!res.ok || data?.error) {
          throw new Error(data?.error?.message || `HTTP ${res.status}`);
        }
        await recordHealthCheck(conn.id, { success: true, failedCount: 0 });
        results.ok++;
      } catch (err) {
        const newFailCount = (conn.health_check_failed_count || 0) + 1;
        await recordHealthCheck(conn.id, { success: false, failedCount: newFailCount });
        results.failed++;
        if (newFailCount >= FAIL_THRESHOLD) {
          results.revoked++;
          await recordAudit({
            tenantId: conn.tenant_id,
            action: 'meta.connection.revoked_by_healthcheck',
            details: {
              connection_id: conn.id,
              bm_id: conn.bm_id,
              business_name: conn.business_name,
              failed_count: newFailCount,
              last_error: err.message,
            },
          });
          console.warn(`[meta-health] revoked connection ${conn.id} (tenant ${conn.tenant_id}): ${err.message}`);
        }
      }
    }

    return NextResponse.json({ success: true, results });
  } catch (err) {
    console.error('[meta-health-check] cron error:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

// 手动触发用 GET（管理员调试时方便）
export const GET = (request) => POST(request);
