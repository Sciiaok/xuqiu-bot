import * as lark from '@larksuiteoapi/node-sdk';
import { getRequirementBotSettings } from '../lib/repositories/requirement.repository.js';
import { config } from './config.js';

export async function getRequirementBotClient(tenantId) {
  const settings = await getRequirementBotSettings(tenantId, { includeSecrets: true });
  if (!settings?.enabled || !settings.feishu_app_id || !settings.feishu_app_secret) {
    throw new Error('Requirement bot is not configured');
  }
  return new lark.Client({
    appId: settings.feishu_app_id,
    appSecret: settings.feishu_app_secret,
    disableTokenCache: false,
  });
}

export function resolveRequirementBotTenantId() {
  return config.feishu.requirementBotCallbackTenantId || 'local';
}

export function normalizeFeishuUserId(eventUser = {}) {
  return eventUser.open_id || eventUser.user_id || eventUser.union_id || '';
}

export function parseFeishuTextMessage(message = {}) {
  const raw = message.content || '{}';
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  return String(parsed.text || '').replace(/@\S+\s*/g, '').trim();
}

export function handleFeishuUrlVerification(body) {
  if (body?.type === 'url_verification' && body?.challenge) {
    return { challenge: body.challenge };
  }
  return null;
}

export async function sendFeishuCard({ tenantId, receiveIdType = 'chat_id', receiveId, card }) {
  const client = await getRequirementBotClient(tenantId);
  const res = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  });
  return res?.data || res;
}

export async function replyFeishuText({ tenantId, messageId, content }) {
  const client = await getRequirementBotClient(tenantId);
  const res = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'text',
      content: JSON.stringify({ text: content }),
    },
  });
  return res?.data || res;
}

export async function updateFeishuCard({ tenantId, messageId, card }) {
  const client = await getRequirementBotClient(tenantId);
  const res = await client.im.message.update({
    path: { message_id: messageId },
    data: {
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  });
  return res?.data || res;
}
