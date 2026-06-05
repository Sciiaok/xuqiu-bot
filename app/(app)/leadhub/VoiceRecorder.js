'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import s from './page.module.css';

// 录满 5 分钟自动停止 —— 32kbps ogg 下约 1.2MB,远在 WhatsApp 16MB 上限内。
const MAX_SECONDS = 300;

// 优先录 opus(webm/ogg 容器),Safari 只能 mp4/aac。无论录到什么,后端都会转成
// ogg/opus 再下发,这里只挑浏览器实际支持的。
function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  const prefs = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
  return prefs.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const r = sec % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

// 对话框内录音条。idle 态只是一个「语音」按钮;录音/预览态用一条覆盖输入行的浮层。
// onSend(file) 返回 Promise<boolean>:true = 发送成功(清空重置),false = 保留预览以便重试。
export default function VoiceRecorder({ disabled, sending, onSend }) {
  const [phase, setPhase] = useState('idle'); // idle | recording | preview
  const [seconds, setSeconds] = useState(0);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [err, setErr] = useState('');

  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const mimeRef = useRef('');
  const blobRef = useRef(null);

  const stopTracks = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
  }, []);

  // 卸载时释放麦克风 + 预览 URL。
  useEffect(() => () => {
    stopTracks();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [stopTracks, previewUrl]);

  function stopRecording() {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }

  function reset() {
    stopRecording();
    stopTracks();
    chunksRef.current = [];
    blobRef.current = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setSeconds(0);
    setPhase('idle');
  }

  async function start() {
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMimeType();
      mimeRef.current = mime;
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const type = (mimeRef.current || 'audio/webm').split(';')[0];
        const blob = new Blob(chunksRef.current, { type });
        blobRef.current = blob;
        setPreviewUrl(URL.createObjectURL(blob));
        setPhase('preview');
        stopTracks();
      };
      recorderRef.current = recorder;
      recorder.start();
      setSeconds(0);
      setPhase('recording');
      timerRef.current = setInterval(() => {
        setSeconds((prev) => {
          const next = prev + 1;
          if (next >= MAX_SECONDS) stopRecording();
          return next;
        });
      }, 1000);
    } catch (e) {
      setErr(e?.name === 'NotAllowedError' ? '麦克风权限被拒绝' : '无法访问麦克风');
      stopTracks();
      setPhase('idle');
    }
  }

  async function send() {
    const blob = blobRef.current;
    if (!blob || sending) return;
    const ext = mimeRef.current.includes('mp4') ? 'm4a' : mimeRef.current.includes('ogg') ? 'ogg' : 'webm';
    const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: blob.type });
    const ok = await onSend(file);
    if (ok) reset();
    else setErr('发送失败，请重试');
  }

  if (phase === 'idle') {
    return (
      <>
        <button
          type="button"
          className={s.attachBtn}
          disabled={disabled}
          onClick={start}
          title="录制语音"
          aria-label="录制语音"
        >
          🎙 语音
        </button>
        {err && <span className={s.voiceErr}>{err}</span>}
      </>
    );
  }

  return (
    <div className={s.voiceBar}>
      {phase === 'recording' ? (
        <>
          <span className={s.voiceDot} aria-hidden />
          <span className={s.voiceTimer}>{fmt(seconds)}</span>
          <span className={s.voiceHint}>录音中…</span>
          <button type="button" className={s.voiceCancel} onClick={reset}>取消</button>
          <button type="button" className={s.voiceStop} onClick={stopRecording}>停止</button>
        </>
      ) : (
        <>
          <audio className={s.voicePreviewAudio} src={previewUrl} controls />
          <span className={s.voiceTimer}>{fmt(seconds)}</span>
          <button type="button" className={s.voiceCancel} onClick={reset} disabled={sending}>重录</button>
          <button type="button" className={s.voiceStop} onClick={send} disabled={sending}>
            {sending ? '发送中…' : '发送'}
          </button>
        </>
      )}
    </div>
  );
}
