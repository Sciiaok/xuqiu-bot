import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';

// 浏览器录音给到的是 webm/opus(Chrome)或 mp4/aac(Safari);WhatsApp Cloud API
// 只有 ogg/opus 才会被渲染成「语音条」气泡(带波形 + 时长),其它音频格式只显示
// 成普通音频文件。统一转成 ogg/opus 单声道 32kbps 再下发。
//
// 输入走临时文件:Safari 的 fragmented mp4 不能从 stdin 做 seek,会转码失败;
// 写成临时文件最稳。输出 ogg 是流式的,直接收 stdout。
export async function transcodeToOggOpus(inputBuffer, inputExt = 'webm') {
  if (!ffmpegPath) throw new Error('ffmpeg binary not found (ffmpeg-static)');
  const tmpIn = join(
    tmpdir(),
    `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${inputExt}`
  );
  await writeFile(tmpIn, inputBuffer);
  try {
    return await new Promise((resolve, reject) => {
      const args = [
        '-hide_banner', '-loglevel', 'error',
        '-i', tmpIn,
        '-vn',                      // 丢掉任何视频轨
        '-ac', '1',                 // 单声道
        '-c:a', 'libopus',
        '-b:a', '32k',
        '-application', 'voip',     // 针对语音优化的 opus 模式
        '-f', 'ogg',
        'pipe:1',
      ];
      const ff = spawn(ffmpegPath, args);
      const out = [];
      const err = [];
      ff.stdout.on('data', (d) => out.push(d));
      ff.stderr.on('data', (d) => err.push(d));
      ff.on('error', reject);
      ff.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(out));
        else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(err).toString().slice(-400)}`));
      });
    });
  } finally {
    await unlink(tmpIn).catch(() => {});
  }
}
