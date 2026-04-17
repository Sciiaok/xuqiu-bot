import { config } from './config.js';

/**
 * Send a message to a WhatsApp user
 * @param {string} waId - WhatsApp user ID
 * @param {string} messageText - Message content to send
 * @returns {Promise<Object>} - WhatsApp API response
 */
export async function sendMessage(waId, messageText, phoneNumberId) {
  const pnid = phoneNumberId;
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
        'Authorization': `Bearer ${config.whatsapp.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('WhatsApp API error:', errorData);
      throw new Error(`WhatsApp API error: ${response.status} - ${JSON.stringify(errorData)}`);
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
        'Authorization': `Bearer ${config.whatsapp.token}`,
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
  'application/pdf': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
};

// WhatsApp size limits (bytes)
const MAX_MEDIA_SIZE = {
  image: 5 * 1024 * 1024,    // 5MB
  video: 16 * 1024 * 1024,   // 16MB
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
 * @param {string} waId - WhatsApp user ID
 * @param {string} type - 'image' | 'video' | 'document' (validated by caller)
 * @param {Buffer} fileBuffer - File binary data
 * @param {string} mimeType - MIME type
 * @param {string} [filename] - Original filename
 * @param {string} [caption] - Optional caption text
 * @param {string} [phoneNumberId] - Override phone number ID (for multi-agent)
 * @returns {Promise<Object>} - WhatsApp API response
 */
export async function sendMedia(waId, type, fileBuffer, mimeType, filename, caption, phoneNumberId) {
  const pnid = phoneNumberId;
  const baseUrl = `https://graph.facebook.com/${config.whatsapp.apiVersion}`;

  // Step 1: Upload media to WhatsApp
  const formData = new FormData();
  formData.append('messaging_product', 'whatsapp');
  formData.append('file', new Blob([fileBuffer], { type: mimeType }), filename || 'file');
  formData.append('type', mimeType);

  const uploadResponse = await fetch(`${baseUrl}/${pnid}/media`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.whatsapp.token}`,
    },
    body: formData,
  });

  if (!uploadResponse.ok) {
    const errorData = await uploadResponse.json();
    console.error('WhatsApp media upload error:', errorData);
    throw new Error(`WhatsApp media upload error: ${uploadResponse.status} - ${JSON.stringify(errorData)}`);
  }

  const { id: mediaId } = await uploadResponse.json();

  // Step 2: Send message with media_id
  const mediaPayload = { id: mediaId };
  if (caption) mediaPayload.caption = caption;
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
      'Authorization': `Bearer ${config.whatsapp.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!sendResponse.ok) {
    const errorData = await sendResponse.json();
    console.error('WhatsApp media send error:', errorData);
    throw new Error(`WhatsApp media send error: ${sendResponse.status} - ${JSON.stringify(errorData)}`);
  }

  const data = await sendResponse.json();
  console.log(`✓ Media (${type}) sent to ${waId}`);
  return data;
}
