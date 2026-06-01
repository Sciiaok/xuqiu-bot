import { NextResponse } from 'next/server';
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
 * Facebook Page 允许跨租户共享 —— 不做独占校验。
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

    // 清空缓存的 page_name —— 换了 page_id 后,下次 getMetaAccountForUser 会重拉真实名称。
    await updateConnectionMetadata(conn.id, { page_id: pageId || null, page_name: null });
    return NextResponse.json({ success: true, page_id: pageId || null });
  } catch (err) {
    console.error('[meta/page-id POST] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
