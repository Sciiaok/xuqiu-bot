import { spawn } from 'node:child_process';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';

function tmpFile(ext) {
  return join(tmpdir(), `tx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}

function runFfmpeg(args) {
  if (!ffmpegPath) throw new Error('ffmpeg binary not found (ffmpeg-static)');
  return new Promise((resolve, reject) => {
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
}

// 浏览器录音给到的是 webm/opus(Chrome)或 mp4/aac(Safari);WhatsApp Cloud API
// 只有 ogg/opus 才会渲染成「语音条」气泡(带波形 + 时长),其它音频格式只显示成
// 普通音频文件。统一转成 ogg/opus 单声道 32kbps 再下发。
//
// 输入走临时文件:Safari 的 fragmented mp4 不能从 stdin 做 seek,会转码失败;
// 写成临时文件最稳。输出 ogg 是流式的,直接收 stdout。
export async function transcodeToOggOpus(inputBuffer, inputExt = 'webm') {
  const tmpIn = tmpFile(inputExt);
  await writeFile(tmpIn, inputBuffer);
  try {
    return await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-i', tmpIn,
      '-vn',                      // 丢掉任何视频轨
      '-ac', '1',                 // 单声道
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-application', 'voip',     // 针对语音优化的 opus 模式
      '-f', 'ogg',
      'pipe:1',
    ]);
  } finally {
    await unlink(tmpIn).catch(() => {});
  }
}

// WhatsApp 视频只接 H.264 视频 + AAC 音频;iPhone 录屏/拍摄默认是 HEVC(H.265),
// Meta 会以 #131053 拒收。统一转成 H.264 + AAC,顺手压到 720p/CRF28 控制体积。
//
// 输出 mp4 需要回填 moov atom(+faststart),不能写 stdout 管道,所以输入输出都
// 走临时文件。
export async function transcodeVideoToMp4(inputBuffer, inputExt = 'mp4') {
  const tmpIn = tmpFile(inputExt);
  const tmpOut = tmpFile('mp4');
  await writeFile(tmpIn, inputBuffer);
  try {
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-i', tmpIn,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28',
      '-vf', "scale='min(1280,iw)':-2",   // 限宽 1280,高取偶数保持比例
      '-pix_fmt', 'yuv420p',              // 最大兼容性
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', tmpOut,
    ]);
    return await readFile(tmpOut);
  } finally {
    await unlink(tmpIn).catch(() => {});
    await unlink(tmpOut).catch(() => {});
  }
}
