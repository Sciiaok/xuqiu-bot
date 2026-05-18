import { openai, MODELS } from './llm-client.js';
import { downloadWhatsAppMediaBuffer } from './whatsapp-media.service.js';

/**
 * Transcribe a WhatsApp voice message to text using OpenAI Whisper
 * @param {string} mediaId - WhatsApp media ID from webhook payload
 * @param {string} token - Tenant 的 Meta system token (caller resolves from phoneNumberId)
 * @param {object} [meta] - { tenantId, productLine? }；2026-05-18 起必传 tenantId
 *                          以便 admin/llm-usage 看板按租户聚合 Whisper 成本。
 */
export async function transcribeWhatsAppAudio(mediaId, token, meta = {}) {
  console.log(`Downloading WhatsApp audio: ${mediaId}`);
  const { buffer } = await downloadWhatsAppMediaBuffer(mediaId, { token });
  console.log(`Downloaded ${buffer.length} bytes, sending to Whisper...`);

  const file = new File([buffer], 'audio.ogg', { type: 'audio/ogg' });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: MODELS.WHISPER,
  }, {
    tenantId: meta.tenantId,
    callSite: 'webhook.audio.transcribe',
    productLine: meta.productLine,
  });

  const text = (transcription.text || '').trim();
  console.log(`Whisper transcript: "${text}"`);
  return text;
}
