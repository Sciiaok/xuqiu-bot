import { NextResponse } from 'next/server';
import { getTenantContext } from '@/lib/tenant-context';
import { getSettings, saveFeishuWebhook } from '@/lib/repositories/notification.repository';
import { recordAudit } from '@/lib/repositories/audit-log.repository';

/**
 * GET /api/settings/notifications
 * 返回当前 tenant 的通知设置（不含明文 URL；只返"是否已配置"+ 最近测试结果）。
 */
export async function GET() {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const row = await getSettings(ctx.tenantId);
    return NextResponse.json({
      feishu: {
        enabled: Boolean(row?.feishu_enabled),
        configured: Boolean(row?.feishu_webhook_url_encrypted),
        last_test_at: row?.feishu_last_test_at || null,
        last_test_ok: row?.feishu_last_test_ok ?? null,
        last_test_error: row?.feishu_last_test_error || null,
      },
    });
  } catch (err) {
    console.error('[settings/notifications GET] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/settings/notifications
 * Body: { feishu_webhook_url } —— 留空字符串等于关闭通知
 */
export async function POST(request) {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const url = String(body?.feishu_webhook_url || '').trim();

    // 简单校验：必须是飞书 hook URL（避免误粘错地址打到外网）
    if (url && !/^https:\/\/open\.(feishu|larksuite)\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]+$/.test(url)) {
      return NextResponse.json({
        error: 'URL 看起来不像飞书自定义机器人 webhook（应形如 https://open.feishu.cn/open-apis/bot/v2/hook/xxxx）',
      }, { status: 400 });
    }

    await saveFeishuWebhook(ctx.tenantId, url);
    await recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: url ? 'notification.feishu.configured' : 'notification.feishu.cleared',
      details: {},
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[settings/notifications POST] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
