import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../../lib/tenant-context.js';
import { getSupabaseAdmin } from '../../../../../lib/supabase-admin.js';
import { translateConversation } from '../../../../../src/translate.service.js';

/**
 * 询盘对话历史消息「翻译为中文」批量回填 API。
 *
 *   POST /api/conversations/[id]/translate
 *     - 把该会话所有未翻译、非中文的历史消息批量翻译，写回
 *       messages.metadata.translation.zh。
 *     - 幂等：再次调用只翻没翻过的（shouldSkipTranslation 拦截缓存命中）。
 *     - 前端在打开会话时 fire-and-forget 调一次；新消息由 createMessage
 *       钩子自动翻译，不走这里。
 *     - 返回 { total, translated, skipped }。
 *
 * 翻译为默认行为，不再有「开/关」语义 —— 因此没有 DELETE。
 */

async function loadConversationForTenant(conversationId, tenantId) {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('conversations')
    .select('id, tenant_id, product_line')
    .eq('id', conversationId)
    .single();
  if (error || !data) return null;
  if (data.tenant_id !== tenantId) return 'forbidden';
  return data;
}

export async function POST(_request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id: conversationId } = await params;
  if (!conversationId) {
    return NextResponse.json({ error: 'Bad Request', message: 'conversationId required' }, { status: 400 });
  }

  const conv = await loadConversationForTenant(conversationId, ctx.tenantId);
  if (!conv) return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  if (conv === 'forbidden') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const result = await translateConversation(conversationId, {
      tenantId: ctx.tenantId,
      productLine: conv.product_line,
    });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[translate-api] batch failed', {
      conversation_id: conversationId,
      err: err.message,
    });
    return NextResponse.json(
      { error: 'translate_batch_failed', message: err.message },
      { status: 500 },
    );
  }
}
