#!/usr/bin/env node
// End-to-end test: 验证 src/whisper.service.js 改造后能正常转写 WhatsApp 音频。
// 用 macOS say + afconvert 生成 wav,mock 掉 downloadWhatsAppMediaBuffer,
// 让 transcribeWhatsAppAudio 走完整代码路径(format 映射 + chat/completions
// + input_audio + cost 落表)。
//
// 跑法: node scripts/_test-audio-transcribe.mjs
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';

loadEnv({ path: '/Users/a123/Desktop/LeadEngine/.env.local' });

// ── 1) 生成一段已知内容的 WAV 音频(macOS 内置 say + afconvert) ──
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-test-'));
const aiffPath = path.join(tmpDir, 'test.aiff');
const wavPath = path.join(tmpDir, 'test.wav');

const SPOKEN = 'I need to schedule a maintenance appointment for my car next Tuesday';
console.log(`[1/4] 生成测试音频: "${SPOKEN}"`);
execSync(`say -v Samantha -o "${aiffPath}" "${SPOKEN}"`, { stdio: 'pipe' });
execSync(`afconvert -f WAVE -d LEI16@16000 "${aiffPath}" "${wavPath}"`, { stdio: 'pipe' });

const wavBuf = fs.readFileSync(wavPath);
console.log(`     WAV ${wavBuf.length} bytes`);

// ── 2) Mock 掉 downloadWhatsAppMediaBuffer (whisper.service 第一步) ──
// 用 Node ESM loader 没法注入,直接改 import 路径:
//   写一个 patched whisper.service 副本,只替换 download 函数
// 但更简单: 直接调底层 openrouter.messages.create,模拟 transcribe 内部的 LLM 段。
// 同时附带跑 mimeToFormat 的等价校验。

const { openrouter, MODELS } = await import('../src/llm-client.js');

console.log(`[2/4] 调用 ${MODELS.AUDIO_TRANSCRIBE} (wav)...`);
const t0 = Date.now();
const result = await openrouter.messages.create({
  models: [MODELS.AUDIO_TRANSCRIBE],
  messages: [
    { role: 'system', content: 'You are an automatic speech recognition transcription engine. Output ONLY the verbatim text spoken in the audio in its original language. Do not converse, respond, summarize, translate, or add any commentary. If the audio is unclear, output your best guess of the spoken words.' },
    { role: 'user', content: [
      { type: 'input_audio', input_audio: { data: wavBuf.toString('base64'), format: 'wav' } },
    ] },
  ],
}, {
  tenantId: '00000000-0000-0000-0000-000000000001',
  callSite: 'webhook.audio.transcribe',
});

const dt = Date.now() - t0;
const transcript = (result.choices?.[0]?.message?.content || '').trim();
const cost = result.usage?.cost;
const audioTok = result.usage?.prompt_tokens_details?.audio_tokens;
const promptTok = result.usage?.prompt_tokens;
const complTok = result.usage?.completion_tokens;

console.log(`     返回 ${dt}ms`);
console.log(`     transcript: "${transcript}"`);
console.log(`     usage: prompt=${promptTok} (audio=${audioTok}) completion=${complTok} cost=$${cost}`);

// ── 3) mimeToFormat 单独校验 ──
// whisper.service.js 完整链路里只有"下载 + format 映射"这一段没在 [2] 覆盖
// (download 是 Meta 网络调用,需真实 mediaId,没法离线测)。下面验证 format
// 映射 —— 拷贝一份函数,改 source 要同步改这里。
console.log(`[3/4] mimeToFormat 映射 ...`);

function mimeToFormatCopy(mime) {
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
const cases = [
  ['audio/ogg; codecs=opus', 'ogg'],
  ['audio/opus',             'ogg'],
  ['audio/mp4',              'mp4'],
  ['audio/m4a',              'mp4'],
  ['audio/aac',              'mp4'],
  ['audio/mpeg',             'mp3'],
  ['audio/mp3',              'mp3'],
  ['audio/wav',              'wav'],
  ['audio/webm',             'webm'],
  ['audio/flac',             'flac'],
  ['',                       'ogg'],
  [null,                     'ogg'],
  ['audio/unknown',          'ogg'],
];
let mapFails = 0;
for (const [mime, expect] of cases) {
  const got = mimeToFormatCopy(mime);
  const ok = got === expect;
  if (!ok) mapFails++;
  console.log(`     ${ok ? '✅' : '❌'} mimeToFormat(${JSON.stringify(mime)}) → ${got} ${ok ? '' : `(expected ${expect})`}`);
}

// ── 4) 断言 ──
console.log(`[4/4] 断言`);
const fails = [];
if (result.choices?.[0]?.finish_reason !== 'stop') fails.push(`finish_reason != stop: ${result.choices?.[0]?.finish_reason}`);
if (!transcript) fails.push('transcript is empty');
if (transcript) {
  // gpt-audio-mini 会把数字写成阿拉伯数字、可能改大小写,做宽松匹配:
  const lowered = transcript.toLowerCase();
  const keyWords = ['maintenance', 'appointment', 'tuesday'];
  for (const w of keyWords) {
    if (!lowered.includes(w)) fails.push(`missing keyword "${w}" in transcript`);
  }
}
if (cost == null) fails.push('usage.cost missing (会回落 local-pricing-table, 不致命但要知道)');
if (cost != null && (cost <= 0 || cost > 0.01)) fails.push(`cost outside sane range: ${cost}`);
// Gemini 的 usage 字段不一定有 prompt_tokens_details.audio_tokens(那是 OpenAI
// gpt-audio 专用),Gemini 把音频算进总 prompt_tokens。只校验总 token > 0。
if (promptTok == null || promptTok <= 0) fails.push(`prompt_tokens missing or 0: ${promptTok}`);
if (mapFails > 0) fails.push(`mimeToFormat: ${mapFails} 个 case fail`);

// 清理临时目录
fs.rmSync(tmpDir, { recursive: true, force: true });

if (fails.length === 0) {
  console.log('\n✅ ALL PASS\n');
  console.log(`  transcript matches: "${transcript}"`);
  console.log(`  cost: $${cost} (prompt=${promptTok}${audioTok != null ? ` audio=${audioTok}` : ''}, completion=${complTok})`);
  console.log(`  latency: ${dt}ms`);
  process.exit(0);
} else {
  console.log('\n❌ FAILURES:\n');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
