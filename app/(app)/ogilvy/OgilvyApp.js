'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import s from './ogilvy.module.css';
import Markdown from '../../components/Markdown/Markdown';
import WhatsAppGateCard from './components/WhatsAppGateCard';
import AdPlanCard from './components/AdPlanCard';
import Skeleton, { SkeletonStack } from '../../components/Skeleton/Skeleton';
import { useMessageStream } from './hooks/useMessageStream';

// ── Module-level session cache ────────────────────────────────────────────
// Survives unmount/remount (e.g. user navigates away and back to /ogilvy)
// so the sidebar list renders instantly from the last-known state instead of
// showing the loading skeleton + waiting on a DB round-trip every time.
// Cache is per-tab, in-memory only (no localStorage) — fine for this UX since
// any actually new sessions will be picked up by the silent background refresh.
const SESSIONS_CACHE_FRESH_MS = 30_000; // skip background refresh within this window
let __sessionsCache = null; // { sessions, gate, ts } | null
function readSessionsCache() {
  return __sessionsCache;
}
function writeSessionsCache(patch) {
  __sessionsCache = { ...(__sessionsCache || { sessions: [], gate: null }), ...patch, ts: Date.now() };
}
function isSessionsCacheFresh() {
  return __sessionsCache && (Date.now() - __sessionsCache.ts) < SESSIONS_CACHE_FRESH_MS;
}

/**
 * OgilvyApp — the whole /ogilvy page.
 *
 * Layout: [left sidebar of conversations] [main chat stream + composer]
 *
 * Data flow:
 *   - On mount: fetch WhatsApp gate + conversation list in parallel.
 *   - Gate not ok  → render only WhatsAppGateCard (chat inaccessible).
 *   - Gate ok      → show chat; selecting a conversation fetches its messages.
 *   - Sending      → POST /messages, stream back via useMessageStream hook.
 *
 * Message ordering in the view comes directly from DB (message_index).
 * Streaming delta + tool strips appear after the last persisted message.
 */
export default function OgilvyApp() {
  const searchParams = useSearchParams();

  // ── Data state ───────────────────────────────────────────────
  // Hydrate from the module cache so a remount doesn't blank out the sidebar
  // and then wait on the network — common when the user clicks away and back.
  const cachedOnMount = readSessionsCache();
  const [gate, setGate] = useState(cachedOnMount?.gate ?? null);
  const [sessions, setSessions] = useState(cachedOnMount?.sessions ?? []);
  const [loadingSessions, setLoadingSessions] = useState(!cachedOnMount);
  const [selectedId, setSelectedId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [plan, setPlan] = useState(null);               // latest plan_json for active session
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [creating, setCreating] = useState(false);
  const [inputVal, setInputVal] = useState('');
  // Pending uploads: [{id, file, preview, uploading, uploaded: {url, ...} | null}]
  // Cleared after handleSend, so attachments only travel with the next message.
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const fileInputRef = useRef(null);

  // ── Selecting a session updates the URL so refresh/back survives ──
  const selectSession = useCallback((id) => {
    setSelectedId(id);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('c', id);
    else url.searchParams.delete('c');
    window.history.replaceState(null, '', url.toString());
  }, []);

  // ── Initial load: WA gate + sessions ────────────────────────
  // Strategy:
  //   - Cold (no cache)        → fetch with loading spinner.
  //   - Warm but stale         → render cache instantly; silently refresh.
  //   - Warm and fresh (<30s)  → render cache instantly; skip network entirely.
  // After the initial hydration we always restore the URL-selected session.
  useEffect(() => {
    const urlConv = searchParams.get('c');
    const cached = readSessionsCache();

    // Restore URL selection from whatever data we already have on hand.
    if (cached) {
      const initialFromCache = urlConv && cached.sessions.find(x => x.id === urlConv)
        ? urlConv
        : cached.sessions[0]?.id || null;
      if (initialFromCache) selectSession(initialFromCache);
      // Skip network entirely if cache is still fresh.
      if (isSessionsCacheFresh()) return;
    }

    let cancelled = false;
    (async () => {
      try {
        const [gateRes, sessRes] = await Promise.all([
          fetch('/api/ogilvy/whatsapp-accounts').then(r => r.json()),
          fetch('/api/ogilvy/conversations').then(r => r.json()),
        ]);
        if (cancelled) return;
        setGate(gateRes);
        const list = sessRes.data || [];
        setSessions(list);
        writeSessionsCache({ sessions: list, gate: gateRes });
        if (!cached) {
          // Only drive selection on cold load — warm path already did it above.
          const initial = urlConv && list.find(x => x.id === urlConv) ? urlConv : list[0]?.id || null;
          if (initial) selectSession(initial);
        }
      } catch (err) {
        if (cancelled) return;
        console.error('[OgilvyApp] initial load failed:', err);
        if (!cached) setGate({ status: 'token_error', error: err.message });
      } finally {
        if (!cancelled) setLoadingSessions(false);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const recheckGate = useCallback(async () => {
    setGate(null);
    // ?force=1 bypasses the server-side 60s cache so the user gets fresh data
    // immediately after binding a new number on Meta.
    const r = await fetch('/api/ogilvy/whatsapp-accounts?force=1').then(r => r.json());
    setGate(r);
    writeSessionsCache({ gate: r });
  }, []);

  // ── Load messages when a session is selected ─────────────────
  useEffect(() => {
    if (!selectedId) { setMessages([]); setPlan(null); return; }
    let cancel = false;
    (async () => {
      setLoadingMessages(true);
      try {
        const r = await fetch(`/api/ogilvy/conversations/${selectedId}`).then(r => r.json());
        if (cancel) return;
        setMessages(r.messages || []);
        setPlan(r.session?.plan_json || null);
      } catch (err) {
        if (!cancel) console.error('[OgilvyApp] load messages failed:', err);
      } finally {
        if (!cancel) setLoadingMessages(false);
      }
    })();
    return () => { cancel = true; };
  }, [selectedId]);

  // Partial plan while the Agent is streaming draft_ad_plan args. Cleared on
  // stream start / finish — the confirmed plan comes from session.plan_json.
  const [streamingPlan, setStreamingPlan] = useState(null);

  // ── SSE streaming hook ───────────────────────────────────────
  const { send, stop, streamingText, toolStatus, isStreaming } = useMessageStream({
    onUserSaved: () => { /* persisted server-side — refetch next turn */ },
    onPlanPartial: (partial) => setStreamingPlan(partial),
    onToolResult: async (data) => {
      // When draft_ad_plan finishes, refetch the session to pull the updated
      // plan_json and drop the partial stream.
      if (data.tool === 'draft_ad_plan' && data.result?.ok) {
        setStreamingPlan(null);
        const r = await fetch(`/api/ogilvy/conversations/${selectedId}`).then(r => r.json());
        setPlan(r.session?.plan_json || null);
      }
    },
    onAssistantFinal: () => { /* rely on the post-stream refetch to merge */ },
    onError: (err) => {
      setStreamingPlan(null);
      setMessages(prev => [...prev, {
        id: `err-${Date.now()}`, role: 'assistant', content: `发生错误：${err.message}`, __error: true,
      }]);
    },
  });

  const refreshSelected = useCallback(async () => {
    if (!selectedId) return;
    const r = await fetch(`/api/ogilvy/conversations/${selectedId}`).then(r => r.json());
    setMessages(r.messages || []);
    setPlan(r.session?.plan_json || null);
  }, [selectedId]);

  // ── Actions ─────────────────────────────────────────────────
  // Create a new conversation. Returns the created row id (or null on failure).
  // Kept as a pure helper so both the "新项目" button and the first-message
  // auto-create path in handleSend can share the same error handling.
  const createConversation = useCallback(async () => {
    const r = await fetch('/api/ogilvy/conversations', { method: 'POST' });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `创建对话失败（HTTP ${r.status}）`);
    }
    const row = await r.json();
    if (!row?.id) throw new Error('创建对话返回空数据');
    setSessions(prev => {
      const next = [{ ...row, plan_json: null, meta_campaign_ids: [] }, ...prev];
      writeSessionsCache({ sessions: next });
      return next;
    });
    return row.id;
  }, []);

  async function handleNewConversation() {
    setCreating(true);
    try {
      const id = await createConversation();
      selectSession(id);
    } catch (err) {
      window.alert(err.message);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(sessionId, e) {
    e.stopPropagation();
    if (!window.confirm('确认删除这个对话？')) return;
    await fetch(`/api/ogilvy/conversations/${sessionId}`, { method: 'DELETE' });
    setSessions(prev => {
      const next = prev.filter(x => x.id !== sessionId);
      writeSessionsCache({ sessions: next });
      return next;
    });
    if (selectedId === sessionId) {
      const next = sessions.find(x => x.id !== sessionId);
      selectSession(next?.id || null);
    }
  }

  // ── Upload handling ─────────────────────────────────────────
  // Each file gets a temporary row in pendingAttachments while uploading, then
  // transitions to `uploaded` with the server URL. We only send messages once
  // all attachments finished uploading (or the user cleared them).
  async function uploadOne(file, sessionIdForPath) {
    const tempId = `up-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const preview = URL.createObjectURL(file);
    setPendingAttachments(prev => [...prev, { id: tempId, file, preview, uploading: true, uploaded: null }]);

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
      setPendingAttachments(prev => prev.map(p => p.id === tempId ? { ...p, uploading: false, uploaded } : p));
    } catch (err) {
      window.alert(err.message);
      setPendingAttachments(prev => prev.filter(p => p.id !== tempId));
      URL.revokeObjectURL(preview);
    }
  }

  async function handleFilesSelected(fileList) {
    const files = Array.from(fileList || []).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    // Upload sequentially so the session_id is stable across calls when we
    // auto-create a new conversation on the fly.
    for (const f of files) {
      await uploadOne(f, selectedId);
    }
  }

  function removePendingAttachment(id) {
    setPendingAttachments(prev => {
      const target = prev.find(p => p.id === id);
      if (target?.preview) URL.revokeObjectURL(target.preview);
      return prev.filter(p => p.id !== id);
    });
  }

  async function handleSend() {
    const text = inputVal.trim();
    const readyAttachments = pendingAttachments.filter(p => p.uploaded);
    const stillUploading = pendingAttachments.some(p => p.uploading);
    if (stillUploading) return;  // wait for uploads to finish
    if ((!text && !readyAttachments.length) || isStreaming) return;

    // No session yet → create one before sending. Abort early on failure so
    // we never call /messages with an undefined id (the old code did).
    let targetId = selectedId;
    if (!targetId) {
      try {
        targetId = await createConversation();
        selectSession(targetId);
      } catch (err) {
        window.alert(err.message);
        return;
      }
    }

    // Optimistic append of the user bubble. If send() throws we refetch below
    // which will replace this temp row with the persisted one.
    const tempId = `u-${Date.now()}`;
    const attachmentsPayload = readyAttachments.map(p => p.uploaded);
    setMessages(prev => [...prev, {
      id: tempId,
      role: 'user',
      content: text,
      attachments: attachmentsPayload,
    }]);
    setInputVal('');
    // Revoke object URLs and clear state — attachments are gone from composer.
    readyAttachments.forEach(p => p.preview && URL.revokeObjectURL(p.preview));
    setPendingAttachments([]);

    await send(targetId, text, attachmentsPayload);
    await refreshSelected();
  }

  // Stop the currently-streaming response. Aborting the fetch propagates to
  // the server's ReadableStream, which calls generator.return() and breaks
  // the Agent loop. We then refetch so the UI reflects whatever landed in DB.
  async function handleStop() {
    stop();
    if (selectedId) await refreshSelected();
  }

  // ── Export current conversation to a markdown file ─────────
  // Pure client-side: serialize whatever is on screen (messages + plan) into
  // markdown and trigger a browser download. No network round-trip.
  function handleExportConversation() {
    if (!selectedId || messages.length === 0) return;
    const sess = sessions.find(x => x.id === selectedId);
    const md = buildConversationMarkdown({ session: sess, messages, plan });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeTitle = (sess?.plan_json?.summary || sess?.title || 'ogilvy')
      .replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'ogilvy';
    downloadTextFile(`${safeTitle}_${ts}.md`, md, 'text/markdown;charset=utf-8');
  }

  // ── Launch flow ────────────────────────────────────────────
  // Streams progress from /launch into `launchProgress`, then refetches the
  // session so the card reflects the final plan_json (status, meta_ids).
  const [launchProgress, setLaunchProgress] = useState(null);
  async function handleLaunch() {
    if (!selectedId || !plan) return;
    setLaunchProgress({ phase: 'starting', detail: '连接 Meta…' });
    // Collect ad-level stage failures (single-ad skips during stage_progress).
    // Stage as a whole keeps running when one image upload fails, so users
    // would otherwise see a green ✓ launch with silently-fewer ads on Meta.
    const skippedAds = [];
    try {
      const res = await fetch(`/api/ogilvy/conversations/${selectedId}/launch`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      // Parse SSE manually (mirrors lib/consume-sse.js pattern)
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let eventType = null;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (line.startsWith('event: ')) eventType = line.slice(7);
          else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'stage_progress' && data?.type === 'error' && data?.ad) {
                skippedAds.push({ ad: data.ad, error: data.error });
              }
              handleLaunchEvent(eventType, data);
            } catch {}
            eventType = null;
          }
        }
      }
      if (skippedAds.length > 0) {
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
        setLaunchProgress({
          phase: 'staging',
          detail: stageDetailLabel(data),
        });
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

  // Auto-scroll chat to bottom on new content
  const scrollRef = useRef(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, toolStatus, plan]);

  // ── Render ─────────────────────────────────────────────────
  // The plan has its own right-side column; we no longer anchor it inside
  // the chat transcript.
  const gateBlocked = gate && gate.status !== 'ok';

  return (
    <div className={s.root}>
      {/* ─── Sidebar ─── */}
      <aside className={s.sidebar}>
        <div className={s.sidebarHead}>
          <span className={s.sidebarHeadLabel}>项目</span>
          {sessions.length > 0 && (
            <span className={s.sidebarHeadCount}>{sessions.length}</span>
          )}
        </div>
        <button className={s.newBtn} onClick={handleNewConversation} disabled={creating || gateBlocked}>
          <svg className={s.newBtnIcon} width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span>新项目</span>
        </button>
        <div className={s.sessionList}>
          {loadingSessions ? (
            <SessionSkeletonList />
          ) : sessions.length === 0 ? (
            <div className={s.sidebarEmpty}>
              <div className={s.sidebarEmptyMark} aria-hidden="true">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path d="M4 6h16M4 12h10M4 18h7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </div>
              <div className={s.sidebarEmptyTitle}>还没有项目</div>
              <div className={s.sidebarEmptyHint}>从右侧开始第一段对话</div>
            </div>
          ) : (
            sessions.map(sess => (
              <SessionCard
                key={sess.id}
                session={sess}
                active={selectedId === sess.id}
                onSelect={() => selectSession(sess.id)}
                onDelete={(e) => handleDelete(sess.id, e)}
              />
            ))
          )}
        </div>
      </aside>

      {/* ─── Main area ─── */}
      <main className={s.main}>
        {gateBlocked ? (
          <WhatsAppGateCard gate={gate} onRecheck={recheckGate} />
        ) : (
          <>
            {selectedId && messages.length > 0 && (
              <button
                type="button"
                className={s.exportBtn}
                onClick={handleExportConversation}
                title="导出对话为 Markdown 文件"
                aria-label="导出对话"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>导出</span>
              </button>
            )}
            <div className={s.chatScroll} ref={scrollRef}>
              <div className={s.chatInner}>
                {loadingMessages ? (
                  <SkeletonStack className={s.chatSkeleton}>
                    <Skeleton variant="card" height={64} width="68%" />
                    <Skeleton variant="card" height={92} width="80%" style={{ alignSelf: 'flex-end' }} />
                    <Skeleton variant="card" height={48} width="55%" />
                  </SkeletonStack>
                ) : messages.length === 0 && !streamingText ? (
                  <EmptyState onPick={setInputVal} />
                ) : (
                  <>
                    {messages.map((m, i) => (
                      <MessageRow key={m.id || i} msg={m} />
                    ))}

                    {toolStatus && (
                      <div className={s.toolStrip}>
                        <span className={s.spinner} />
                        <span>{toolStatus.label}</span>
                      </div>
                    )}

                    {streamingText && (
                      <div className={s.aiMsg}>
                        <Markdown>{streamingText}</Markdown>
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

            {/* Composer */}
            <div className={s.composer}>
              <div className={s.composerInner}>
                {pendingAttachments.length > 0 && (
                  <div className={s.attachRow}>
                    {pendingAttachments.map(p => (
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
                    ))}
                  </div>
                )}
                <div className={s.composerBox}>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => { handleFilesSelected(e.target.files); e.target.value = ''; }}
                  />
                  <button
                    type="button"
                    className={s.composerIconBtn}
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isStreaming}
                    title="上传产品图"
                    aria-label="上传产品图"
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
                  <span className={s.composerFootDot} aria-hidden="true" />
                  Click-to-WhatsApp 投放 · 优化最大化 WhatsApp 对话数
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      {/* ─── Right panel: ad plan card (always visible, empty state when no plan) ─── */}
      {/*
       * Priority: streamingPlan (in-flight partial during draft_ad_plan
       * streaming) > plan (confirmed/persisted). We show the partial as
       * soon as we have anything structurally parseable so the user sees
       * fields populate live instead of staring at a spinner.
       */}
      {!gateBlocked && (
        <aside className={s.planPanel}>
          {(streamingPlan || plan) ? (
            <AdPlanCard
              plan={streamingPlan || plan}
              onLaunch={handleLaunch}
              launchProgress={launchProgress}
              streaming={!!streamingPlan}
            />
          ) : (
            <PlanBlueprint />
          )}
        </aside>
      )}
    </div>
  );
}

/**
 * Empty-state for the right plan column. Sketches the *shape* of the upcoming
 * plan card with faint placeholders (kicker → title → stats → ads → CTA), so
 * the user reads the panel as "waiting to be filled" rather than "broken".
 *
 * Pure presentation — no props, no interaction.
 */
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

// ── Helpers ────────────────────────────────────────────────────

/**
 * Compact card for the left sidebar. Extracts the most identity-carrying
 * facts from a session (preferring the AI's plan summary over the user's
 * raw first message) and renders them in 2 lines.
 *
 * Row 1: status dot + best-available title
 * Row 2: target countries · daily budget · relative time
 *
 * The delete × button is hidden until hover so the card stays clean.
 */
function SessionCard({ session, active, onSelect, onDelete }) {
  const plan = session.plan_json;
  const campaign = plan?.campaigns?.[0];

  // Title priority: AI summary > campaign name > fallback first-message title
  // (often meaningless like "你好"). Truncate aggressively for 1-line display.
  const title = plan?.summary || campaign?.name || session.title || '(新项目)';

  // Extract unique target countries across all ad_sets in this session's plan.
  const countries = campaign
    ? [...new Set((campaign.ad_sets || []).flatMap(as => as.targeting?.countries || []))]
    : [];

  // Daily budget (USD). Only surface when we have a plan — otherwise show nothing.
  const dailyUsd = campaign?.daily_budget_cents != null
    ? (campaign.daily_budget_cents / 100)
    : null;

  // Relative time, "刚刚" / "X 分钟前" / "X 小时前" / "X 天前" / "M/D".
  const when = formatRelativeTime(session.updated_at || session.created_at);

  // Status → dot color + label. 'active' (draft) → gray, launched → green, etc.
  const { dotClass, statusLabel } = describeSessionStatus(session.status);

  return (
    <div
      className={`${s.sessionCard} ${active ? s.sessionCardActive : ''}`}
      onClick={onSelect}
    >
      <div className={s.sessionCardTop}>
        <span className={`${s.sessionDot} ${dotClass}`} title={statusLabel} aria-label={statusLabel} />
        <span className={s.sessionCardTitle} title={title}>{title}</span>
        <button
          className={s.sessionCardDel}
          onClick={(e) => { e.stopPropagation(); onDelete?.(e); }}
          title="删除"
          aria-label="删除"
        >×</button>
      </div>
      {(countries.length > 0 || dailyUsd != null || when) && (
        <div className={s.sessionCardMeta}>
          {countries.length > 0 && (
            <span className={s.sessionCardCountries} title={countries.join(', ')}>
              {countries.slice(0, 3).join(' · ')}
              {countries.length > 3 ? ` +${countries.length - 3}` : ''}
            </span>
          )}
          {dailyUsd != null && (
            <span className={s.sessionCardBudget}>${dailyUsd.toFixed(0)}/天</span>
          )}
          {when && <span className={s.sessionCardTime}>{when}</span>}
        </div>
      )}
    </div>
  );
}

function describeSessionStatus(status) {
  switch (status) {
    case 'launched':  return { dotClass: s.sessionDotLaunched, statusLabel: '投放中' };
    case 'staging':
    case 'staged':    return { dotClass: s.sessionDotBusy,     statusLabel: '启动中' };
    case 'failed':    return { dotClass: s.sessionDotFailed,   statusLabel: '启动失败' };
    case 'archived':  return { dotClass: s.sessionDotArchived, statusLabel: '已归档' };
    default:          return { dotClass: s.sessionDotDraft,    statusLabel: '草稿' };
  }
}

/**
 * Relative time with Chinese units. Falls back to M/D for anything over a week.
 * Designed to be scannable in a narrow sidebar — at most 5 characters.
 */
function formatRelativeTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  if (diff < 60_000)            return '刚刚';
  if (diff < 3_600_000)         return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000)        return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000)    return `${Math.floor(diff / 86_400_000)} 天前`;
  const d = new Date(then);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * Serialize a conversation (session + messages + plan) to a self-contained
 * markdown document. Each message becomes a fenced section keyed by role; tool
 * calls render as collapsible JSON blocks; the latest plan_json is appended
 * verbatim so the export captures both transcript and outcome.
 */
function buildConversationMarkdown({ session, messages, plan }) {
  const lines = [];
  const title = plan?.summary || session?.plan_json?.summary || session?.title || '(无标题)';
  lines.push(`# Ogilvy 对话 · ${title}`);
  lines.push('');
  if (session?.id) lines.push(`- 会话 ID: \`${session.id}\``);
  if (session?.status) lines.push(`- 状态: ${session.status}`);
  if (session?.created_at) lines.push(`- 创建: ${session.created_at}`);
  if (session?.updated_at) lines.push(`- 更新: ${session.updated_at}`);
  lines.push(`- 导出时间: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## 对话');
  lines.push('');

  for (const m of messages) {
    if (m.role === 'user') {
      lines.push('### 👤 用户');
      lines.push('');
      if (m.content) { lines.push(m.content); lines.push(''); }
      if (Array.isArray(m.attachments) && m.attachments.length) {
        lines.push('附件:');
        for (const att of m.attachments) {
          if (att?.url) lines.push(`- ${att.url}`);
        }
        lines.push('');
      }
    } else if (m.role === 'assistant') {
      if (!m.content) continue; // tool-use frames have no prose
      lines.push('### 🤖 助手');
      lines.push('');
      lines.push(m.content);
      lines.push('');
    } else if (m.role === 'tool') {
      const name = m.tool_name || '(unknown)';
      lines.push(`### 🛠 工具 · ${name}`);
      lines.push('');
      if (m.tool_result !== undefined) {
        lines.push('```json');
        try { lines.push(JSON.stringify(m.tool_result, null, 2)); }
        catch { lines.push(String(m.tool_result)); }
        lines.push('```');
        lines.push('');
      }
    }
  }

  if (plan) {
    lines.push('---');
    lines.push('');
    lines.push('## 最终方案 (plan_json)');
    lines.push('');
    lines.push('```json');
    try { lines.push(JSON.stringify(plan, null, 2)); }
    catch { lines.push(String(plan)); }
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

/** Trigger a browser download of a string as a file. */
function downloadTextFile(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
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

function EmptyState({ onPick }) {
  // Prompt seeds split by intent so users see the breadth of what they can ask
  // for, not just three lookalike "I sell X to Y" templates.
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
 * Skeleton placeholder for the session sidebar during cold load. Mirrors the
 * shape of real SessionCard rows (dot + title line + meta line) so the layout
 * doesn't visibly shift when data lands.
 */
function SessionSkeletonList() {
  return (
    <div className={s.sessionSkeletonList} aria-hidden="true">
      {[68, 82, 60, 74].map((w, i) => (
        <div key={i} className={s.sessionSkeleton}>
          <div className={s.sessionSkeletonTop}>
            <span className={s.sessionSkeletonDot} />
            <span className={s.sessionSkeletonTitle} style={{ width: `${w}%` }} />
          </div>
          <span className={s.sessionSkeletonMeta} style={{ width: `${w - 18}%` }} />
        </div>
      ))}
    </div>
  );
}

function MessageRow({ msg }) {
  if (msg.role === 'user') {
    return (
      <div className={s.userMsg}>
        {msg.attachments?.length > 0 && (
          <div className={s.userAttach}>
            {msg.attachments.map((att, i) => (
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
        {msg.content}
      </div>
    );
  }
  if (msg.role === 'assistant' && msg.content && !msg.tool_use_id) {
    return (
      <div className={s.aiMsg}>
        <Markdown>{msg.content}</Markdown>
      </div>
    );
  }
  // generate_ad_creative tool results carry the asset URL — surface it in the
  // transcript so the user sees each generated image alongside the prose
  // listing creatives. Other tools (draft_ad_plan / web_search / read_*)
  // stay invisible; their output lives in the right-panel plan card or the
  // assistant's prose summary.
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
  // Other tool rows (draft_ad_plan, web_search, read_*) render nothing —
  // their output lives in the right-side plan card or the assistant's prose.
  return null;
}
