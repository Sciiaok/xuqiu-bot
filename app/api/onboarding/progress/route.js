import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { getTenantContext } from '@/lib/tenant-context';
import { getProgress, dismissOnboarding } from '@/lib/repositories/onboarding.repository';

/**
 * GET /api/onboarding/progress
 *
 * 返回当前 tenant 的 onboarding 状态 + 衍生的 step 完成判断。
 * UI 用来渲染主页面顶部的进度卡片。
 */
export async function GET() {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const progress = await getProgress(ctx.tenantId) || {};

    // 衍生判断：第 4 步「配置 AI」需要看 product_lines 是否有 catalog_description
    // 和 lead_fields，跨表查；如果还没第 3 步（建产品线）就直接 false
    let aiConfigured = false;
    if (progress.first_product_line_at) {
      const { data: lines } = await supabase
        .from('product_lines')
        .select('id, catalog_description, lead_fields')
        .eq('tenant_id', ctx.tenantId)
        .eq('is_active', true);
      aiConfigured = (lines || []).some(l =>
        Boolean((l.catalog_description || '').trim()) &&
        Array.isArray(l.lead_fields) && l.lead_fields.length > 0
      );
    }

    const steps = [
      { key: 'account_created', label: '创建账号', done: Boolean(progress.account_created_at), at: progress.account_created_at },
      { key: 'meta_connected', label: '连接 Meta Business', done: Boolean(progress.meta_connected_at), at: progress.meta_connected_at, link: '/settings/meta-connection' },
      { key: 'first_product_line', label: '创建第一条产品线', done: Boolean(progress.first_product_line_at), at: progress.first_product_line_at, link: '/product-lines' },
      { key: 'ai_configured', label: '配置 AI 知识', done: aiConfigured, link: '/product-lines' },
      { key: 'first_kb_upload', label: '上传知识文档（可选）', done: Boolean(progress.first_kb_uploaded_at), at: progress.first_kb_uploaded_at, optional: true, link: '/product-lines' },
      { key: 'first_ai_reply', label: '收到第一次客户消息 + AI 自动回复', done: Boolean(progress.first_ai_reply_at), at: progress.first_ai_reply_at },
    ];

    const requiredDone = steps.filter(s => !s.optional && s.done).length;
    const requiredTotal = steps.filter(s => !s.optional).length;
    const completedAll = requiredDone === requiredTotal;

    return NextResponse.json({
      progress,
      steps,
      summary: {
        required_done: requiredDone,
        required_total: requiredTotal,
        completed: completedAll,
        dismissed: Boolean(progress.dismissed_at),
      },
    });
  } catch (err) {
    console.error('[onboarding/progress GET] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/onboarding/progress  body: { action: 'dismiss' }
 */
export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json().catch(() => ({}));
    if (body?.action === 'dismiss') {
      await dismissOnboarding(ctx.tenantId);
      return NextResponse.json({ success: true });
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (err) {
    console.error('[onboarding/progress POST] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
