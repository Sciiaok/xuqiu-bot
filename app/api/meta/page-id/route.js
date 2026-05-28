import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { getTenantContext } from '@/lib/tenant-context';
import {
  findActiveConnectionByTenant,
  updateConnectionMetadata,
} from '@/lib/repositories/meta-connection.repository';

/**
 * POST /api/meta/page-id  { page_id: "123456..." | null }
 *
 * 保存当前 tenant active 连接的 Facebook Page ID（CTWA 广告必填）。
 * 存到 meta_connections.metadata.page_id —— 不动 schema。
 *
 * 传 null/空串 = 清空。
 *
 * 跨租户独占：同一个 page_id 不允许被两个租户的 active 连接同时持有。
 *   - 这里先 SELECT 做预检返 409（明确的错误消息）
 *   - 同时 DB 层有 idx_meta_connections_active_page_global 唯一索引兜底
 *     race（预检与写入之间被抢占时会抛 23505，翻译成 409）
 */
export async function POST(req) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const raw = body?.page_id;
    const pageId = raw == null ? null : String(raw).trim();

    if (pageId && !/^\d{5,25}$/.test(pageId)) {
      return NextResponse.json({ error: 'page_id 必须是 5–25 位数字（Meta 主页 ID 都是数字串）' }, { status: 400 });
    }

    const conn = await findActiveConnectionByTenant(ctx.tenantId);
    if (!conn) {
      return NextResponse.json({ error: '当前 tenant 没有 active Meta 连接，请先完成 Meta 连接' }, { status: 404 });
    }

    // 跨租户独占预检：同 page_id 在别的租户的 active 连接里出现过 → 409
    if (pageId) {
      const { data: dup } = await supabase
        .from('meta_connections')
        .select('tenant_id')
        .eq('status', 'active')
        .filter('metadata->>page_id', 'eq', pageId)
        .neq('tenant_id', ctx.tenantId)
        .maybeSingle();
      if (dup) {
        return NextResponse.json({
          error: `Facebook Page ${pageId} 已经被另一个租户绑定，每个 Page 只能归属一个租户。`,
        }, { status: 409 });
      }
    }

    try {
      await updateConnectionMetadata(conn.id, { page_id: pageId || null });
    } catch (err) {
      // DB 唯一索引兜底：预检之后、写入之前被他人抢占 → 23505 → 409
      if (err?.code === '23505') {
        return NextResponse.json({
          error: `Facebook Page ${pageId} 刚刚被另一个租户抢占。请使用一个新的 Page ID。`,
        }, { status: 409 });
      }
      throw err;
    }
    return NextResponse.json({ success: true, page_id: pageId || null });
  } catch (err) {
    console.error('[meta/page-id POST] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
