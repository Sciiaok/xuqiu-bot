import OpenAI from 'openai';
import { config } from './config.js';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Download audio media from WhatsApp using media ID
 * @param {string} mediaId - WhatsApp media ID from webhook payload
 * @returns {Promise<Buffer>} - Audio bytes
 */
async function downloadWhatsAppMedia(mediaId) {
  // Step 1: Resolve download URL from media ID
  const metaRes = await fetch(
    `https://graph.facebook.com/${config.whatsapp.apiVersion}/${mediaId}`,
    { headers: { Authorization: `Bearer ${config.whatsapp.token}` } }
  );

  if (!metaRes.ok) {
    const err = await metaRes.json();
    throw new Error(`WhatsApp media metadata error: ${JSON.stringify(err)}`);
  }

  const { url } = await metaRes.json();

  // Step 2: Download the raw audio bytes
  const audioRes = await fetch(url, {
    headers: { Authorization: `Bearer ${config.whatsapp.token}` },
  });

  if (!audioRes.ok) {
    throw new Error(`WhatsApp audio download failed: HTTP ${audioRes.status}`);
  }

  return Buffer.from(await audioRes.arrayBuffer());
}

/**
 * Transcribe a WhatsApp voice message to text using OpenAI Whisper
 * @param {string} mediaId - WhatsApp media ID from webhook payload
 * @returns {Promise<string>} - Transcribed text
 */
export async function transcribeWhatsAppAudio(mediaId) {
  console.log(`Downloading WhatsApp audio: ${mediaId}`);
  const buffer = await downloadWhatsAppMedia(mediaId);
  console.log(`Downloaded ${buffer.length} bytes, sending to Whisper...`);

  // Pass buffer directly to Whisper — no S3 needed
  const file = new File([buffer], 'audio.ogg', { type: 'audio/ogg' });

  const transcription = await openai.audio.transcriptions.create({
    file,
    model: 'whisper-1',
  });

  const text = transcription.text.trim();
  console.log(`Whisper transcript: "${text}"`);
  return text;
}
