import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../../lib/tenant-context.js';
import { getSupabaseAdmin } from '../../../../../lib/supabase-admin.js';
import { translateConversation } from '../../../../../src/translate.service.js';

/**
 * 询盘对话「翻译为中文」会话级开关 API。
 *
 *   POST /api/conversations/[id]/translate
 *     - 将 conversations.translation_enabled 置为 true
 *     - 同步触发 translateConversation()：把该会话所有未翻译、非中文的历史消
 *       息批量翻译，写回 messages.metadata.translation.zh
 *     - 返回 { enabled: true, total, translated, skipped }
 *
 *   DELETE /api/conversations/[id]/translate
 *     - 将 translation_enabled 置为 false
 *     - 已落库的 metadata.translation 保留（前端 UI 隐藏，再次开启可秒亮）
 *     - 返回 { enabled: false }
 *
 * 所有响应携带 tenant 校验（403）、conversation 存在校验（404）。
 */

async function loadConversationForTenant(conversationId, tenantId) {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('conversations')
    .select('id, tenant_id, product_line, translation_enabled')
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

  const admin = getSupabaseAdmin();

  // 1. 先置开关 —— 即使翻译过程中失败，新进消息也会按开关状态自动触发
  if (!conv.translation_enabled) {
    const { error: updErr } = await admin
      .from('conversations')
      .update({ translation_enabled: true })
      .eq('id', conversationId);
    if (updErr) {
      return NextResponse.json(
        { error: 'Internal Server Error', message: updErr.message },
        { status: 500 },
      );
    }
  }

  // 2. 批量回填历史消息（同步执行，让前端能看到结果计数）
  let result;
  try {
    result = await translateConversation(conversationId, {
      tenantId: ctx.tenantId,
      productLine: conv.product_line,
    });
  } catch (err) {
    console.error('[translate-api] batch failed', {
      conversation_id: conversationId,
      err: err.message,
    });
    // 开关已开，新消息仍会自动翻；返回 207 partial 让前端能区分提示
    return NextResponse.json(
      {
        enabled: true,
        error: 'translate_batch_failed',
        message: err.message,
      },
      { status: 207 },
    );
  }

  return NextResponse.json({ enabled: true, ...result });
}

export async function DELETE(_request, { params }) {
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

  const admin = getSupabaseAdmin();
  const { error: updErr } = await admin
    .from('conversations')
    .update({ translation_enabled: false })
    .eq('id', conversationId);
  if (updErr) {
    return NextResponse.json(
      { error: 'Internal Server Error', message: updErr.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ enabled: false });
}
