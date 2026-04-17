'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import s from './autopilot.module.css';
import Markdown from '../../components/Markdown/Markdown';
import WhatsAppGateCard from './components/WhatsAppGateCard';
import AdPlanCard from './components/AdPlanCard';
import { useMessageStream } from './hooks/useMessageStream';

// ── Module-level session cache ────────────────────────────────────────────
// Survives unmount/remount (e.g. user navigates away and back to /ai-automation)
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
 * AutopilotApp — the whole /ai-automation page.
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
export default function AutopilotApp() {
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
          fetch('/api/autopilot/whatsapp-accounts').then(r => r.json()),
          fetch('/api/autopilot/conversations').then(r => r.json()),
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
        console.error('[AutopilotApp] initial load failed:', err);
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
    const r = await fetch('/api/autopilot/whatsapp-accounts?force=1').then(r => r.json());
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
        const r = await fetch(`/api/autopilot/conversations/${selectedId}`).then(r => r.json());
        if (cancel) return;
        setMessages(r.messages || []);
        setPlan(r.session?.plan_json || null);
      } catch (err) {
        if (!cancel) console.error('[AutopilotApp] load messages failed:', err);
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
        const r = await fetch(`/api/autopilot/conversations/${selectedId}`).then(r => r.json());
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
    const r = await fetch(`/api/autopilot/conversations/${selectedId}`).then(r => r.json());
    setMessages(r.messages || []);
    setPlan(r.session?.plan_json || null);
  }, [selectedId]);

  // ── Actions ─────────────────────────────────────────────────
  // Create a new conversation. Returns the created row id (or null on failure).
  // Kept as a pure helper so both the "新项目" button and the first-message
  // auto-create path in handleSend can share the same error handling.
  const createConversation = useCallback(async () => {
    const r = await fetch('/api/autopilot/conversations', { method: 'POST' });
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
    await fetch(`/api/autopilot/conversations/${sessionId}`, { method: 'DELETE' });
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
      const res = await fetch('/api/autopilot/upload', { method: 'POST', body: fd });
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

  // ── Launch flow ────────────────────────────────────────────
  // Streams progress from /launch into `launchProgress`, then refetches the
  // session so the card reflects the final plan_json (status, meta_ids).
  const [launchProgress, setLaunchProgress] = useState(null);
  async function handleLaunch() {
    if (!selectedId || !plan) return;
    setLaunchProgress({ phase: 'starting', detail: '连接 Meta…' });
    try {
      const res = await fetch(`/api/autopilot/conversations/${selectedId}/launch`, { method: 'POST' });
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
              handleLaunchEvent(eventType, data);
            } catch {}
            eventType = null;
          }
        }
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
          <span></span>
        </div>
        <button className={s.newBtn} onClick={handleNewConversation} disabled={creating || gateBlocked}>
          <span>＋</span>
          <span>新项目</span>
        </button>
        <div className={s.sessionList}>
          {loadingSessions ? (
            <div className={s.sidebarEmpty}>加载中…</div>
          ) : sessions.length === 0 ? (
            <div className={s.sidebarEmpty}>还没有对话</div>
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
            <div className={s.chatScroll} ref={scrollRef}>
              <div className={s.chatInner}>
                {loadingMessages ? null : messages.length === 0 && !streamingText ? (
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
                  所有广告会被配置为 Click-to-WhatsApp 格式，优化最大化 WhatsApp 对话数
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
            <div className={s.planPanelEmpty}>
              <div className={s.planPanelIcon}>✦</div>
              <div className={s.planPanelTitle}>广告方案</div>
              <div className={s.planPanelHint}>
                聊天里给出足够信息后，AI 会在这里生成完整的广告投放方案。
              </div>
            </div>
          )}
        </aside>
      )}
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
  const chips = [
    '帮我推广一款 300W 家用太阳能板到泰国和印尼',
    '为我的 4x4 越野车配件（柬埔寨市场）做投放',
    '我是做外贸的 LED 灯具，想投非洲',
  ];
  return (
    <div className={s.empty}>
      <h1 className={s.emptyTitle}>今天推广哪款产品？</h1>
      <div className={s.emptyChips}>
        {chips.map(c => (
          <button key={c} className={s.emptyChip} onClick={() => onPick(c)}>{c}</button>
        ))}
      </div>
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
  // Tool rows (including draft_ad_plan) render nothing in the transcript —
  // the AdPlanCard lives in the right panel, not in the chat stream.
  return null;
}
