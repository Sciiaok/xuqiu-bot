import { config } from './config.js';
import { findConnectionByPhoneNumberId } from '../lib/repositories/meta-connection.repository.js';

/**
 * Token 解析：从 meta_phone_numbers + meta_connections 反查 phoneNumberId 对应
 * tenant 的 system token。找不到 → 抛错（说明该 phone 所属的 tenant 还没接
 * Meta BM，不该走到这里）。无 env fallback。
 *
 * 5 分钟内存 cache，避免每条出向消息都打 DB。
 */
const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;
const tokenCache = new Map(); // phoneNumberId -> { token, expiresAt }

async function resolveToken(phoneNumberId) {
  if (!phoneNumberId) {
    throw new Error('whatsapp.service: phoneNumberId required to resolve tenant token');
  }
  const cached = tokenCache.get(phoneNumberId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  const conn = await findConnectionByPhoneNumberId(phoneNumberId);
  if (!conn?.token) {
    throw new Error(
      `whatsapp.service: no active Meta connection for phone_number_id=${phoneNumberId}; tenant must connect via /settings/meta-connection`
    );
  }
  tokenCache.set(phoneNumberId, { token: conn.token, expiresAt: Date.now() + TOKEN_CACHE_TTL_MS });
  return conn.token;
}

export function invalidateTokenCache(phoneNumberId) {
  if (phoneNumberId) tokenCache.delete(phoneNumberId);
  else tokenCache.clear();
}

// Meta Graph 错误形如 { error: { code, message, error_subcode, fbtrace_id, ... } }
// 上游 send-message 路由用这些字段把失败原因落 messages.metadata.delivery.error，
// 不再用正则去硬撕 message 字符串。
function makeMetaError(label, httpStatus, errorData) {
  const inner = errorData?.error || {};
  const err = new Error(`${label} - ${JSON.stringify(errorData)}`);
  err.metaStatus = httpStatus;
  err.metaCode = inner.code ?? null;
  err.metaSubcode = inner.error_subcode ?? null;
  err.metaMessage = inner.message ?? null;
  err.metaTraceId = inner.fbtrace_id ?? null;
  return err;
}

/**
 * Send a message to a WhatsApp user
 * @param {string} waId - WhatsApp user ID
 * @param {string} messageText - Message content to send
 * @returns {Promise<Object>} - WhatsApp API response
 */
export async function sendMessage(waId, messageText, phoneNumberId) {
  const pnid = phoneNumberId;
  const token = await resolveToken(pnid);
  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${pnid}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to: waId,
    type: 'text',
    text: {
      body: messageText,
    },
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('WhatsApp API error:', errorData);
      throw makeMetaError(`WhatsApp API error: ${response.status}`, response.status, errorData);
    }

    const data = await response.json();
    console.log(`✓ Message sent to ${waId}`);
    return data;
  } catch (error) {
    console.error('Failed to send WhatsApp message:', error);
    throw error;
  }
}

/**
 * Mark a message as read
 * @param {string} messageId - WhatsApp message ID
 */
export async function markAsRead(messageId, phoneNumberId) {
  const pnid = phoneNumberId;
  const token = await resolveToken(pnid);
  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${pnid}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: messageId,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('Failed to mark message as read:', errorData);
    }
  } catch (error) {
    console.error('Error marking message as read:', error);
    // Non-critical, don't throw
  }
}

// Strict type whitelist — only these MIME types are allowed
const ALLOWED_MEDIA_TYPES = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'video/mp4': 'video',
  'video/3gpp': 'video',
  // 语音:浏览器录的是 webm/opus(Chrome)或 mp4/aac(Safari),也接受直传的
  // ogg/mp3。最终都会在 send-message 路由里被转码成 ogg/opus 再下发。
  'audio/ogg': 'audio',
  'audio/webm': 'audio',
  'audio/mp4': 'audio',
  'audio/mpeg': 'audio',
  'audio/aac': 'audio',
  'application/pdf': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
};

// WhatsApp size limits (bytes)
const MAX_MEDIA_SIZE = {
  image: 5 * 1024 * 1024,    // 5MB
  video: 16 * 1024 * 1024,   // 16MB
  audio: 16 * 1024 * 1024,   // 16MB
  document: 100 * 1024 * 1024, // 100MB
};

/**
 * Validate media type and size
 * @param {string} mimeType
 * @param {number} sizeBytes
 * @returns {{ valid: boolean, waType: string|null, error: string|null }}
 */
export function validateMedia(mimeType, sizeBytes) {
  const waType = ALLOWED_MEDIA_TYPES[mimeType];
  if (!waType) {
    return { valid: false, waType: null, error: `Unsupported media type: ${mimeType}` };
  }
  const maxSize = MAX_MEDIA_SIZE[waType];
  if (sizeBytes > maxSize) {
    return { valid: false, waType, error: `File too large: ${(sizeBytes / 1024 / 1024).toFixed(1)}MB exceeds ${waType} limit of ${maxSize / 1024 / 1024}MB` };
  }
  return { valid: true, waType, error: null };
}

/**
 * Send a media message (image/video/document) to a WhatsApp user
 */
export async function sendMedia(waId, type, fileBuffer, mimeType, filename, caption, phoneNumberId) {
  const pnid = phoneNumberId;
  const token = await resolveToken(pnid);
  const baseUrl = `https://graph.facebook.com/${config.whatsapp.apiVersion}`;

  // Step 1: Upload media to WhatsApp
  const formData = new FormData();
  formData.append('messaging_product', 'whatsapp');
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), filename || 'file');
  formData.append('type', mimeType);

  const uploadResponse = await fetch(`${baseUrl}/${pnid}/media`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
    body: formData,
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json();
    console.error('WhatsApp media upload error:', errorData);
    throw makeMetaError(`WhatsApp media upload error: ${uploadResponse.status}`, uploadResponse.status, errorData);
  }

  const { id: mediaId } = await uploadResponse.json();

  // Step 2: Send message with media_id
  const mediaPayload = { id: mediaId };
  // Meta 的 audio 消息不支持 caption,带上会直接 400;只有 image/video/document 接。
  if (caption && type !== 'audio') mediaPayload.caption = caption;
  if (type === 'document' && filename) mediaPayload.filename = filename;

  const payload = {
    messaging_product: 'whatsapp',
    to: waId,
    type: type,
    [type]: mediaPayload,
  };

  const sendResponse = await fetch(`${baseUrl}/${pnid}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!sendResponse.ok) {
    const errorData = await sendResponse.json();
    console.error('WhatsApp media send error:', errorData);
    throw makeMetaError(`WhatsApp media send error: ${sendResponse.status}`, sendResponse.status, errorData);
  }

  const data = await sendResponse.json();
  console.log(`✓ Media (${type}) sent to ${waId}`);
  return data;
}
