import { NextResponse } from 'next/server';
import { getTenantContext } from '../../../../../lib/tenant-context.js';
import { getSupabaseAdmin } from '../../../../../lib/supabase-admin.js';
import { translateText } from '../../../../../src/translate.service.js';

/**
 * LeadHub「翻译并发」：把操作员的中文草稿译成客户语言，前端拿到后再走
 * /api/send-message 发出。
 *
 *   POST /api/conversations/[id]/translate-draft  body: { text }
 *     - 客户语言由该会话最近的客户消息推断，拿不准回落英文。
 *     - 纯翻译、不发送、不落库（发送仍由 send-message 统一做 takeover 校验）。
 *     - 返回 { translated }。
 */

export async function POST(request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: conversationId } = await params;
  if (!conversationId) {
    return NextResponse.json({ error: 'Bad Request', message: 'conversationId required' }, { status: 400 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) {
    return NextResponse.json({ error: 'Bad Request', message: 'text required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const { data: conv, error: convErr } = await admin
    .from('conversations')
    .select('id, tenant_id, product_line')
    .eq('id', conversationId)
    .single();
  if (convErr || !conv) return NextResponse.json({ error: 'Not Found' }, { status: 404 });
  if (conv.tenant_id !== ctx.tenantId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // 用最近几条客户消息做语言参考（客户写什么语言就译成什么语言）。
  const { data: refRows } = await admin
    .from('messages')
    .select('content')
    .eq('conversation_id', conversationId)
    .eq('role', 'user')
    .order('sent_at', { ascending: false })
    .limit(5);
  const referenceText = (refRows || [])
    .map((r) => (r.content || '').trim())
    .filter(Boolean)
    .reverse()
    .join('\n');

  try {
    const translated = await translateText(text, {
      targetLang: 'customer',
      referenceText,
      tenantId: ctx.tenantId,
      productLine: conv.product_line,
      sessionId: conversationId,
      callSite: 'translate.draft',
    });
    if (!translated) {
      return NextResponse.json({ error: 'translate_empty', message: '翻译结果为空，请重试' }, { status: 502 });
    }
    return NextResponse.json({ translated });
  } catch (err) {
    console.error('[translate-draft] failed', { conversation_id: conversationId, err: err.message });
    return NextResponse.json({ error: 'translate_failed', message: '翻译失败，请稍后重试' }, { status: 500 });
  }
}
