import { openrouter, MODELS } from './llm-client.js';
import { downloadWhatsAppMediaBuffer } from './whatsapp-media.service.js';

// WhatsApp audio mime → OpenAI Audio API `format` 枚举。WhatsApp voice notes
// 永远是 ogg/opus;用户从相册上传的可能是 mp4/m4a/mp3。未识别走 ogg 兜底。
function mimeToFormat(mime) {
  if (!mime) return 'ogg';
  const m = mime.toLowerCase();
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'mp4';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  if (m.includes('webm')) return 'webm';
  if (m.includes('flac')) return 'flac';
  return 'ogg';
}

/**
 * Transcribe a WhatsApp voice message to text.
 *
 * 2026-06-05 重写:旧版用 OpenRouter /audio/transcriptions + whisper-1 +
 * multipart,5/27 起被 OR 下线(端点保留但报 "invalid content-type" / "model
 * does not exist",10 天 100% 失败被埋住)。新路径走 /chat/completions +
 * input_audio 多模态。OpenAI gpt-audio(mini) 实测锁死在对话模式不做转写,
 * Gemini 2.5 Flash Lite 严格 verbatim 且单价比原 whisper 还便宜 20×,
 * 见 MODELS.AUDIO_TRANSCRIBE。
 *
 * @param {string} mediaId - WhatsApp media ID from webhook payload
 * @param {string} token - Tenant 的 Meta system token
 * @param {object} [meta] - { tenantId, productLine?, mimeType? }
 *                          mimeType 来自 message.audio.mime_type,未传按 ogg。
 */
export async function transcribeWhatsAppAudio(mediaId, token, meta = {}) {
  console.log(`Downloading WhatsApp audio: ${mediaId}`);
  const { buffer } = await downloadWhatsAppMediaBuffer(mediaId, { token });
  const format = mimeToFormat(meta.mimeType);
  console.log(`Downloaded ${buffer.length} bytes (format=${format}), sending to ${MODELS.AUDIO_TRANSCRIBE}...`);

  const result = await openrouter.messages.create({
    models: [MODELS.AUDIO_TRANSCRIBE],
    messages: [
      // gpt-audio 系列实测无视 prompt 锁死对话模式,Gemini 听 system message
      // 老实做转写,所以放 system 里。改模型时务必重测,模型行为差异巨大。
      { role: 'system', content: 'You are an automatic speech recognition transcription engine. Output ONLY the verbatim text spoken in the audio in its original language. Do not converse, respond, summarize, translate, or add any commentary. If the audio is unclear, output your best guess of the spoken words.' },
      { role: 'user', content: [
        { type: 'input_audio', input_audio: { data: buffer.toString('base64'), format } },
      ] },
    ],
  }, {
    tenantId: meta.tenantId,
    callSite: 'webhook.audio.transcribe',
    productLine: meta.productLine,
  });

  const text = (result.choices?.[0]?.message?.content || '').trim();
  console.log(`Audio transcript: "${text}"`);
  return text;
}
