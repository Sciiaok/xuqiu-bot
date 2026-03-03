import { randomUUID } from 'crypto';

const TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const MESSAGE_URL = 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id';

// In-memory token cache
let tokenCache = { token: null, expiresAt: 0 };

async function getTenantAccessToken() {
  // Return cached token if still valid (with 5min buffer)
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 5 * 60 * 1000) {
    return tokenCache.token;
  }

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.FEISHU_APP_ID,
      app_secret: process.env.FEISHU_APP_SECRET,
    }),
  });

  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`Feishu token error: ${data.msg}`);
  }

  tokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + data.expire * 1000,
  };

  return tokenCache.token;
}

/**
 * Send a markdown message to a Feishu group chat
 * @param {string} markdownContent - Markdown text content
 * @param {boolean} atAll - Whether to @mention everyone
 * @param {string} chatId - Override chat_id (optional, defaults to FEISHU_CHAT_ID)
 * @param {string} routeUuid - Optional stable UUID for Feishu deduplication
 */
export async function sendFeishuMessage(markdownContent, atAll = false, chatId = process.env.FEISHU_CHAT_ID, routeUuid = randomUUID()) {
  const token = await getTenantAccessToken();

  const content = atAll
    ? `${markdownContent}\n<at id="all"></at>`
    : markdownContent;

  const payload = {
    receive_id: chatId,
    msg_type: 'interactive',
    uuid: routeUuid,
    content: JSON.stringify({
      elements: [{ tag: 'markdown', content }],
    }),
  };

  const response = await fetch(MESSAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`Feishu message error: ${data.msg} (code=${data.code}, uuid=${routeUuid})`);
  }

  return data;
}
