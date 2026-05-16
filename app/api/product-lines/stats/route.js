import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../lib/tenant-context.js';
import { getSupabaseAdmin } from '../../../../lib/supabase-admin.js';
import { getAllProductLines } from '../../../../lib/repositories/product-line.repository.js';

/**
 * GET /api/product-lines/stats
 *
 * 返回每个 product_line 的对话总数 / 入站消息总数。供 /product-lines 列表卡片
 * 显示用，独立于 GET /api/product-lines（这样卡片 stats 慢的话也不挡列表渲染）。
 *
 * 形态：{ stats: { [productLineId]: { conversations, inbound_messages } } }
 *
 * 对话 = COUNT(conversations) WHERE product_line = X
 * 入站消息 = COUNT(messages JOIN conversations ON product_line) WHERE role='user'
 *   入站 = 客户发来的消息（role='user'），AI 回复是 role='assistant'。
 */
export async function GET() {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const lines = await getAllProductLines({ tenantId: ctx.tenantId });
    if (lines.length === 0) {
      return NextResponse.json({ stats: {} });
    }

    const admin = getSupabaseAdmin();
    // N product lines × 2 count queries each, run in parallel. N 通常 1-5。
    const pairs = await Promise.all(
      lines.map(async (line) => {
        const [convRes, msgRes] = await Promise.all([
          admin
            .from('conversations')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', ctx.tenantId)
            .eq('product_line', line.id),
          admin
            .from('messages')
            .select('id, conversations!inner(product_line)', { count: 'exact', head: true })
            .eq('tenant_id', ctx.tenantId)
            .eq('conversations.product_line', line.id)
            .eq('role', 'user'),
        ]);
        if (convRes.error) throw new Error(`conversations count: ${convRes.error.message}`);
        if (msgRes.error) throw new Error(`messages count: ${msgRes.error.message}`);
        return [line.id, {
          conversations: convRes.count || 0,
          inbound_messages: msgRes.count || 0,
        }];
      }),
    );

    return NextResponse.json({ stats: Object.fromEntries(pairs) });
  } catch (err) {
    console.error('GET /api/product-lines/stats failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
