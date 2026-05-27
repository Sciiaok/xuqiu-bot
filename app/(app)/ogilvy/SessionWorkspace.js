'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import s from './ogilvy.module.css';
import OgilvyMarkdown from './components/OgilvyMarkdown';
import AdPlanCard from './components/AdPlanCard';
import UsageBadge from './components/UsageBadge';
import StageArchive from './components/StageArchive';
import CreativesPanel from './components/CreativesPanel';
import Skeleton, { SkeletonStack } from '../../components/Skeleton/Skeleton';
import { useMessageStream } from './hooks/useMessageStream';
import { deriveSessionStatus, summarizeAdStatuses } from './lib/session-status';

/**
 * SessionWorkspace — the chat + plan + composer surface that lives inside the
 * modal. Owns all the per-session state: messages, plan, attachments, launch
 * progress, ad statuses. The parent grid is concerned only with opening /
 * closing this; once mounted it self-drives.
 *
 * Layout: two columns inside a single flex root —
 *   ┌──────────────────────────┬─────────────────┐
 *   │  chat scroll + composer  │  plan / archive │
 *   └──────────────────────────┴─────────────────┘
 *
 * Props are intentionally small: just the session id + a couple of callbacks
 * the parent grid uses to refresh the surrounding card list after
 * launch / pause / status changes.
 */
export default function SessionWorkspace({ sessionId, session, productLineName, onClose, onSessionChanged }) {
  // ── Data state ──────────────────────────────────────────────
  const [messages, setMessages] = useState([]);
  const [plan, setPlan] = useState(null);
  const [archives, setArchives] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [inputVal, setInputVal] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const fileInputRef = useRef(null);
  const [streamingPlan, setStreamingPlan] = useState(null);
  const [usageRefreshKey, setUsageRefreshKey] = useState(0);
  const prevStreamingRef = useRef(false);

  // ── Load messages on session change ─────────────────────────
  useEffect(() => {
    if (!sessionId) return;
    let cancel = false;
    (async () => {
      setLoadingMessages(true);
      try {
        const r = await fetch(`/api/ogilvy/conversations/${sessionId}`).then(r => r.json());
        if (cancel) return;
        setMessages(r.messages || []);
        setPlan(r.session?.plan_json || null);
        setArchives(Array.isArray(r.session?.stage_outputs) ? r.session.stage_outputs : []);
      } catch (err) {
        if (!cancel) console.error('[SessionWorkspace] load messages failed:', err);
      } finally {
        if (!cancel) setLoadingMessages(false);
      }
    })();
    return () => { cancel = true; };
  }, [sessionId]);

  // ── SSE streaming hook ──────────────────────────────────────
  // onUserSaved / onAssistantFinal aren't no-ops anymore. They reconcile the
  // optimistic tempId user row with the server uuid, and append the final
  // assistant row in the same React batch that clears streamingText — so the
  // transition from "streaming preview div" to "persisted MessageRow" happens
  // in a single render (no blank intermediate frame, no DOM unmount-remount).
  const { send, stop, streamingText, toolStatus, isStreaming } = useMessageStream({
    onUserSaved: ({ id }) => {
      if (!id) return;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== 'user') return prev;
        if (typeof last.id !== 'string' || !last.id.startsWith('u-')) return prev;
        return [...prev.slice(0, -1), { ...last, id }];
      });
    },
    onPlanPartial: (partial) => setStreamingPlan(partial),
    onToolResult: async (data) => {
      if (data.tool === 'draft_ad_plan' && data.result?.ok) {
        setStreamingPlan(null);
        const r = await fetch(`/api/ogilvy/conversations/${sessionId}`).then(r => r.json());
        setPlan(r.session?.plan_json || null);
        setArchives(Array.isArray(r.session?.stage_outputs) ? r.session.stage_outputs : []);
      }
      if (data.tool === 'persist_stage_output' && data.result?.ok) {
        const r = await fetch(`/api/ogilvy/conversations/${sessionId}`).then(r => r.json());
        setArchives(Array.isArray(r.session?.stage_outputs) ? r.session.stage_outputs : []);
      }
    },
    onAssistantFinal: ({ content, id }) => {
      if (!content) return;
      setMessages(prev => [...prev, {
        id: id || `a-${Date.now()}`,
        role: 'assistant',
        content,
      }]);
    },
    onError: (err) => {
      setStreamingPlan(null);
      setMessages(prev => [...prev, {
        id: `err-${Date.now()}`, role: 'assistant', content: `发生错误：${err.message}`, __error: true,
      }]);
    },
  });

  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming) {
      setUsageRefreshKey(k => k + 1);
      onSessionChanged?.();  // bump parent so grid card pulls latest plan / status
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, onSessionChanged]);

  const refreshSelected = useCallback(async () => {
    if (!sessionId) return;
    const r = await fetch(`/api/ogilvy/conversations/${sessionId}`).then(r => r.json());
    setMessages(r.messages || []);
    setPlan(r.session?.plan_json || null);
    setArchives(Array.isArray(r.session?.stage_outputs) ? r.session.stage_outputs : []);
    onSessionChanged?.();
  }, [sessionId, onSessionChanged]);

  // ── Upload handling ─────────────────────────────────────────
  // Two kinds of uploads:
  //   - image (jpg/png/gif/webp) → preview thumbnail in chip,sent as
  //     image_url block to the LLM via attachment row.url
  //   - doc (pdf/docx/md/txt/csv) → server parses to text and returns it
  //     inline; we render a 📄 chip with filename + char count. On send,
  //     ogilvy.repository.buildDocPreface stuffs the text into the user
  //     message before it reaches the model.
  async function uploadOne(file, sessionIdForPath) {
    const tempId = `up-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const isImage = file.type.startsWith('image/');
    // Only create object URL for images — docs have no preview.
    const preview = isImage ? URL.createObjectURL(file) : null;
    setPendingAttachments(prev => [...prev, {
      id: tempId,
      file,
      preview,
      uploading: true,
      uploaded: null,
      // Optimistic kind for UI rendering during upload. Server may correct.
      kind: isImage ? 'image' : 'doc',
      filename: file.name,
    }]);

    try {
      const fd = new FormData();
      fd.append('file', file);
      if (sessionIdForPath) fd.append('session_id', sessionIdForPath);
      const res = await fetch('/api/ogilvy/upload', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `上传失败 (HTTP ${res.status})`);
      }
      const uploaded = await res.json();
      // Server response carries kind:'image' or kind:'doc'. Trust it as
      // source of truth — overrides our optimistic guess.
      setPendingAttachments(prev => prev.map(p => p.id === tempId
        ? { ...p, uploading: false, uploaded, kind: uploaded.kind || p.kind }
        : p));
    } catch (err) {
      window.alert(err.message);
      setPendingAttachments(prev => prev.filter(p => p.id !== tempId));
      if (preview) URL.revokeObjectURL(preview);
    }
  }

  // Accept images + docs. file.type can be empty for some browsers/OSes
  // on .md / .docx — backend also falls back to extension,so just gate
  // here loosely (any non-empty file).
  async function handleFilesSelected(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    for (const f of files) await uploadOne(f, sessionId);
  }

  function removePendingAttachment(id) {
    setPendingAttachments(prev => {
      const target = prev.find(p => p.id === id);
      if (target?.preview) URL.revokeObjectURL(target.preview);
      return prev.filter(p => p.id !== id);
    });
  }

  /**
   * Inject an already-hosted image URL (e.g. from CreativesPanel) into
   * pendingAttachments. Skips the upload step entirely — server-side the
   * `attachments` payload is URL-shaped regardless of origin, so the message
   * route doesn't need to know it's a re-imported image.
   *
   * Dedupes by URL so double-clicking "导入" doesn't stack the same image.
   */
  const addAttachmentFromUrl = useCallback(({ url, content_type }) => {
    if (!url) return;
    setPendingAttachments(prev => {
      if (prev.some(p => p.uploaded?.url === url)) return prev;
      return [
        ...prev,
        {
          id: `import-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          preview: url,
          uploading: false,
          uploaded: { url, content_type: content_type || 'image/png' },
        },
      ];
    });
  }, []);

  async function handleSend() {
    const text = inputVal.trim();
    const readyAttachments = pendingAttachments.filter(p => p.uploaded);
    const stillUploading = pendingAttachments.some(p => p.uploading);
    if (stillUploading) return;
    if ((!text && !readyAttachments.length) || isStreaming) return;
    if (!sessionId) return;

    // Sending a new turn = user wants to follow the response. Re-engage
    // auto-follow even if they had scrolled up earlier in the session.
    stuckToBottomRef.current = true;

    const tempId = `u-${Date.now()}`;
    const attachmentsPayload = readyAttachments.map(p => p.uploaded);
    setMessages(prev => [...prev, {
      id: tempId,
      role: 'user',
      content: text,
      attachments: attachmentsPayload,
    }]);
    setInputVal('');
    readyAttachments.forEach(p => p.preview && URL.revokeObjectURL(p.preview));
    setPendingAttachments([]);

    await send(sessionId, text, attachmentsPayload);
    await refreshSelected();
  }

  async function handleStop() {
    stop();
    if (sessionId) await refreshSelected();
  }

  // ── Launch flow ────────────────────────────────────────────
  const [launchProgress, setLaunchProgress] = useState(null);
  const [controlBusy, setControlBusy] = useState(false);

  const [adStatuses, setAdStatuses] = useState(null);
  const [refreshingStatus, setRefreshingStatus] = useState(false);
  const adStatusFetchedAtRef = useRef(0);

  const fetchAdStatuses = useCallback(async (id) => {
    if (!id) return;
    if (Date.now() - adStatusFetchedAtRef.current < 30_000) return;
    setRefreshingStatus(true);
    try {
      const res = await fetch(`/api/ogilvy/conversations/${id}/ad-status`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAdStatuses({ ads: [], summary: null, error: body.error || `HTTP ${res.status}` });
      } else {
        const ads = body.ads || [];
        const summary = ads.length > 0 ? summarizeAdStatuses(ads) : null;
        setAdStatuses({ ads, summary, fetched_at: body.fetched_at });
      }
    } catch (err) {
      setAdStatuses({ ads: [], summary: null, error: err.message });
    } finally {
      adStatusFetchedAtRef.current = Date.now();
      setRefreshingStatus(false);
    }
  }, []);

  useEffect(() => {
    setAdStatuses(null);
    adStatusFetchedAtRef.current = 0;
    if (!sessionId) return;
    const status = plan?.status;
    if (status === 'launched' || status === 'paused') {
      fetchAdStatuses(sessionId);
    }
  }, [sessionId, plan?.status, fetchAdStatuses]);

  const handleRefreshStatus = useCallback(() => {
    adStatusFetchedAtRef.current = 0;
    fetchAdStatuses(sessionId);
  }, [sessionId, fetchAdStatuses]);

  async function handlePause() {
    if (!sessionId || controlBusy) return;
    setControlBusy(true);
    try {
      const res = await fetch(`/api/ogilvy/conversations/${sessionId}/pause`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    } catch (err) {
      window.alert(`暂停失败：${err.message}`);
    } finally {
      setControlBusy(false);
      await refreshSelected();
    }
  }

  async function handleResume() {
    if (!sessionId || controlBusy) return;
    setControlBusy(true);
    try {
      const res = await fetch(`/api/ogilvy/conversations/${sessionId}/resume`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    } catch (err) {
      window.alert(`恢复失败：${err.message}`);
    } finally {
      setControlBusy(false);
      await refreshSelected();
    }
  }

  async function handleLaunch() {
    if (!sessionId || !plan) return;
    setLaunchProgress({ phase: 'starting', detail: '连接 Meta…' });
    const skippedAds = [];
    let launchedPayload = null;
    let stageError = null;
    try {
      const res = await fetch(`/api/ogilvy/conversations/${sessionId}/launch`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let eventType = null;
      // Terminal-event guard: the SSE generator emits `launched` or `error`
      // as its last frame and then `streamSSE` closes the controller. But the
      // browser's `reader.read()` doesn't always observe the close promptly
      // when the connection passes through Cloudflare / load balancers that
      // keep the underlying TCP alive on heartbeats — leaving the UI stuck
      // on "启动中…" even though the server is done. Once we've seen the
      // terminal event, cancel the reader to force the finally block to run.
      let terminated = false;
      outer: while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7);
          else if (line.startsWith('data: ') && eventType) {
            const currentEvent = eventType;
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === 'stage_progress' && data?.type === 'error' && data?.ad) {
                skippedAds.push({ ad: data.ad, error: data.error });
              }
              if (currentEvent === 'launched') {
                launchedPayload = data;
              }
              if (currentEvent === 'error') {
                stageError = data;
              }
              handleLaunchEvent(currentEvent, data);
            } catch {}
            eventType = null;
            if (currentEvent === 'launched' || currentEvent === 'error') {
              terminated = true;
              break outer;
            }
          }
        }
      }
      if (terminated) {
        // Best-effort cancel; ignore if the stream already closed.
        try { await reader.cancel(); } catch {}
      }
      // Build the "what to warn about" summary. Three independent sources:
      //   1. skippedAds  — stage_progress events that yielded `type:'error'`
      //      (a specific ad was skipped during stage; the rest continued)
      //   2. stage failure with partial_ids — stage threw partway, the
      //      partial Meta resources persisted on the session need cleanup
      //   3. launched.partial — activate succeeded on some entities but
      //      failed on others; user is spending money on what survived
      //      and needs to know what didn't activate
      if (stageError) {
        const partial = stageError.partial_ids;
        const partialMsg = partial && (partial.campaign_ids?.length || partial.adset_ids?.length || partial.ad_ids?.length)
          ? `\n\n已在 Meta 上创建的孤儿资源(${[
              partial.campaign_ids?.length && `${partial.campaign_ids.length} campaign`,
              partial.adset_ids?.length && `${partial.adset_ids.length} adset`,
              partial.creative_ids?.length && `${partial.creative_ids.length} creative`,
              partial.ad_ids?.length && `${partial.ad_ids.length} ad`,
            ].filter(Boolean).join(', ')})需要去 Meta 后台手动清理 — IDs 已保存在 plan_json.meta_*_ids。`
          : '';
        window.alert(`${stageError.phase} 阶段失败:${stageError.message}${partialMsg}`);
      } else if (launchedPayload?.partial) {
        const failed = launchedPayload.activate_results?.filter(r => r.error) || [];
        const lines = failed.map(r => `· ${r.level} ${r.id?.slice(-6) || '?'}: ${r.error}`).join('\n');
        window.alert(
          `⚠ 投放已上线 ${launchedPayload.activate_succeeded} 个实体,但有 ${launchedPayload.activate_failed} 个未激活:\n${lines}\n\n已上线的实体正在 Meta 上消耗预算。可以点「暂停」止血,或去 Meta 后台手动 fix。`
        );
      } else if (skippedAds.length > 0) {
        const lines = skippedAds.map(s => `· ${s.ad}: ${s.error}`).join('\n');
        window.alert(`投放已上线，但有 ${skippedAds.length} 条广告未创建：\n${lines}`);
      }
    } catch (err) {
      window.alert(`启动失败：${err.message}`);
    } finally {
      setLaunchProgress(null);
      await refreshSelected();
    }
  }

  function handleLaunchEvent(event, data) {
    switch (event) {
      case 'status':
        setLaunchProgress({ phase: data.status, detail: data.status === 'staging' ? '正在 Meta 创建 campaign…' : '' });
        break;
      case 'stage_progress':
        setLaunchProgress({ phase: 'staging', detail: stageDetailLabel(data) });
        break;
      case 'staged':
        setLaunchProgress({ phase: 'staged', detail: `✓ 已创建 ${data.campaign_ids.length} 个 campaign，准备激活…` });
        break;
      case 'activate_progress':
        setLaunchProgress({ phase: 'activating', detail: `激活 campaign ${data.id.slice(-6)}…` });
        break;
      case 'launched':
        setLaunchProgress({ phase: 'launched', detail: `✓ 投放已上线（${data.campaign_ids.length} 个 campaign）` });
        break;
      case 'error':
        setLaunchProgress({ phase: 'failed', detail: `✗ ${data.phase} 失败: ${data.message}` });
        break;
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const scrollRef = useRef(null);
  // Sticky-bottom: auto-scroll only while the user is "near the bottom"
  // (within 96px ≈ 3 lines). If they scrolled up to re-read history, leave
  // them alone — incoming SSE deltas no longer yank the viewport down.
  // handleSend re-engages auto-follow when the user sends the next turn.
  const stuckToBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      stuckToBottomRef.current = dist < 96;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (!stuckToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, toolStatus, plan]);

  // ── Modal header status — same helper the grid card + AdPlanCard use.
  // hasPlan must come from `plan` (the live state) NOT `session.plan_json`,
  // because the user may have just generated a plan in this turn and the
  // session row prop is still stale — `plan` updates immediately via
  // refreshSelected. Without this, the header would lag the plan card.
  const headerStatus = deriveSessionStatus({
    sessionStatus: session?.status,
    planStatus: plan?.status,
    hasPlan: !!plan,
    adStatuses,
    launchProgress,
    streaming: !!streamingPlan,
  });
  const headerTitle = plan?.summary || session?.plan_json?.summary || session?.title || '(新项目)';

  // ── Render ─────────────────────────────────────────────────
  return (
    <div className={s.workspaceFull}>
      <div className={s.modalHeader}>
        <div className={s.modalHeaderLeft}>
          <span className={`${s.modalStatusDot} ${s[`statusDot_${headerStatus.tone}`]}`} aria-hidden="true" />
          <div className={s.modalHeaderText}>
            <div className={s.modalTitle} title={headerTitle}>{headerTitle}</div>
            <div className={s.modalSubLine}>
              <span className={s.modalStatusLabel}>{headerStatus.label}</span>
              {productLineName && (
                <>
                  <span className={s.modalDotSep} aria-hidden="true">·</span>
                  <span className={s.modalPlChip}>{productLineName}</span>
                </>
              )}
            </div>
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            className={s.modalCloseBtn}
            onClick={onClose}
            aria-label="关闭"
            title="关闭 (Esc)"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="6" y1="18" x2="18" y2="6" />
            </svg>
          </button>
        )}
      </div>
      <div className={s.workspaceGrid}>
      {/* 创意素材中心 —— 最左列。跨 session 的 AI 生成图 + 当前产品线 KB 图,
          一键导入到下方 composer 的 pendingAttachments。 */}
      <CreativesPanel
        productLine={session?.product_line}
        onImport={addAttachmentFromUrl}
      />
      <main className={s.main}>
        <div className={s.chatScroll} ref={scrollRef}>
          <div className={s.chatInner}>
            {loadingMessages ? (
              <SkeletonStack className={s.chatSkeleton}>
                <Skeleton variant="card" height={64} width="68%" />
                <Skeleton variant="card" height={92} width="80%" style={{ alignSelf: 'flex-end' }} />
                <Skeleton variant="card" height={48} width="55%" />
              </SkeletonStack>
            ) : messages.length === 0 && !streamingText ? (
              <EmptyConversation onPick={setInputVal} />
            ) : (
              <>
                {messages.map(m => (
                  <MessageRow key={m.id} msg={m} />
                ))}

                {toolStatus && (
                  <div className={s.toolStrip}>
                    <span className={s.spinner} />
                    <span>{toolStatus.label}</span>
                  </div>
                )}

                {streamingText && (
                  <div className={s.aiMsg}>
                    <OgilvyMarkdown>{streamingText}</OgilvyMarkdown>
                  </div>
                )}

                {isStreaming && !streamingText && !toolStatus && (
                  <div className={s.toolStrip}>
                    <span className={s.spinner} />
                    <span>思考中…</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className={s.composer}>
          <div className={s.composerInner}>
            {pendingAttachments.length > 0 && (
              <div className={s.attachRow}>
                {pendingAttachments.map(p => (
                  p.kind === 'doc' ? (
                    <DocAttachChip
                      key={p.id}
                      pending={p}
                      onRemove={() => removePendingAttachment(p.id)}
                    />
                  ) : (
                    <div key={p.id} className={s.attachTile}>
                      <img src={p.preview} alt="" />
                      {p.uploading && <div className={s.attachOverlay}><span className={s.spinner} /></div>}
                      <button
                        className={s.attachRemove}
                        onClick={() => removePendingAttachment(p.id)}
                        aria-label="移除"
                        title="移除"
                      >×</button>
                    </div>
                  )
                ))}
              </div>
            )}
            <div className={s.composerBox}>
              <input
                ref={fileInputRef}
                type="file"
                /* Image + doc whitelist. Browser may send blank MIME for .md
                 * / .docx — the backend has an extension fallback. */
                accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,text/markdown,.md,.markdown,text/plain,.txt,text/csv,.csv"
                multiple
                style={{ display: 'none' }}
                onChange={(e) => { handleFilesSelected(e.target.files); e.target.value = ''; }}
              />
              <button
                type="button"
                className={s.composerIconBtn}
                onClick={() => fileInputRef.current?.click()}
                disabled={isStreaming}
                title="上传图片或文档(JPG/PNG/GIF/WebP/PDF/Word/Markdown/TXT/CSV · 最大 50MB)"
                aria-label="上传图片或文档"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <textarea
                className={s.composerTextarea}
                placeholder={isStreaming ? '正在生成…' : '告诉我你要推广的产品，或粘贴产品链接…'}
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={isStreaming}
                rows={1}
              />
              {isStreaming ? (
                <button
                  className={s.composerBtn}
                  onClick={handleStop}
                  title="停止生成"
                  aria-label="停止生成"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <rect x="2" y="2" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  className={s.composerBtn}
                  onClick={handleSend}
                  disabled={
                    (!inputVal.trim() && !pendingAttachments.some(p => p.uploaded))
                    || pendingAttachments.some(p => p.uploading)
                  }
                  title="发送"
                  aria-label="发送"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              )}
            </div>
            <div className={s.composerFoot}>
              <div className={s.composerFootStack}>
                <span className={s.composerFootText}>
                  <span className={s.composerFootDot} aria-hidden="true" />
                  Click-to-WhatsApp 投放 · 优化最大化 WhatsApp 对话数
                </span>
                <span className={s.composerFootHint}>
                  上传图片 / PDF / Word / Markdown / TXT / CSV · 最大 50MB
                </span>
              </div>
              {sessionId && (
                <UsageBadge sessionId={sessionId} refreshKey={usageRefreshKey} inline />
              )}
            </div>
          </div>
        </div>
      </main>

      <aside className={s.planPanel}>
        <StageArchive archives={archives} />
        {(streamingPlan || plan) ? (
          <AdPlanCard
            plan={streamingPlan || plan}
            onLaunch={handleLaunch}
            onPause={handlePause}
            onResume={handleResume}
            onRefreshStatus={handleRefreshStatus}
            adStatuses={adStatuses}
            refreshingStatus={refreshingStatus}
            launchProgress={launchProgress}
            controlBusy={controlBusy}
            streaming={!!streamingPlan}
          />
        ) : (
          <PlanBlueprint />
        )}
      </aside>
      </div>
    </div>
  );
}

function PlanBlueprint() {
  return (
    <div className={s.blueprint} aria-hidden="true">
      <div className={s.blueprintBadge}>广告方案</div>
      <article className={s.blueprintCard}>
        <header className={s.blueprintHead}>
          <span className={s.blueprintKind}>📱 Click-to-WhatsApp</span>
          <div className={s.blueprintTitleBar} />
        </header>
        <section className={s.blueprintSection}>
          <div className={s.blueprintStatRow}>
            <div className={s.blueprintStat}>
              <span className={s.blueprintStatLabel}>日预算</span>
              <span className={s.blueprintStatVal} />
            </div>
            <div className={s.blueprintStat}>
              <span className={s.blueprintStatLabel}>预估对话</span>
              <span className={s.blueprintStatVal} />
            </div>
          </div>
        </section>
        <section className={s.blueprintSection}>
          <span className={s.blueprintSectionLabel}>询盘落地</span>
          <div className={s.blueprintWa}>
            <span className={s.blueprintWaIcon}>💬</span>
            <span className={s.blueprintWaLine} />
          </div>
        </section>
        <section className={s.blueprintSection}>
          <span className={s.blueprintSectionLabel}>广告组 · 创意</span>
          <div className={s.blueprintAds}>
            <span className={s.blueprintThumb} />
            <span className={s.blueprintThumb} />
            <span className={s.blueprintThumb} />
          </div>
        </section>
        <footer className={s.blueprintFoot}>
          <span className={s.blueprintStatusDot} />
          <span className={s.blueprintStatusLine} />
          <span className={s.blueprintCta}>✦ 启动投放</span>
        </footer>
      </article>
      <div className={s.blueprintHint}>
        聊天里给出产品、市场和预算，AI 会在这里生成完整方案
      </div>
    </div>
  );
}

function stageDetailLabel(evt) {
  switch (evt.type) {
    case 'campaign_created': return `✓ campaign: ${evt.name}`;
    case 'adset_created':    return `✓ adset: ${evt.name}`;
    case 'image_uploaded':   return `→ 上传素材: ${evt.ad}`;
    case 'creative_created': return `✓ creative: ${evt.ad}`;
    case 'ad_created':       return `✓ ad: ${evt.ad}`;
    case 'error':            return `✗ ${evt.ad || ''} ${evt.error}`;
    default:                 return '';
  }
}

function EmptyConversation({ onPick }) {
  const chipGroups = [
    {
      label: '产品推广',
      items: [
        '帮我推广一款 300W 家用太阳能板到泰国和印尼',
        '为我的 4x4 越野车配件（柬埔寨市场）做投放',
      ],
    },
    {
      label: '行业 / 市场',
      items: [
        '我是做外贸的 LED 灯具，想投非洲',
        '工程机械配件，目标中东 B2B 客户',
      ],
    },
  ];

  const steps = [
    { n: '01', label: '对话', hint: '告诉我产品、市场、预算' },
    { n: '02', label: '方案', hint: 'AI 草拟广告组与素材' },
    { n: '03', label: '上线', hint: '一键投放到 Meta' },
  ];

  return (
    <div className={s.empty}>
      <div className={s.emptyHero} aria-hidden="true">
        <span className={s.emptyOrb} />
        <span className={s.emptyOrbHalo} />
      </div>
      <span className={s.emptyKicker}>AUTOPILOT</span>
      <h1 className={s.emptyTitle}>今天推广哪款产品？</h1>
      <p className={s.emptySubtitle}>
        描述产品、目标市场或预算，AI 会生成完整的 Click-to-WhatsApp 投放方案。
      </p>

      <div className={s.emptyChipGroups}>
        {chipGroups.map(group => (
          <div key={group.label} className={s.emptyChipCol}>
            <div className={s.emptyChipColLabel}>{group.label}</div>
            <div className={s.emptyChipColItems}>
              {group.items.map(c => (
                <button key={c} className={s.emptyChip} onClick={() => onPick(c)}>
                  <span className={s.emptyChipText}>{c}</span>
                  <span className={s.emptyChipArrow} aria-hidden="true">→</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className={s.emptySteps} aria-hidden="true">
        {steps.map((st, i) => (
          <div key={st.n} className={s.emptyStep}>
            <span className={s.emptyStepNum}>{st.n}</span>
            <div className={s.emptyStepBody}>
              <div className={s.emptyStepLabel}>{st.label}</div>
              <div className={s.emptyStepHint}>{st.hint}</div>
            </div>
            {i < steps.length - 1 && <span className={s.emptyStepArrow}>→</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Pending-attachment chip for doc uploads in the composer. Shows
 * 📄 + filename + char count (or "解析中…" while uploading). Same hover-
 * remove × as image tiles.
 */
function DocAttachChip({ pending, onRemove }) {
  const { uploading, uploaded, filename } = pending;
  const name = uploaded?.filename || filename || '未命名';
  const chars = uploaded?.char_count;
  return (
    <div className={s.docAttachChip}>
      <span className={s.docAttachIcon} aria-hidden="true">📄</span>
      <div className={s.docAttachMeta}>
        <div className={s.docAttachName} title={name}>{name}</div>
        <div className={s.docAttachStatus}>
          {uploading
            ? '解析中…'
            : (typeof chars === 'number'
                ? `${chars.toLocaleString()} 字`
                : '已解析')}
        </div>
      </div>
      <button
        type="button"
        className={s.docAttachRemove}
        onClick={onRemove}
        aria-label="移除"
        title="移除"
      >×</button>
    </div>
  );
}

function MessageRow({ msg }) {
  if (msg.role === 'user') {
    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    const images = atts.filter(a => (a?.kind ?? 'image') === 'image' && a?.url);
    const docs   = atts.filter(a => a?.kind === 'doc');
    return (
      <div className={s.userMsg}>
        {images.length > 0 && (
          <div className={s.userAttach}>
            {images.map((att, i) => (
              <img
                key={i}
                src={att.url}
                alt=""
                className={s.userAttachImg}
                style={{ width: 120, height: 120, objectFit: 'cover', borderRadius: 8 }}
              />
            ))}
          </div>
        )}
        {docs.length > 0 && (
          <div className={s.userDocs}>
            {docs.map((d, i) => (
              <div key={i} className={s.userDocChip} title={`${d.filename || '附件'} · ${d.char_count ?? (d.text?.length ?? 0)} 字`}>
                <span className={s.userDocIcon} aria-hidden="true">📄</span>
                <span className={s.userDocName}>{d.filename || '附件'}</span>
                <span className={s.userDocChars}>· {(d.char_count ?? (d.text?.length ?? 0)).toLocaleString()} 字</span>
              </div>
            ))}
          </div>
        )}
        {msg.content}
      </div>
    );
  }
  if (msg.role === 'assistant' && msg.content && !msg.tool_use_id) {
    return (
      <div className={s.aiMsg}>
        <OgilvyMarkdown>{msg.content}</OgilvyMarkdown>
      </div>
    );
  }
  if (msg.role === 'tool' && msg.tool_name === 'generate_ad_creative' && msg.tool_result?.url) {
    const tr = msg.tool_result;
    const caption = tr.headline || tr.product_name || '广告素材';
    return (
      <div className={s.creativeTile}>
        <img src={tr.url} alt={caption} loading="lazy" />
        <div className={s.creativeTileCaption}>{caption}</div>
      </div>
    );
  }
  return null;
}
