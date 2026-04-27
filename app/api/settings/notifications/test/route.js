import { NextResponse } from 'next/server';
import { getTenantContext } from '@/lib/tenant-context';
import { getFeishuWebhookUrl, recordTestResult } from '@/lib/repositories/notification.repository';
import { sendFeishuMessageToWebhook } from '@/src/feishu.service';

/**
 * POST /api/settings/notifications/test
 *
 * 用当前已保存的飞书 webhook 发一条测试消息，验证连通。
 * 结果回写 feishu_last_test_* 字段。
 */
export async function POST() {
  try {
    const ctx = await getTenantContext();
    if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const url = await getFeishuWebhookUrl(ctx.tenantId);
    if (!url) {
      return NextResponse.json({
        error: '尚未配置飞书 webhook URL',
      }, { status: 400 });
    }

    const message = [
      `**🧪 LeadEngine 飞书通知测试**`,
      ``,
      `这是一条来自 LeadEngine 的测试消息。如果你看到了，说明通知通路工作正常。`,
      ``,
      `- Tenant: \`${ctx.tenantId.slice(0, 8)}…\``,
      `- 触发: ${ctx.user.email}`,
      `- 时间: ${new Date().toLocaleString('zh-CN')}`,
    ].join('\n');

    const result = await sendFeishuMessageToWebhook(url, message);
    await recordTestResult(ctx.tenantId, { ok: result.ok, error: result.error });

    if (!result.ok) {
      return NextResponse.json({ error: result.error || '测试失败' }, { status: 502 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[settings/notifications/test] failed:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
