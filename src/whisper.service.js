import OpenAI from 'openai';
import { config } from './config.js';
import { downloadWhatsAppMediaBuffer } from './whatsapp-media.service.js';

const openai = new OpenAI({ apiKey: config.openai.apiKey });

/**
 * Transcribe a WhatsApp voice message to text using OpenAI Whisper
 * @param {string} mediaId - WhatsApp media ID from webhook payload
 * @returns {Promise<string>} - Transcribed text
 */
export async function transcribeWhatsAppAudio(mediaId) {
  console.log(`Downloading WhatsApp audio: ${mediaId}`);
  const { buffer } = await downloadWhatsAppMediaBuffer(mediaId);
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
