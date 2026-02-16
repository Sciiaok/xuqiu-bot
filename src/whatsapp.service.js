import { config } from './config.js';

/**
 * Send a message to a WhatsApp user
 * @param {string} waId - WhatsApp user ID
 * @param {string} messageText - Message content to send
 * @returns {Promise<Object>} - WhatsApp API response
 */
export async function sendMessage(waId, messageText) {
  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;

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
export async function markAsRead(messageId) {
  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;

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
