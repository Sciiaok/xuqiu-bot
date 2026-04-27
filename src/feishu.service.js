import { getFeishuWebhookUrl } from '../lib/repositories/notification.repository.js';

/**
 * 飞书自定义机器人 webhook 推送（V1 唯一通道）。
 *
 * 每个 tenant 在自己飞书群里加「自定义机器人」→ 复制 webhook URL → 粘到
 * /settings/notifications。我们 POST 到该 URL 推消息。
 *
 * URL 形如 https://open.feishu.cn/open-apis/bot/v2/hook/{token}
 * 一个 URL 唯一对应一个群里的一个机器人。
 */

/**
 * @param {string} markdownContent
 * @param {Object} opts
 * @param {string} opts.tenantId             目标 tenant
 * @param {boolean} [opts.atAll]             消息末尾追加 @所有人
 * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string, error?: string}>}
 */
export async function sendFeishuMessage(markdownContent, opts = {}) {
  const { tenantId, atAll = false } = opts;
  if (!tenantId) {
    throw new Error('sendFeishuMessage: tenantId required');
  }

  const url = await getFeishuWebhookUrl(tenantId);
  if (!url) {
    return { ok: false, skipped: true, reason: 'tenant_not_configured' };
  }

  return postWebhook(url, markdownContent, { atAll });
}

/**
 * 直接对一个 webhook URL 推送（不查 DB）。给 /api/settings/notifications/test 用。
 */
export async function sendFeishuMessageToWebhook(webhookUrl, markdownContent, { atAll = false } = {}) {
  return postWebhook(webhookUrl, markdownContent, { atAll });
}

async function postWebhook(url, markdownContent, { atAll }) {
  const content = atAll
    ? `${markdownContent}\n<at user_id="all">所有人</at>`
    : markdownContent;

  const payload = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      elements: [{ tag: 'markdown', content }],
    },
  };

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, error: `Feishu webhook fetch failed: ${err.message}` };
  }

  const data = await response.json().catch(() => null);
  if (!response.ok || data?.code !== 0) {
    const msg = data?.msg || `HTTP ${response.status}`;
    return { ok: false, error: `Feishu webhook error: ${msg}` };
  }
  return { ok: true };
}
