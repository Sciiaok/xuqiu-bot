'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import s from './page.module.css';
import Button from '../../components/Button/Button';
import Tag from '../../components/Tag/Tag';
import Markdown from '../../components/Markdown/Markdown';
import {
  ResearchCard, StrategyCard, CreativePlanCard, CreativeCard,
  ExecutionCard, FeedbackCard, PhaseDivider,
} from '../../components/PhaseCards/PhaseCards';
import { ResearchCardV2 } from '../../components/PhaseCards/ResearchCardV2';
import { consumeSSE } from '../../../lib/consume-sse';

const PHASE_LABELS = {
  intake: '需求收集',
  research: '市场调研',
  strategy: '投放策略',
  creative_plan: '创意规划',
  creative: '素材生成',
  execution: '执行发布',
};

const STATUS_LABELS = {
  intake: '输入信息',
  brief_completed: '完成简报',
  research: '调研市场',
  strategy: '策略制定',
  creative_plan: '设计创意',
  creative: '生成素材',
  execution: '执行中',
  completed: '已完成',
  draft: '草稿',
};

// ─── Phase result card builders (structured, not markdown) ──────
const phaseResultBuilders = {
  research:      r => ({ type: 'research_complete', report: r, duration: null }),
  strategy:      r => ({ type: 'strategy_complete', plan: r }),
  creative_plan: r => r?.creative_tasks?.length ? { type: 'creative_plan_complete', creativeTasks: r.creative_tasks, references: r.references || [] } : null,
  creative:      r => ({ type: 'creative_complete', creatives: r?.assets || r?.creatives || r || [] }),
  execution:     r => ({ type: 'execution_complete', result: r }),
};

function groupChatMessages(messages) {
  const result = [];
  let thinkingBuf = [];

  function flushThinking() {
    if (thinkingBuf.length > 0) {
      // Skip thinking groups where every step is empty (no tool, no phase, no content)
      const hasMeaningful = thinkingBuf.some(s => s.tool || s.phase || (s.content && s.content.trim()));
      if (hasMeaningful) {
        result.push({ type: 'thinking', steps: thinkingBuf });
      }
      thinkingBuf = [];
    }
  }

  for (const msg of messages) {
    const kind = msg.type || msg.role || null;

    // Structured card types — pass through directly
    if (msg.type && msg.type !== 'user' && msg.type !== 'assistant' && msg.type !== 'thinking') {
      flushThinking();
      result.push(msg);
      continue;
    }
    if (kind === 'event') {
      thinkingBuf.push({
        id: msg.id,
        tool: msg.tool_name || null,
        content: msg.content || '',
        phase: msg.phase || null,
      });
      continue;
    }
    if (kind === 'user') {
      flushThinking();
      result.push({ type: 'user', id: msg.id, content: msg.content, attachments: msg.attachments || null });
    } else if (kind === 'assistant') {
      const hasContent = msg.content && msg.content.trim().length > 0;
      const isTool = Boolean(msg.tool_name || msg.tool_result);
      // Detect raw JSON responses (tool results rendered as assistant messages) — collapse into thinking
      const isJsonBlob = hasContent && !isTool && /^\s*[\[{]/.test(msg.content);

      if (hasContent && !isTool && !isJsonBlob) {
        flushThinking();
        result.push({ type: 'assistant', id: msg.id, content: msg.content });
      } else {
        thinkingBuf.push({
          id: msg.id,
          tool: msg.tool_name || null,
          content: msg.content || (msg.tool_result ? JSON.stringify(msg.tool_result).slice(0, 200) : ''),
          phase: msg.phase || null,
        });
      }
    } else {
      thinkingBuf.push({
        id: msg.id,
        tool: msg.tool_name || null,
        content: msg.content || '',
        phase: msg.phase || null,
      });
    }
  }
  flushThinking();
  return result;
}

/** Convert JSON-like content to readable markdown; pass through normal text */
function formatAssistantContent(text) {
  if (!text || typeof text !== 'string') return text || '';
  const trimmed = text.trim();
  // Detect JSON object/array
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      const obj = JSON.parse(trimmed);
      return jsonToMarkdown(obj);
    } catch { /* not valid JSON, fall through */ }
  }
  return text;
}

function jsonToMarkdown(obj, depth) {
  depth = depth || 0;
  if (obj === null || obj === undefined) return '';
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);
  if (Array.isArray(obj)) {
    return obj.map(function(item) {
      if (typeof item === 'object' && item !== null) return jsonToMarkdown(item, depth);
      return '- ' + String(item);
    }).join('\n');
  }
  // Object
  var lines = [];
  var prefix = depth === 0 ? '**' : '';
  var suffix = depth === 0 ? '**' : '';
  Object.keys(obj).forEach(function(key) {
    var val = obj[key];
    var label = key.replace(/_/g, ' ');
    if (typeof val === 'object' && val !== null) {
      lines.push(prefix + label + suffix);
      lines.push(jsonToMarkdown(val, depth + 1));
      lines.push('');
    } else if (val !== null && val !== undefined && val !== '') {
      lines.push(prefix + label + suffix + ': ' + String(val));
    }
  });
  return lines.join('\n');
}

const TOOL_LABELS = {
  web_search: '正在搜集市场信息',
  read_webpage: '正在分析资料',
  update_brief: '正在整理需求',
  save_brief: '正在保存需求',
  parse_attachment: '正在解析文件',
};

function ThinkingGroup({ steps }) {
  const [open, setOpen] = useState(false);
  const toolLabel = (name) => TOOL_LABELS[name] || name;
  // Deduplicate consecutive tool names and hide noisy internal steps
  const HIDDEN_STEPS = new Set(['thinking', 'reasoning_delta']);
  const toolSteps = steps.filter(s => s.tool && !HIDDEN_STEPS.has(s.tool));
  const deduped = toolSteps.reduce((acc, s) => {
    const name = toolLabel(s.tool);
    if (acc.length === 0 || acc[acc.length - 1] !== name) acc.push(name);
    return acc;
  }, []);
  const MAX_BREADCRUMB = 5;
  const truncated = deduped.length > MAX_BREADCRUMB
    ? [...deduped.slice(0, MAX_BREADCRUMB), `+${deduped.length - MAX_BREADCRUMB}`]
    : deduped;
  const label = steps.length === 1
    ? (steps[0].tool ? toolLabel(steps[0].tool) : '思考中…')
    : `${truncated.join(' → ') || `${steps.length} 个处理步骤`}`;

  return (
    <div className={s.thinkingGroup}>
      <button className={s.thinkingToggle} onClick={() => setOpen(v => !v)}>
        <span className={s.thinkingIcon}>{open ? '▾' : '▸'}</span>
        <span className={s.thinkingLabel}>{label}</span>
      </button>
      {open && (
        <div className={s.thinkingSteps}>
          {steps.map((step, i) => (
            <div key={step.id || i} className={s.thinkingStep}>
              {step.tool && <span className={s.thinkingTool}>{TOOL_LABELS[step.tool] || step.tool}</span>}
              {step.phase && <span className={s.thinkingPhase}>{step.phase}</span>}
              {step.content && (
                <span className={s.thinkingContent}>{step.content.slice(0, 300)}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const AI_STAR_SVG = <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L9.19 8.63L2 9.24l5.46 4.73L5.82 21L12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61z"/></svg>;

function AiLabel() {
  return (
    <div className={s.aiLabel}>
      <span className={s.aiIcon}>{AI_STAR_SVG}</span>
      <span>AI 助手</span>
    </div>
  );
}

const isMeaningfulStep = (step) => step.tool || step.phase || (step.content && step.content.trim());

const STEPPER_KEYS = ['intake', 'brief_completed', 'research', 'strategy', 'creative_plan', 'creative', 'execution', 'completed'];

function PhaseStepper({ status, currentPhase }) {
  const activeKey = STEPPER_KEYS.includes(currentPhase) ? currentPhase : status;
  const activeIdx = STEPPER_KEYS.indexOf(activeKey);
  const isDone = status === 'completed';

  return (
    <div className={s.stepper}>
      {STEPPER_KEYS.map((key, i) => {
        let state = 'pending';
        if (isDone || i < activeIdx) state = 'done';
        else if (i === activeIdx) state = 'active';
        return (
          <div key={key} className={`${s.stepperItem} ${s['stepper_' + state]}`}>
            <span className={s.stepperDot} />
            <span className={s.stepperLabel}>{STATUS_LABELS[key] || key}</span>
          </div>
        );
      })}
    </div>
  );
}

export function ChatTab({ workspaceMode = false }) {
  const searchParams = useSearchParams();
  const [sessions, setSessions] = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [selectedSession, setSelectedSession] = useState(null);

  // Sync selected session to URL (replaceState avoids navigation/re-render)
  const selectSession = useCallback((session) => {
    setSelectedSession(session);
    const key = session?.session_id || session?.brief_id;
    if (key) {
      const url = new URL(window.location.href);
      url.searchParams.set('session', key);
      window.history.replaceState(null, '', url.toString());
    }
  }, []);
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [inputVal, setInputVal] = useState('');
  const [sendingMsg, setSendingMsg] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [creatingSession, setCreatingSession] = useState(false);
  // Streaming state for real-time SSE display
  const [streamingText, setStreamingText] = useState('');
  const [streamingSteps, setStreamingSteps] = useState([]);
  const [waitingForAI, setWaitingForAI] = useState(false);
  const [pendingImages, setPendingImages] = useState([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const [showReconnect, setShowReconnect] = useState(false);
  const [lightboxUrl, setLightboxUrl] = useState(null);
  const pendingImagesRef = useRef([]);
  const dragCounterRef = useRef(0);
  // Ref to capture latest streamingSteps for flushing (avoids stale closure)
  const streamingStepsRef = useRef([]);
  // AbortController for active SSE stream — ensures only one connection at a time
  const streamAbortRef = useRef(null);
  // Whether a stream connection is currently active (reading events)
  const streamActiveRef = useRef(false);
  const selectedSessionRef = useRef(null);
  const messageLoadSeqRef = useRef(0);
  // Sync state → refs in a single effect to avoid unnecessary effect overhead
  useEffect(() => { streamingStepsRef.current = streamingSteps; selectedSessionRef.current = selectedSession; pendingImagesRef.current = pendingImages; }, [streamingSteps, selectedSession, pendingImages]);
  useEffect(() => {
    return () => { pendingImagesRef.current.forEach(p => p.preview && URL.revokeObjectURL(p.preview)); };
  }, []);

  // Monotonically incrementing counter to guarantee unique message keys
  // (Date.now() alone can collide when events arrive in the same millisecond)
  const msgSeqRef = useRef(0);
  function uid(prefix) { return `${prefix}-${Date.now()}-${++msgSeqRef.current}`; }

  function getSessionKey(session = selectedSessionRef.current) {
    return session?.session_id || session?.brief_id || null;
  }

  function isActiveSessionKey(sessionKey) {
    return Boolean(sessionKey) && getSessionKey() === sessionKey;
  }

  function appendMessageForSession(sessionKey, message) {
    if (!isActiveSessionKey(sessionKey)) return;
    setMessages(prev => [...prev, message]);
  }

  function replaceMessagesForSession(sessionKey, nextMessages) {
    if (!isActiveSessionKey(sessionKey)) return;
    setMessages(nextMessages);
  }

  const MAX_STREAMING_STEPS = 200;
  function pushStreamingStepForSession(sessionKey, step) {
    if (!isActiveSessionKey(sessionKey)) return;
    setStreamingSteps(prev => {
      const next = [...prev, step];
      // Auto-flush to messages if buffer gets too large to prevent unbounded growth
      if (next.length >= MAX_STREAMING_STEPS) {
        const meaningful = next.filter(isMeaningfulStep);
        if (meaningful.length > 0) {
          setMessages(msgs => [...msgs, { id: uid('tg'), type: 'thinking', steps: meaningful }]);
        }
        streamingStepsRef.current = [];
        return [];
      }
      return next;
    });
  }

  function setStreamingTextForSession(sessionKey, value) {
    if (!isActiveSessionKey(sessionKey)) return;
    setStreamingText(value);
  }

  /** Flush accumulated streaming steps into messages as a persisted thinking group */
  function flushStreamingSteps(sessionKey = getSessionKey()) {
    if (!isActiveSessionKey(sessionKey)) return;
    const steps = streamingStepsRef.current;
    const meaningful = steps.filter(isMeaningfulStep);
    if (meaningful.length > 0) {
      setMessages(prev => [...prev, { id: uid('tg'), type: 'thinking', steps: [...meaningful] }]);
    }
    // Use ReactDOM.flushSync equivalent: set both in same tick
    streamingStepsRef.current = [];
    setStreamingSteps([]);
  }
  // ── Persist lastEventId to sessionStorage for reconnect after refresh ──
  function saveLastEventId(sessionId, eventId) {
    if (sessionId && eventId) {
      try { sessionStorage.setItem(`sse_last_id:${sessionId}`, eventId); } catch {}
    }
  }
  function loadLastEventId(sessionId) {
    try { return sessionStorage.getItem(`sse_last_id:${sessionId}`) || '0-0'; } catch { return '0-0'; }
  }

  const fileInputRef = useRef(null);
  const textareaRef = useRef(null);

  function withUploadFilename(file, fallbackPrefix = 'upload') {
    if (!file || file.name) return file;

    const extByType = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'application/pdf': 'pdf',
    };
    const ext = extByType[file.type] || 'bin';
    return new File([file], `${fallbackPrefix}-${Date.now()}.${ext}`, { type: file.type || 'application/octet-stream' });
  }

  async function handleNewSession() {
    setCreatingSession(true);
    try {
      const res = await fetch('/api/campaign/orchestrate', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to create session');
      const { brief_id, session_id } = await res.json();
      const newSession = { brief_id, session_id, status: 'intake', current_phase: 'intake', created_at: new Date().toISOString(), completion_pct: 0, first_message: null };
      setSessions(prev => [newSession, ...prev]);
      selectSession(newSession);
    } catch (err) {
      console.error('Error creating session:', err);
    } finally {
      setCreatingSession(false);
    }
  }

  // Update the current session's status/phase in the sidebar list in real-time
  function updateSessionStatus(sessionKey, updates) {
    if (!sessionKey) return;
    setSessions(prev => prev.map(session => (
      getSessionKey(session) === sessionKey ? { ...session, ...updates } : session
    )));
    setSelectedSession(prev => (
      getSessionKey(prev) === sessionKey ? { ...prev, ...updates } : prev
    ));
  }

  async function handleDeleteSession(briefId) {
    if (!window.confirm('确认删除此投放计划？所有对话和数据将被永久删除。')) return;
    try {
      const res = await fetch('/api/campaign/sessions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ briefId }),
      });
      if (!res.ok) throw new Error('Delete failed');
      const isCurrentSelected = selectedSession?.brief_id === briefId;
      setSessions(prev => prev.filter(s => s.brief_id !== briefId));
      // Switch after state update, not inside setSessions callback
      if (isCurrentSelected) {
        const remaining = sessions.filter(s => s.brief_id !== briefId);
        selectSession(remaining[0] || null);
      }
    } catch (err) {
      console.error('Delete session failed:', err);
    }
  }

  useEffect(() => {
    const urlSession = searchParams.get('session');
    async function fetchSessions() {
      try {
        const res = await fetch('/api/campaign/sessions');
        if (!res.ok) throw new Error('Failed to fetch sessions');
        const json = await res.json();
        const data = json.data || [];
        setSessions(data);
        // Restore session from URL param, or default to first
        const fromUrl = urlSession && data.find(s => s.session_id === urlSession || s.brief_id === urlSession);
        selectSession(fromUrl || data[0] || null);
      } catch (err) {
        console.error('Error fetching campaign sessions:', err);
      } finally {
        setLoadingSessions(false);
      }
    }
    fetchSessions();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sessionKey = getSessionKey(selectedSession);
    const requestSeq = ++messageLoadSeqRef.current;

    // Abort previous SSE stream and clear previous session view
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
    setMessages([]);
    setStreamingText('');
    setStreamingSteps([]);
    streamingStepsRef.current = [];
    setPendingImages([]);
    if (!selectedSession?.session_id) {
      return;
    }
    let cancelled = false;
    async function fetchWithRetry(url, retries = 1) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        const res = await fetch(url);
        if (res.ok) return res;
        if (attempt < retries && res.status >= 500) {
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        throw new Error(`HTTP ${res.status}`);
      }
    }
    async function fetchMessages() {
      setLoadingMessages(true);
      try {
        const res = await fetchWithRetry(`/api/campaign/orchestrate/${selectedSession.session_id}`);
        const orchData = await res.json();
        if (cancelled || messageLoadSeqRef.current !== requestSeq || !isActiveSessionKey(sessionKey)) return;
        const phaseResults = orchData.phase_results || {};
        const allMsgs = orchData.messages || [];
        const reconstructed = [];

        // Pre-scan: find last occurrence index for deduplication across re-runs
        const lastPhaseStartIdx = {};
        const lastPhaseCompleteIdx = {};
        const lastPhaseErrorIdx = {};
        let lastFeedbackIdx = -1;
        for (let i = 0; i < allMsgs.length; i++) {
          const m = allMsgs[i];
          if (m.role !== 'event' || !m.tool_name) continue;
          if (m.tool_name === 'phase_start') lastPhaseStartIdx[m.phase] = i;
          if (m.tool_name === 'phase_complete') lastPhaseCompleteIdx[m.phase] = i;
          if (m.tool_name === 'phase_error') lastPhaseErrorIdx[m.phase] = i;
          if (m.tool_name === 'feedback_required') lastFeedbackIdx = i;
        }

        // Process messages in chronological order
        const emittedPhases = new Set();
        let thinkingBuf = [];

        function flushThinkingBuf() {
          if (thinkingBuf.length > 0) {
            reconstructed.push({ type: 'thinking', steps: thinkingBuf });
            thinkingBuf = [];
          }
        }

        for (let i = 0; i < allMsgs.length; i++) {
          const m = allMsgs[i];

          // Chat messages (user/assistant from any phase)
          if (m.role === 'user') {
            flushThinkingBuf();
            reconstructed.push({ type: 'user', id: m.id, content: m.content, attachments: m.attachments || null });
            continue;
          }
          if (m.role === 'assistant' && m.content) {
            // Skip internal debug traces (legacy data stored as assistant)
            if (m.content.startsWith('[Agent ')) continue;
            flushThinkingBuf();
            reconstructed.push({ type: 'assistant', id: m.id, content: m.content });
            continue;
          }

          // Event messages — only render the last occurrence for each phase
          if (m.role === 'event' && m.tool_name) {
            switch (m.tool_name) {
              case 'phase_progress':
                // Accumulate progress events into a thinking group
                if (m.content) {
                  thinkingBuf.push({ id: m.id, tool: null, content: m.content, phase: m.phase });
                }
                break;
              case 'phase_start':
                flushThinkingBuf();
                if (lastPhaseStartIdx[m.phase] === i) {
                  reconstructed.push({ id: m.id, type: 'phase_start', content: PHASE_LABELS[m.phase] || m.phase });
                }
                break;
              case 'phase_complete':
                flushThinkingBuf();
                if (lastPhaseCompleteIdx[m.phase] === i) {
                  const builder = phaseResultBuilders[m.phase];
                  const result = phaseResults[m.phase];
                  if (builder && result) {
                    const card = builder(result);
                    if (card) { reconstructed.push({ id: m.id, ...card }); emittedPhases.add(m.phase); }
                  }
                }
                break;
              case 'phase_error':
                flushThinkingBuf();
                // Only show error if no later successful completion for this phase
                if (lastPhaseErrorIdx[m.phase] === i &&
                    (lastPhaseCompleteIdx[m.phase] == null || lastPhaseCompleteIdx[m.phase] < i)) {
                  reconstructed.push({ id: m.id, type: 'error', content: `${PHASE_LABELS[m.phase] || m.phase} 失败: ${m.content}` });
                }
                break;
              case 'feedback_required':
                flushThinkingBuf();
                if (lastFeedbackIdx === i && (orchData.status === 'awaiting_feedback' || orchData.status === 'awaiting_approval')) {
                  reconstructed.push({
                    id: m.id, type: 'feedback_required',
                    message: m.content,
                    options: m.tool_result?.options || ['确认执行', '取消'],
                  });
                }
                break;
            }
            continue;
          }
        }
        flushThinkingBuf();

        // Fallback: phase result cards for sessions without events
        for (const [phase, builder] of Object.entries(phaseResultBuilders)) {
          if (!emittedPhases.has(phase) && phaseResults[phase]) {
            const card = builder(phaseResults[phase]);
            if (card) reconstructed.push({ id: `fb-${phase}`, ...card });
          }
        }

        replaceMessagesForSession(sessionKey, reconstructed);

        // Auto-reconnect to stream if backend task is actively running
        const activeStatuses = new Set(['intake', 'running', 'awaiting_feedback']);
        if (activeStatuses.has(orchData.status)) {
          const savedId = loadLastEventId(selectedSession.session_id);
          const reconnectBaseId = selectedSession.session_id || selectedSession.brief_id;
          connectToStream(sessionKey, selectedSession.session_id, reconnectBaseId, savedId);
        }
      } catch (err) {
        console.error('Error fetching messages:', err);
        if (cancelled || messageLoadSeqRef.current !== requestSeq || !isActiveSessionKey(sessionKey)) return;
        replaceMessagesForSession(sessionKey, []);
      } finally {
        if (cancelled || messageLoadSeqRef.current !== requestSeq || !isActiveSessionKey(sessionKey)) return;
        setLoadingMessages(false);
      }
    }
    fetchMessages();
    return () => {
      cancelled = true;
    };
  }, [selectedSession?.session_id, refreshKey]);

  // ── Poll for stale sessions that may have been recovered by cron ──
  // If the session was 'running' but SSE dropped, the cron may resume it.
  // Poll every 15s to detect status changes and reconnect to the stream.
  const lastKnownStatusRef = useRef(null);
  useEffect(() => {
    if (!selectedSession?.session_id) return;
    // Only poll when the session looks stuck (no active SSE stream)
    const sessionId = selectedSession.session_id;
    const interval = setInterval(async () => {
      // Skip polling while SSE stream is actively connected
      if (streamActiveRef.current) return;
      try {
        const res = await fetch(`/api/campaign/orchestrate/${sessionId}`);
        if (!res.ok) return;
        const data = await res.json();
        const prev = lastKnownStatusRef.current;
        lastKnownStatusRef.current = data.status;

        // If session transitioned from a stuck state, reload messages + reconnect
        const stuckStates = new Set(['running', 'interrupted']);
        const activeStates = new Set(['running', 'awaiting_feedback']);
        if (prev && stuckStates.has(prev) && data.status !== prev) {
          // Status changed — full reload to pick up new phase results
          setRefreshKey(k => k + 1);
        } else if (data.status === 'running' && !streamActiveRef.current) {
          // Session is running but we have no active stream — reconnect
          const sessionKey = getSessionKey(selectedSession);
          const savedId = loadLastEventId(sessionId);
          connectToStream(sessionKey, sessionId, sessionId, savedId);
        }
      } catch {}
    }, 15_000);
    return () => clearInterval(interval);
  }, [selectedSession?.session_id]);

  // Auto-scroll only when user is already near the bottom (not browsing history)
  const chatContainerRef = useRef(null);

  const autoFollowRef = useRef(true);
  const lastScrollTopRef = useRef(0);

  useEffect(() => {
    const el = chatContainerRef.current;
    if (!el) return;
    const onScroll = () => {
      const currentTop = el.scrollTop;
      const prevTop = lastScrollTopRef.current;
      lastScrollTopRef.current = currentTop;

      // User scrolled UP → stop auto-follow
      if (currentTop < prevTop - 2) {
        autoFollowRef.current = false;
        return;
      }

      // Near bottom → resume auto-follow
      const nearBottom = el.scrollHeight - currentTop - el.clientHeight <= 80;
      if (nearBottom) {
        autoFollowRef.current = true;
      }
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = chatContainerRef.current;
    if (el && autoFollowRef.current) {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    }
  }, [messages, streamingText, streamingSteps]);

  useEffect(() => {
    autoFollowRef.current = true;
    const el = chatContainerRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      lastScrollTopRef.current = el.scrollTop;
    });
  }, [selectedSession?.session_id]);

  // Auto-resize textarea to fit content
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [inputVal]);

  // ── Shared stream connection — used by handleSend, handleFeedbackRespond, and reconnect ──
  async function connectToStream(sessionKey, sessionId, baseId, startEventId) {
    // Abort any previous stream connection before starting a new one
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
    }
    const abortController = new AbortController();
    streamAbortRef.current = abortController;
    streamActiveRef.current = true;

    let assistantText = '';
    let streamDone = false;

    const handleEvent = (event, data, eventId) => {
      if (eventId) saveLastEventId(sessionId, eventId);
      if (!isActiveSessionKey(sessionKey)) return;
      // Dismiss "AI processing" dots only when the event produces visible UI.
      // This prevents a blank gap when non-visible events (e.g. user_injected) arrive first.
      switch (event) {
        case 'delta':
          setWaitingForAI(false);
          assistantText += data.text;
          setStreamingTextForSession(sessionKey, assistantText);
          break;
        case 'thinking':
          setWaitingForAI(false);
          pushStreamingStepForSession(sessionKey, { tool: null, content: data.text, phase: null });
          break;
        case 'tool_start':
          setWaitingForAI(false);
          pushStreamingStepForSession(sessionKey, { tool: data.tool, content: '', phase: null });
          break;
        case 'tool_call':
          setWaitingForAI(false);
          pushStreamingStepForSession(sessionKey, { tool: data.tool, content: JSON.stringify(data.input, null, 2).slice(0, 200), phase: null });
          break;
        case 'tool_result':
          setWaitingForAI(false);
          pushStreamingStepForSession(sessionKey, { tool: data.tool, content: JSON.stringify(data.result, null, 2).slice(0, 200), phase: null });
          break;
        case 'orchestration_start':
          setWaitingForAI(false);
          if (assistantText) {
            appendMessageForSession(sessionKey, { id: uid('ai'), type: 'assistant', content: assistantText });
            setStreamingTextForSession(sessionKey, '');
            assistantText = '';
          }
          flushStreamingSteps(sessionKey);
          pushStreamingStepForSession(sessionKey, { tool: null, content: '▶ 投放流程启动' });
          updateSessionStatus(sessionKey, { status: 'running', current_phase: 'orchestrating' });
          break;
        case 'phase_start':
          setWaitingForAI(false);
          pushStreamingStepForSession(sessionKey, { tool: null, content: `▶ ${PHASE_LABELS[data.phase] || data.phase}`, phase: data.phase });
          updateSessionStatus(sessionKey, { current_phase: data.phase });
          break;
        case 'phase_progress':
          setWaitingForAI(false);
          pushStreamingStepForSession(sessionKey, { tool: data.step, content: data.detail || data.step, phase: data.phase });
          break;
        case 'phase_complete': {
          setWaitingForAI(false);
          pushStreamingStepForSession(sessionKey, { tool: null, content: `✓ ${PHASE_LABELS[data.phase] || data.phase} 完成`, phase: data.phase });
          flushStreamingSteps(sessionKey);
          const builder = phaseResultBuilders[data.phase];
          if (builder && data.result) {
            const card = builder(data.result);
            if (card) appendMessageForSession(sessionKey, { id: uid(`phase-${data.phase}`), ...card });
          }
          break;
        }
        case 'approval_required':
          setWaitingForAI(false);
          appendMessageForSession(sessionKey, { id: uid('approval'), type: 'execution_approval', plan: data.plan, status: 'awaiting_approval' });
          updateSessionStatus(sessionKey, { status: 'awaiting_approval' });
          break;
        case 'feedback_required':
          setWaitingForAI(false);
          flushStreamingSteps(sessionKey);
          appendMessageForSession(sessionKey, { id: uid('fb'), type: 'feedback_required', message: data.message || '需要您的确认', options: data.options || [] });
          updateSessionStatus(sessionKey, { status: 'awaiting_feedback' });
          break;
        case 'user_injected':
          // No visible UI — keep dots spinning
          break;
        case 'phase_error':
          setWaitingForAI(false);
          appendMessageForSession(sessionKey, { id: uid('err'), type: 'error', content: `${PHASE_LABELS[data.phase] || data.phase} 失败: ${data.error}` });
          break;
        case 'error':
          setWaitingForAI(false);
          appendMessageForSession(sessionKey, { id: uid('err'), type: 'error', content: data.message || '发生错误' });
          streamDone = true;
          break;
        case 'done':
          setWaitingForAI(false);
          if (assistantText) {
            appendMessageForSession(sessionKey, { id: uid('ai'), type: 'assistant', content: assistantText });
            assistantText = '';
          }
          setStreamingTextForSession(sessionKey, '');
          flushStreamingSteps(sessionKey);
          if (data.phases_completed?.length) {
            appendMessageForSession(sessionKey, { id: uid('done'), type: 'assistant', content: `投放方案已完成！共执行 ${data.phases_completed.length} 个阶段：${data.phases_completed.join(' → ')}` });
            updateSessionStatus(sessionKey, { status: 'completed', current_phase: 'done' });
          }
          streamDone = true;
          break;
      }
    };

    const briefId = selectedSessionRef.current?.brief_id || '';
    const streamUrl = `/api/campaign/orchestrate/${baseId}/stream?lastEventId=${encodeURIComponent(startEventId)}${briefId ? `&briefId=${encodeURIComponent(briefId)}` : ''}`;
    try {
      const streamRes = await fetch(streamUrl, { signal: abortController.signal });
      if (streamRes.ok) {
        await consumeSSE(streamRes, handleEvent);
      }
    } catch (err) {
      if (err.name === 'AbortError' || abortController.signal.aborted) return;
      console.warn('Stream connection failed:', err.message);
    } finally {
      // Only clean up if this connection is still the current one.
      // A newer connectToStream() may have already replaced streamAbortRef;
      // clearing waitingForAI here would kill the NEW connection's loading dots.
      if (streamAbortRef.current === abortController) {
        setWaitingForAI(false);
        streamActiveRef.current = false;
      }
    }

    if (assistantText) {
      appendMessageForSession(sessionKey, { id: uid('ai'), type: 'assistant', content: assistantText });
      setStreamingTextForSession(sessionKey, '');
    }
  }

  async function handleSend() {
    const hasImages = pendingImages.some(p => p.uploaded);
    if (!selectedSession || (!inputVal.trim() && !hasImages) || sendingMsg) return;
    const session = selectedSession;
    const sessionKey = getSessionKey(session);
    const text = inputVal.trim();
    const attachments = pendingImages.filter(p => p.uploaded).map(p => p.uploaded);
    setSendingMsg(true);
    setInputVal('');
    setPendingImages([]);

    // Show user message immediately + sync title to sidebar
    flushStreamingSteps(sessionKey);
    const userMsg = { id: uid('tmp'), type: 'user', content: text, attachments: attachments.length ? attachments : undefined };
    appendMessageForSession(sessionKey, userMsg);
    setStreamingTextForSession(sessionKey, '');
    setWaitingForAI(true);
    // Update session title in sidebar with first message
    if (!session.first_message && text) {
      updateSessionStatus(sessionKey, { first_message: text });
    }

    try {
      const baseId = session.session_id || session.brief_id;

      // If pipeline is running, send via /message endpoint (non-blocking injection)
      if (session.status === 'running') {
        try {
          const res = await fetch(`/api/campaign/orchestrate/${baseId}/message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: text, attachments }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (err) {
          appendMessageForSession(sessionKey, { id: uid('err'), type: 'error', content: `发送失败: ${err.message}` });
        } finally {
          setSendingMsg(false);
        }
        return;
      }

      const isFeedbackMode = session.status === 'awaiting_feedback' || session.status === 'awaiting_approval';
      const endpoint = isFeedbackMode
        ? `/api/campaign/orchestrate/${baseId}/feedback`
        : `/api/campaign/orchestrate/${baseId}`;
      const payload = isFeedbackMode ? { response: text } : { message: text };
      if (attachments.length) payload.attachments = attachments;

      // Fire POST and SSE connection in parallel — don't wait for POST before connecting to stream
      const startId = loadLastEventId(session.session_id);
      connectToStream(sessionKey, session.session_id, baseId, startId).catch(err => {
        if (err.name !== 'AbortError') console.warn('Stream connection failed:', err.message);
      });

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => res.statusText);
        throw new Error(errBody || `Server error (${res.status})`);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Error sending message:', err);
      appendMessageForSession(sessionKey, { id: uid('err'), type: 'error', content: `发送失败: ${err.message}` });
      setShowReconnect(true);
    } finally {
      setSendingMsg(false);
      setStreamingTextForSession(sessionKey, '');
    }
  }

  // Pipeline auto-starts from intake via yield* orchestrate() — no separate frontend trigger needed

  async function handleFeedbackRespond(response) {
    const session = selectedSession;
    const sessionKey = getSessionKey(session);
    const attachments = pendingImages.filter(p => p.uploaded).map(p => p.uploaded);
    const baseId = session.session_id || session.brief_id;

    // Mark feedback card as resolved (keep content visible, disable buttons)
    if (isActiveSessionKey(sessionKey)) {
      setMessages(prev => prev.map(m =>
        m.type === 'feedback_required' ? { ...m, type: 'feedback_resolved', selectedOption: response } : m
      ));
      setMessages(prev => [...prev, {
        id: uid('fb-resp'),
        type: 'user',
        content: response,
        attachments: attachments.length ? attachments : undefined,
      }]);
    }
    setSendingMsg(true);
    setPendingImages([]);

    try {
      // POST to /feedback — fires a fresh generator from saved orchestrator_state
      const res = await fetch(`/api/campaign/orchestrate/${baseId}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response, attachments }),
      });
      if (!res.ok) {
        appendMessageForSession(sessionKey, { id: uid('err'), type: 'error', content: `反馈提交失败: ${res.status}` });
        return;
      }
      // Connect to /stream — don't await, stream reading is background
      const fbStartId = loadLastEventId(session.session_id);
      connectToStream(sessionKey, session.session_id, baseId, fbStartId).catch(err => {
        if (err.name !== 'AbortError') console.warn('Stream connection failed:', err.message);
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      appendMessageForSession(sessionKey, { id: uid('err'), type: 'error', content: err.message });
    } finally {
      setSendingMsg(false);
    }
  }

  async function handleStop() {
    const session = selectedSession;
    const sessionKey = getSessionKey(session);
    // 1. Abort SSE connection
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
    }
    // 2. Flush any accumulated content to messages
    if (streamingText) {
      appendMessageForSession(sessionKey, { id: uid('ai'), type: 'assistant', content: streamingText });
    }
    flushStreamingSteps(sessionKey);
    // 3. Reset streaming state
    setStreamingText('');
    setStreamingSteps([]);
    streamingStepsRef.current = [];
    setWaitingForAI(false);
    setSendingMsg(false);
    streamActiveRef.current = false;
    // 4. Signal backend to stop the generator
    if (session?.session_id) {
      const baseId = session.session_id || session.brief_id;
      fetch(`/api/campaign/orchestrate/${baseId}/stop`, { method: 'POST' }).catch(() => {});
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleUploadClick() {
    fileInputRef.current?.click();
  }

  function hasDraggedFiles(dataTransfer) {
    return Array.from(dataTransfer?.types || []).includes('Files');
  }

  // Compress image on the client to avoid 413 server limits
  function compressImage(file, maxDim = 1920, quality = 0.85) {
    return new Promise((resolve) => {
      if (file.type === 'image/gif' || file.size < 200 * 1024) {
        resolve(file);
        return;
      }
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width <= maxDim && height <= maxDim && file.size < 1024 * 1024) {
          URL.revokeObjectURL(img.src);
          resolve(file);
          return;
        }
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        URL.revokeObjectURL(img.src);
        canvas.toBlob(
          (blob) => {
            if (!blob) { resolve(file); return; }
            const compressed = new File([blob], file.name.replace(/\.\w+$/, '.jpg'), {
              type: 'image/jpeg',
            });
            canvas.width = 0; canvas.height = 0;
            resolve(compressed);
          },
          'image/jpeg',
          quality,
        );
      };
      img.onerror = () => { URL.revokeObjectURL(img.src); resolve(file); };
      img.src = URL.createObjectURL(file);
    });
  }

  async function uploadFiles(files) {
    if (!files.length) return;
    for (const file of files) {
      const imgId = `img-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
      const preview = URL.createObjectURL(file);
      setPendingImages(prev => [...prev, { id: imgId, file, preview, uploading: true, uploaded: null }]);

      try {
        const isImage = file.type.startsWith('image/');
        const fileToUpload = isImage ? await compressImage(file) : file;
        const formData = new FormData();
        formData.append('file', fileToUpload);
        if (selectedSession?.session_id) formData.append('session_id', selectedSession.session_id);
        else if (selectedSession?.brief_id) formData.append('session_id', selectedSession.brief_id);

        const res = await fetch('/api/campaign/upload', { method: 'POST', body: formData });
        if (!res.ok) throw new Error('Upload failed');
        const result = await res.json();
        setPendingImages(prev => prev.map(p => p.id === imgId ? { ...p, uploading: false, uploaded: result } : p));
      } catch (err) {
        console.error('Upload failed:', err);
        setPendingImages(prev => prev.filter(p => p.id !== imgId));
      }
    }
  }

  async function handleFileSelect(e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    await uploadFiles(files);
  }

  async function handleInputPaste(e) {
    const files = Array.from(e.clipboardData?.items || [])
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter(Boolean)
      .map((file, index) => withUploadFilename(file, `clipboard-${index + 1}`));

    if (!files.length) return;

    e.preventDefault();
    await uploadFiles(files);
  }

  function handleDragEnter(e) {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setIsDragActive(true);
  }

  function handleDragOver(e) {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!isDragActive) setIsDragActive(true);
  }

  function handleDragLeave(e) {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDragActive(false);
    }
  }

  async function handleDrop(e) {
    if (!hasDraggedFiles(e.dataTransfer)) return;
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragActive(false);
    const files = Array.from(e.dataTransfer?.files || []).map((file, index) => withUploadFilename(file, `drop-${index + 1}`));
    await uploadFiles(files);
  }

  const hasContent = inputVal.trim() || pendingImages.some(p => p.uploaded);
  const isStreaming = waitingForAI || Boolean(streamingText) || streamingSteps.length > 0;
  const grouped = useMemo(() => groupChatMessages(messages), [messages]);

  return (
    <>
    <div className={`${s.chatLayout} ${workspaceMode ? s.chatLayoutWorkspace : ''}`}>
      <div className={s.chatMain}>
        {/* ── Phase progress stepper ──────────────────────── */}
        {selectedSession && (
          <PhaseStepper status={selectedSession.status} currentPhase={selectedSession.current_phase} />
        )}
        <div className={`${s.chatMainInner} ${workspaceMode ? s.chatCardWorkspace : ''}`}>
          <div
            className={`${s.chatDropZone} ${isDragActive ? s.chatDropZoneActive : ''}`}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
          {/* ── Message area ─────────────────────────────────── */}
          {loadingMessages ? (
            <div className={s.chatMessages}>
              <div className={s.emptyState}>
                <span style={{ color: 'var(--text3)', fontSize: 14 }}>加载对话中…</span>
              </div>
            </div>
          ) : messages.length === 0 && selectedSession ? (
            <div className={s.chatMessages}>
              <div className={s.emptyState}>
                <h2 className={s.emptyGreeting}>有什么可以帮你的？</h2>
                <div className={s.emptyChips}>
                  {['帮我推广一款新能源汽车到东南亚市场', '分析我的竞品广告投放策略', '为我的农机产品生成 Facebook 广告素材'].map(hint => (
                    <button key={hint} className={s.emptyChip} onClick={() => setInputVal(hint)}>
                      {hint}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : messages.length === 0 ? (
            <div className={s.chatMessages}>
              <div className={s.emptyState}>
                <h2 className={s.emptyGreeting}>有什么可以帮你的？</h2>
                <p style={{ color: 'var(--text3)', fontSize: 14, margin: 0 }}>从右侧选择一个投放计划查看对话</p>
              </div>
            </div>
          ) : (
            <div className={s.chatMessages} ref={chatContainerRef}>
              {grouped.map((item, i) => {
                  const prevType = i > 0 ? grouped[i - 1].type : null;
                  const isAiType = (t) => t === 'assistant' || t === 'error';
                  const showAiLabel = !isAiType(prevType);

                  /* ── User message ── */
                  if (item.type === 'user') {
                    return (
                      <div key={item.id || i} className={s.chatMsgUser}>
                        <div className={s.userContent}>
                          {item.attachments?.length > 0 && (
                            <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                              {item.attachments.map((att, j) => (
                                <div key={j} style={{ position: 'relative', cursor: 'pointer' }} onClick={() => setLightboxUrl(att.url)}>
                                  <img src={att.url} alt={att.filename || ''} style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 12, border: '1px solid var(--border)' }} />
                                </div>
                              ))}
                            </div>
                          )}
                          <p>{item.content}</p>
                        </div>
                      </div>
                    );
                  }
                  /* ── AI message ── */
                  if (item.type === 'assistant') {
                    return (
                      <div key={item.id || i} className={s.chatMsgAI}>
                        {showAiLabel && <AiLabel />}
                        <div className={s.aiContent}>
                          <Markdown>{formatAssistantContent(item.content)}</Markdown>
                        </div>
                      </div>
                    );
                  }
                  /* ── Phase divider ── */
                  if (item.type === 'phase_start') {
                    return <div key={item.id || i} className={s.phaseCardWrapper}><PhaseDivider label={item.content} /></div>;
                  }
                  /* ── Phase result cards ── */
                  if (item.type === 'research_complete') {
                    const card = item.report?._v2
                      ? <ResearchCardV2 report={item.report} duration={item.duration} />
                      : <ResearchCard report={item.report} duration={item.duration} />;
                    return <div key={item.id || i} className={s.phaseCardWrapper}>{card}</div>;
                  }
                  if (item.type === 'strategy_complete') {
                    return <div key={item.id || i} className={s.phaseCardWrapper}><StrategyCard plan={item.plan} /></div>;
                  }
                  if (item.type === 'creative_plan_complete') {
                    return <div key={item.id || i} className={s.phaseCardWrapper}><CreativePlanCard creativeTasks={item.creativeTasks} references={item.references} /></div>;
                  }
                  if (item.type === 'creative_complete') {
                    return <div key={item.id || i} className={s.phaseCardWrapper}><CreativeCard creatives={item.creatives} /></div>;
                  }
                  if (item.type === 'creative_progress') {
                    return <div key={item.id || i} className={s.phaseCardWrapper}><CreativeCard inProgress completed={item.completed} total={item.total} errors={item.errors} lastDetail={item.lastDetail} /></div>;
                  }
                  if (item.type === 'execution_approval') {
                    return <div key={item.id || i} className={s.phaseCardWrapper}><ExecutionCard plan={item.plan} status="awaiting_approval" /></div>;
                  }
                  if (item.type === 'execution_complete') {
                    return <div key={item.id || i} className={s.phaseCardWrapper}><ExecutionCard result={item.result} status="completed" /></div>;
                  }
                  if (item.type === 'feedback_required') {
                    return <div key={item.id || i} className={s.phaseCardWrapper}><FeedbackCard message={item.message} options={item.options} onRespond={handleFeedbackRespond} /></div>;
                  }
                  if (item.type === 'feedback_resolved') {
                    return <div key={item.id || i} className={s.phaseCardWrapper}><FeedbackCard message={item.message} options={item.options} resolved selectedOption={item.selectedOption} /></div>;
                  }
                  /* ── Error ── */
                  if (item.type === 'error') {
                    return (
                      <div key={item.id || i} className={s.chatMsgAI}>
                        {showAiLabel && <AiLabel />}
                        <div className={s.aiContent} style={{ color: 'var(--red)' }}>
                          {item.content}
                        </div>
                      </div>
                    );
                  }
                  /* ── Thinking group ── */
                  return <ThinkingGroup key={`tg-${i}`} steps={item.steps} />;
              })}

              {/* Waiting indicator — pulsing dots */}
              {waitingForAI && streamingSteps.length === 0 && !streamingText && (
                <div className={s.chatMsgAI}>
                  <AiLabel />
                  <div className={s.aiContent}>
                    <div className={s.typingDots}>
                      <span /><span /><span />
                    </div>
                  </div>
                </div>
              )}

              {/* Live streaming status bar */}
              {streamingSteps.length > 0 && (
                <div className={s.streamingStatus}>
                  <span className={s.streamingSpinner} />
                  <span className={s.streamingLabel}>
                    {streamingSteps[streamingSteps.length - 1]?.content || '处理中…'}
                  </span>
                  {streamingSteps[streamingSteps.length - 1]?.phase && (
                    <span className={s.streamingPhase}>
                      {streamingSteps[streamingSteps.length - 1].phase}
                    </span>
                  )}
                </div>
              )}

              {/* Live streaming assistant text */}
              {streamingText && (
                <div className={s.chatMsgAI}>
                  <AiLabel />
                  <div className={s.aiContent}>
                    <Markdown>{streamingText}</Markdown>
                    <span className={s.blinkingCursor} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Reconnect bar */}
          {showReconnect && (
            <div className={s.reconnectBar}>
              <span>连接中断</span>
              <button className={s.reconnectBtn} onClick={() => { setShowReconnect(false); setRefreshKey(k => k + 1); }}>
                重新连接
              </button>
            </div>
          )}

          {/* ── Input area ───────────────────────────────────── */}
          <div className={s.chatInputContainer}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
            {/* Pending image previews */}
            {pendingImages.length > 0 && (
              <div className={s.pendingImagesRow}>
                {pendingImages.map(img => {
                  const isImage = img.file?.type?.startsWith('image/');
                  return (
                    <div key={img.id} style={{ position: 'relative', width: 52, height: 52, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--border)' }}>
                      {isImage ? (
                        <img src={img.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      ) : (
                        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontSize: 10, background: 'var(--bg3)' }}>
                          <span style={{ fontSize: 18 }}>📄</span>
                          <span style={{ fontSize: 8, marginTop: 1 }}>{img.file?.name?.split('.').pop()?.toUpperCase()}</span>
                        </div>
                      )}
                      {img.uploading && (
                        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          <span className={s.streamingSpinner} style={{ borderColor: '#fff', borderTopColor: 'transparent' }} />
                        </div>
                      )}
                      <button
                        onClick={() => setPendingImages(prev => prev.filter(p => p.id !== img.id))}
                        style={{ position: 'absolute', top: 2, right: 2, width: 18, height: 18, background: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none', borderRadius: '50%', fontSize: 11, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}
                      >×</button>
                    </div>
                  );
                })}
              </div>
            )}
            <div className={s.chatInputInner}>
              <button className={s.inputActionBtn} title="上传图片/文档" onClick={handleUploadClick} disabled={sendingMsg}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <textarea
                ref={textareaRef}
                className={s.chatTextarea}
                placeholder="描述你的推广目标，或拖拽 / 粘贴素材…"
                value={inputVal}
                onChange={e => setInputVal(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handleInputPaste}
                disabled={sendingMsg}
                rows={1}
              />
              {isStreaming ? (
                <button
                  className={s.inputStopBtn}
                  onClick={handleStop}
                  title="停止生成"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <rect x="2" y="2" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : hasContent ? (
                <button
                  className={s.inputSendBtn}
                  onClick={handleSend}
                  disabled={sendingMsg || !selectedSession}
                  title="发送"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              ) : null}
            </div>
          </div>

          {/* Drop overlay */}
          {isDragActive && (
            <div className={s.dropOverlay}>
              <div className={s.dropOverlayInner}>
                <div className={s.dropOverlayTitle}>松开以上传素材</div>
                <div className={s.dropOverlayText}>支持图片、PDF 和表格文件</div>
              </div>
            </div>
          )}
          </div>
        </div>
      </div>

      {/* Session list sidebar */}
      <div className={`${s.chatSidebar} ${workspaceMode ? s.chatSidebarWorkspace : ''}`}>
        <div className={s.sidebarHead}>
          <span className={s.sidebarTitle}>投放计划</span>
          {!loadingSessions && (
            <Tag variant="new">{sessions.length} 个</Tag>
          )}
        </div>

        <div className={s.previewList}>
          {loadingSessions ? (
            <div style={{ padding: '16px', color: 'var(--text3)', fontSize: '13px' }}>加载中…</div>
          ) : sessions.length === 0 ? (
            <div style={{ padding: '16px', color: 'var(--text3)', fontSize: '13px' }}>暂无投放计划</div>
          ) : (
            sessions.map(session => {
              const isActive = selectedSession?.brief_id === session.brief_id;
              const statusLabel = STATUS_LABELS[session.status] || session.status;
              const phaseLabel = PHASE_LABELS[session.current_phase] || session.current_phase;
              const preview = session.first_message
                ? session.first_message.slice(0, 60) + (session.first_message.length > 60 ? '…' : '')
                : '（无摘要）';
              const createdDate = session.created_at
                ? new Date(session.created_at).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                : '';

              const brief = session.brief_structured || {};
              const tags = [brief.target_market, brief.product_type, brief.platform].filter(Boolean);
              const thumbUrl = session.campaign_plan?.creatives?.[0]?.url;

              return (
                <div
                  key={session.brief_id}
                  className={s.previewCard}
                  onClick={() => selectSession(session)}
                  style={{
                    cursor: 'pointer',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 4,
                    ...(isActive ? { borderColor: 'var(--accent)', background: 'var(--bg3)' } : {}),
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', position: 'relative' }}>
                    <button
                      className={s.deleteSessionBtn}
                      onClick={(e) => { e.stopPropagation(); handleDeleteSession(session.brief_id); }}
                      title="删除"
                    >×</button>
                    <div className={s.previewThumb} style={{ flexShrink: 0 }}>
                      {thumbUrl ? (
                        <img src={thumbUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'var(--r)' }} />
                      ) : (
                        <span className={s.previewEmoji}>✦</span>
                      )}
                    </div>
                    <div className={s.previewInfo} style={{ flex: 1, minWidth: 0 }}>
                      <div className={s.previewTitle} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {preview}
                      </div>
                      <div className={s.previewMeta}>
                        {statusLabel} · {createdDate}
                      </div>
                      {tags.length > 0 && (
                        <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
                          {tags.map(tag => (
                            <span key={tag} style={{ fontSize: 9, padding: '1px 5px', background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 3, color: 'var(--text3)' }}>{tag}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  {session.completion_pct > 0 && (
                    <div style={{ width: '100%', height: 3, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ width: `${session.completion_pct}%`, height: '100%', background: 'var(--accent)', borderRadius: 2 }} />
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className={s.sidebarActions}>
          <Button variant="primary" size="sm" style={{ flex: 1 }} onClick={handleNewSession} disabled={creatingSession}>
            {creatingSession ? '创建中…' : '✦ 新建投放计划'}
          </Button>
        </div>
      </div>
    </div>

    {/* Lightbox overlay */}
    {lightboxUrl && (
      <div
        onClick={() => setLightboxUrl(null)}
        style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out' }}
      >
        <img src={lightboxUrl} alt="" style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain', borderRadius: 8 }} />
      </div>
    )}
    </>
  );
}

// ─── Attribution Tab ─────────────────────────────────────────────
