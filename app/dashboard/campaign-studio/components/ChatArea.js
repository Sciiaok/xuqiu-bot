'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import MessageBubble from './MessageBubble';

let msgIdCounter = 0;
function nextMsgId() { return `msg-${++msgIdCounter}`; }

/**
 * Parse SSE stream and call handler for each event.
 * Respects AbortSignal for cancellation.
 */
async function consumeSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7);
        } else if (line.startsWith('data: ') && eventType) {
          try {
            const data = JSON.parse(line.slice(6));
            onEvent(eventType, data);
          } catch { /* skip malformed */ }
          eventType = null;
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    throw err;
  }
}

export default function ChatArea({ briefId, sessionId, sessionStatus, onSessionUpdate }) {
  const t = useTranslations('campaignStudio');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [brief, setBrief] = useState({});
  const [completion, setCompletion] = useState({});
  const [currentPhase, setCurrentPhase] = useState(null);
  const [pendingImages, setPendingImages] = useState([]); // [{file, preview, uploading, uploaded: {url, storage_path, ...}}]

  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const textareaRef = useRef(null);
  const abortRef = useRef(null);
  const fileInputRef = useRef(null);
  const uploadPromisesRef = useRef(new Map()); // imgId → Promise
  const isNearBottomRef = useRef(true);
  const phaseLabels = {
    intake: t('phases.intake'),
    research: t('phases.research'),
    strategy: t('phases.strategy'),
    creative_plan: t('phases.creativePlan'),
    creative: t('phases.creative'),
    execution: t('phases.execution'),
  };

  // Track whether user is near the bottom of the scroll area
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    function handleScroll() {
      const { scrollTop, scrollHeight, clientHeight } = container;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 80;
    }
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto scroll only when user is near the bottom
  // Use 'instant' right after history loads, 'smooth' for new messages
  const hasLoadedHistoryRef = useRef(false);
  useEffect(() => {
    if (isNearBottomRef.current) {
      const container = scrollContainerRef.current;
      if (!container) return;
      const behavior = hasLoadedHistoryRef.current ? 'smooth' : 'instant';
      container.scrollTo({ top: container.scrollHeight, behavior });
      hasLoadedHistoryRef.current = true;
    }
  }, [messages]);

  // Focus input on session change
  useEffect(() => {
    if (briefId) {
      textareaRef.current?.focus();
    }
  }, [briefId]);

  // Abort in-flight requests on session change
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, [briefId]);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      setPendingImages(prev => {
        prev.forEach(p => { if (p.preview) URL.revokeObjectURL(p.preview); });
        return [];
      });
    };
  }, []);

  // Poll for phase_results changes when session is running but SSE is not active
  const pollingRef = useRef(null);
  const knownPhasesRef = useRef(new Set());

  const PHASE_BUILDERS = [
    { phase: 'research',      build: r => ({ type: 'research_complete', report: r, duration: null }) },
    { phase: 'strategy',      build: r => ({ type: 'strategy_complete', plan: r }) },
    { phase: 'creative_plan', build: r => r?.creative_tasks?.length ? { type: 'creative_plan_complete', creativeTasks: r.creative_tasks, references: r.references || [] } : null },
    { phase: 'creative',      build: r => ({ type: 'creative_complete', creatives: r?.assets || r?.creatives || r || [] }) },
    { phase: 'execution',     build: r => ({ type: 'execution_complete', result: r }) },
  ];

  function startPolling(sid) {
    stopPolling();
    console.log('[poll] start polling session', sid);
    pollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/campaign/orchestrate/${sid}`);
        if (!res.ok) return;
        const data = await res.json();
        const results = data.phase_results || {};

        // Add cards for newly completed phases
        for (const { phase, build } of PHASE_BUILDERS) {
          if (results[phase] && !knownPhasesRef.current.has(phase)) {
            knownPhasesRef.current.add(phase);
            const msg = build(results[phase]);
            if (msg) {
              // Remove phase_running indicator before adding completed card
              setMessages(prev => prev.filter(m => m.type !== 'phase_running'));
              addMessage(msg);
            }
          }
        }

        // Update phase_running indicator if phase changed
        if (data.status === 'running' && data.current_phase) {
          setCurrentPhase(data.current_phase);
          setMessages(prev => {
            const running = prev.find(m => m.type === 'phase_running');
            if (running && running.phase !== data.current_phase) {
              return prev.map(m => m.type === 'phase_running'
                ? { ...m, phase: data.current_phase, content: phaseLabels[data.current_phase] || data.current_phase }
                : m);
            }
            if (!running && !knownPhasesRef.current.has(data.current_phase)) {
              return [...prev, { id: nextMsgId(), type: 'phase_running', phase: data.current_phase, content: phaseLabels[data.current_phase] || data.current_phase }];
            }
            return prev;
          });
        }

        // Session no longer running — stop polling
        if (data.status !== 'running') {
          console.log('[poll] session status changed to', data.status, '— stopping');
          setMessages(prev => prev.filter(m => m.type !== 'phase_running'));
          stopPolling();
          setIsLoading(false);
          onSessionUpdate?.();

          if (data.status === 'awaiting_feedback' || data.status === 'awaiting_approval') {
            // Find feedback message from latest messages
            const feedbackMsg = data.messages
              ?.filter(m => m.role === 'assistant' && m.content)
              .pop();
            addMessage({
              type: 'feedback_required',
              message: feedbackMsg?.content || t('planReadyConfirm'),
              options: [t('confirmExecute'), t('cancel')],
            });
          }
        }
      } catch (err) {
        console.warn('[poll] error:', err.message);
      }
    }, 4000);
  }

  function stopPolling() {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }

  // Cleanup polling on unmount or session change
  useEffect(() => {
    return () => stopPolling();
  }, [briefId, sessionId]);

  // Load existing messages when session changes
  const isLoadingRef = useRef(false);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

  useEffect(() => {
    if (!briefId) {
      setMessages([]);
      setBrief({});
      setCompletion({});
      setCurrentPhase(null);
      setIsHistoryLoading(false);
      return;
    }

    // Skip history reload if orchestration is actively streaming
    if (isLoadingRef.current) return;

    let cancelled = false;

    async function loadHistory() {
      hasLoadedHistoryRef.current = false;
      setIsHistoryLoading(true);
      setMessages([]);
      setBrief({});
      setCompletion({});
      setCurrentPhase(null);

      try {
        const orchEndpoint = sessionId
          ? `/api/campaign/orchestrate/${sessionId}`
          : `/api/campaign/orchestrate/${briefId}`;
        const orchRes = await fetch(orchEndpoint);
        if (cancelled) return;

        if (orchRes?.ok) {
          const orchData = await orchRes.json();
          // Brief data is now included in orchestrate response
          setBrief(orchData.brief || {});
          setCompletion(orchData.completion || {});
          if (cancelled) return;

          setCurrentPhase(orchData.current_phase);

          // Reconstruct messages from phase_results, persisted events, and chat
          const phaseResults = orchData.phase_results || {};
          const reconstructed = [];

          // Build phase result cards keyed by phase (for insertion at phase_complete position)
          const phaseResultBuilders = {
            research:      r => ({ type: 'research_complete', report: r, duration: null }),
            strategy:      r => ({ type: 'strategy_complete', plan: r }),
            creative_plan: r => r?.creative_tasks?.length ? { type: 'creative_plan_complete', creativeTasks: r.creative_tasks, references: r.references || [] } : null,
            creative:      r => ({ type: 'creative_complete', creatives: r?.assets || r?.creatives || r || [] }),
            execution:     r => ({ type: 'execution_complete', result: r }),
          };
          const emittedPhaseResults = new Set();

          // Walk all messages in message_index order (already sorted by API)
          for (const m of orchData.messages) {
            // Intake conversation
            if (m.phase === 'intake' && (m.role === 'user' || (m.role === 'assistant' && m.content))) {
              reconstructed.push({
                id: nextMsgId(),
                type: m.role === 'user' ? 'user' : 'assistant',
                content: m.content,
                ...(m.attachments?.length ? { attachments: m.attachments } : {}),
              });
              continue;
            }

            // Persisted event messages (role='event')
            if (m.role === 'event') {
              switch (m.tool_name) {
                case 'phase_start':
                  reconstructed.push({
                    id: nextMsgId(), type: 'phase_start',
                    content: phaseLabels[m.phase] || m.content,
                  });
                  break;
                case 'phase_complete': {
                  // Insert the rich phase result card from phase_results
                  const builder = phaseResultBuilders[m.phase];
                  const result = phaseResults[m.phase];
                  if (builder && result) {
                    const card = builder(result);
                    if (card) {
                      reconstructed.push({ id: nextMsgId(), ...card });
                      emittedPhaseResults.add(m.phase);
                    }
                  }
                  break;
                }
                case 'phase_error':
                  reconstructed.push({
                    id: nextMsgId(), type: 'error',
                    content: `${phaseLabels[m.phase] || m.phase} ${t('phaseFailed')}: ${m.content}`,
                  });
                  break;
                case 'phase_skipped':
                  reconstructed.push({
                    id: nextMsgId(), type: 'phase_skipped',
                    phase: m.phase, reason: m.content,
                  });
                  break;
                case 'brief_patched':
                  reconstructed.push({
                    id: nextMsgId(), type: 'brief_update',
                    fields: m.tool_result?.fields,
                  });
                  break;
                case 'feedback_required':
                  // Only show if session is still awaiting feedback
                  if (orchData.status === 'awaiting_feedback' || orchData.status === 'awaiting_approval') {
                    reconstructed.push({
                      id: nextMsgId(), type: 'feedback_required',
                      message: m.content,
                      options: m.tool_result?.options || [t('confirmExecute'), t('cancel')],
                    });
                  }
                  break;
              }
              continue;
            }

            // Chat messages (phase=null, non-tool, non-event)
            if (m.phase === null && m.role !== 'tool') {
              if (m.role === 'user') {
                reconstructed.push({
                  id: nextMsgId(), type: 'user', content: m.content,
                  ...(m.attachments?.length ? { attachments: m.attachments } : {}),
                });
              } else if (m.role === 'assistant' && m.content) {
                reconstructed.push({ id: nextMsgId(), type: 'assistant', content: m.content });
              }
              continue;
            }
          }

          // Fallback: emit phase result cards for phases that completed but have no persisted event
          // (backwards compatibility with sessions created before event persistence)
          for (const [phase, builder] of Object.entries(phaseResultBuilders)) {
            if (!emittedPhaseResults.has(phase) && phaseResults[phase]) {
              const result = phaseResults[phase];
              const card = builder(result);
              if (card) reconstructed.push({ id: nextMsgId(), ...card });
            }
          }

          // Sync known phases for polling
          knownPhasesRef.current = new Set(Object.keys(phaseResults));

          // Show status-specific UI
          if (orchData.status === 'running' && orchData.current_phase) {
            reconstructed.push({
              id: nextMsgId(),
              type: 'phase_running',
              phase: orchData.current_phase,
              content: phaseLabels[orchData.current_phase] || orchData.current_phase,
            });
            if (!isLoadingRef.current) {
              startPolling(sessionId);
            }
          }

          setMessages(reconstructed);
        }
      } catch (err) {
        if (!cancelled) console.error('Failed to load history:', err);
      } finally {
        if (!cancelled) {
          setIsHistoryLoading(false);
        }
      }
    }

    loadHistory();
    return () => { cancelled = true; };
  }, [briefId, sessionId]);

  const addMessage = useCallback((msg) => {
    setMessages(prev => [...prev, { id: nextMsgId(), ...msg }]);
  }, []);

  const updateLastAssistant = useCallback((text) => {
    setMessages(prev => {
      const last = prev[prev.length - 1];
      if (last?.type === 'assistant') {
        return [...prev.slice(0, -1), { ...last, content: text }];
      }
      return [...prev, { id: nextMsgId(), type: 'assistant', content: text }];
    });
  }, []);

  // Append a tool step to the nearest thinking_group (may not be the very last msg due to interleaved brief_update etc.)
  const appendToolStep = useCallback((step) => {
    setMessages(prev => {
      for (let i = prev.length - 1; i >= Math.max(0, prev.length - 5); i--) {
        if (prev[i].type === 'thinking_group') {
          const updated = [...prev];
          updated[i] = { ...updated[i], steps: [...updated[i].steps, step] };
          return updated;
        }
      }
      return [...prev, { id: nextMsgId(), type: 'thinking_group', steps: [step] }];
    });
  }, []);

  // Shared fetch + assertOk helper
  async function fetchSSE(endpoint, payload, signal) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
      signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(err || `Server error (${res.status})`);
    }
    return res;
  }

  // Send chat message (intake or orchestration — same endpoint, different event handling)
  async function sendChatMessage(userMsg, attachments) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let assistantText = '';

    const endpoint = sessionId
      ? `/api/campaign/orchestrate/${sessionId}`
      : `/api/campaign/orchestrate/${briefId}`;

    const payload = { message: userMsg };
    if (attachments?.length) payload.attachments = attachments;

    const res = await fetchSSE(endpoint, payload, controller.signal);

    let shouldStartOrchestration = false;

    await consumeSSE(res, (event, data) => {
      switch (event) {
        case 'delta':
          assistantText += data.text;
          updateLastAssistant(assistantText);
          break;
        case 'thinking':
          appendToolStep({ type: 'thinking', tool: null, content: data.text });
          break;
        case 'tool_call':
          appendToolStep({ type: 'tool_call', tool: data.tool, content: JSON.stringify(data.input, null, 2) });
          break;
        case 'tool_result':
          appendToolStep({ type: 'tool_result', tool: data.tool, content: JSON.stringify(data.result, null, 2) });
          break;
        case 'brief_update':
          if (data.brief) setBrief(data.brief);
          if (data.completion) setCompletion(data.completion);
          if (data.show_card) {
            addMessage({ type: 'brief_update', brief: data.brief, completion: data.completion });
          }
          break;
        case 'trigger_orchestration':
          shouldStartOrchestration = true;
          break;
        case 'done':
          onSessionUpdate?.();
          break;
        case 'error':
          addMessage({ type: 'error', content: data.message });
          break;
      }
    });

    if (shouldStartOrchestration) {
      await runOrchestration();
    }
  }

  // Run orchestration pipeline
  async function runOrchestration() {
    abortRef.current?.abort();
    stopPolling();
    const controller = new AbortController();
    abortRef.current = controller;

    const endpoint = sessionId
      ? `/api/campaign/orchestrate/${sessionId}`
      : `/api/campaign/orchestrate/${briefId}`;

    const res = await fetchSSE(endpoint, {}, controller.signal);

    let receivedDone = false;
    await consumeSSE(res, (event, data) => {
      switch (event) {
        case 'phase_start':
          setCurrentPhase(data.phase);
          addMessage({
            type: 'phase_start',
            content: phaseLabels[data.phase] || data.phase,
          });
          // Start a fresh thinking_group so progress events attach to the correct phase
          addMessage({ id: nextMsgId(), type: 'thinking_group', steps: [] });
          if (data.phase === 'creative') {
            addMessage({ type: 'creative_progress' });
          }
          if (data.phase === 'execution') {
            addMessage({ type: 'execution_progress' });
          }
          break;

        case 'phase_complete':
          knownPhasesRef.current.add(data.phase);
          if (data.phase === 'research') {
            addMessage({
              type: 'research_complete',
              report: data.result,
              duration: data.duration,
            });
          }
          if (data.phase === 'strategy') {
            addMessage({ type: 'strategy_complete', plan: data.result });
          }
          if (data.phase === 'creative_plan') {
            addMessage({
              type: 'creative_plan_complete',
              creativeTasks: data.result?.creative_tasks || [],
              references: data.result?.references || [],
            });
          }
          if (data.phase === 'creative') {
            setMessages(prev => prev.filter(m => m.type !== 'creative_progress'));
            addMessage({
              type: 'creative_complete',
              creatives: data.result?.assets || data.result?.creatives || data.result || [],
            });
          }
          if (data.phase === 'execution') {
            setMessages(prev => prev.filter(m => m.type !== 'execution_progress'));
            addMessage({ type: 'execution_complete', result: data.result });
          }
          onSessionUpdate?.();
          break;

        case 'phase_progress':
          appendToolStep({
            type: 'progress',
            tool: data.step,
            content: data.detail || data.step,
          });
          break;

        case 'heartbeat':
          break;

        case 'approval_required':
          setMessages(prev => prev.filter(m => m.type !== 'execution_progress'));
          addMessage({
            type: 'execution_approval',
            plan: data.plan,
          });
          onSessionUpdate?.();
          break;

        case 'feedback_required':
          receivedDone = true;
          setIsLoading(false);
          addMessage({
            type: 'feedback_required',
            message: data.message,
            options: data.options,
          });
          onSessionUpdate?.();
          break;

        case 'phase_skipped':
          addMessage({
            type: 'phase_skipped',
            phase: data.phase,
            reason: data.reason,
          });
          break;

        case 'phase_error':
          addMessage({ type: 'error', content: `${phaseLabels[data.phase] || data.phase} ${t('phaseFailed')}: ${data.error}` });
          onSessionUpdate?.();
          break;

        case 'done':
          receivedDone = true;
          onSessionUpdate?.();
          break;

        case 'error':
          receivedDone = true;
          addMessage({ type: 'error', content: data.message });
          break;
      }
    });

    // SSE ended without a terminal event — server may still be running, fall back to polling
    if (!receivedDone && (sessionId || briefId)) {
      console.log('[sse] stream ended without done/error — starting poll fallback');
      addMessage({
        type: 'phase_running',
        phase: currentPhase || 'unknown',
        content: phaseLabels[currentPhase] || '处理中',
      });
      startPolling(sessionId || briefId);
    }
  }

  // Approve execution
  async function handleApprove() {
    setIsLoading(true);
    try {
      setMessages(prev => prev.filter(m => m.type !== 'execution_approval'));
      addMessage({ type: 'execution_progress' });

      const endpoint = sessionId
        ? `/api/campaign/orchestrate/${sessionId}/approve`
        : `/api/campaign/orchestrate/${briefId}/approve`;

      const res = await fetchSSE(endpoint, undefined, undefined);

      await consumeSSE(res, (event, data) => {
        if (event === 'phase_complete' && data.phase === 'execution') {
          setMessages(prev => prev.filter(m => m.type !== 'execution_progress'));
          addMessage({ type: 'execution_complete', result: data.result });
          onSessionUpdate?.();
        }
        if (event === 'error') {
          addMessage({ type: 'error', content: data.message });
        }
      });
    } finally {
      setIsLoading(false);
    }
  }

  function handleReject() {
    setMessages(prev => prev.filter(m => m.type !== 'execution_approval'));
    addMessage({ type: 'assistant', content: t('executionCancelled') });
  }

  async function handleFeedbackRespond(response) {
    setIsLoading(true);
    try {
      setMessages(prev => prev.filter(m => m.type !== 'feedback_required'));

      const endpoint = sessionId
        ? `/api/campaign/orchestrate/${sessionId}/feedback`
        : `/api/campaign/orchestrate/${briefId}/feedback`;

      const res = await fetchSSE(endpoint, { response });

      // Reuse the runOrchestration SSE handler pattern
      await consumeSSE(res, (event, data) => {
        switch (event) {
          case 'phase_start':
            setCurrentPhase(data.phase);
            addMessage({
              type: 'phase_start',
              content: phaseLabels[data.phase] || data.phase,
            });
            break;
          case 'phase_complete':
            if (data.phase === 'execution') {
              addMessage({ type: 'execution_complete', result: data.result });
            } else {
              addMessage({
                type: `${data.phase}_complete`,
                ...(data.phase === 'research' ? { report: data.result, duration: data.duration } : {}),
                ...(data.phase === 'strategy' ? { plan: data.result } : {}),
                ...(data.phase === 'creative_plan' ? { creativeTasks: data.result?.creative_tasks || [], references: data.result?.references || [] } : {}),
                ...(data.phase === 'creative' ? { creatives: data.result?.assets || data.result?.creatives || data.result || [] } : {}),
              });
            }
            onSessionUpdate?.();
            break;
          case 'feedback_required':
            setIsLoading(false);
            addMessage({
              type: 'feedback_required',
              message: data.message,
              options: data.options,
            });
            onSessionUpdate?.();
            break;
          case 'phase_skipped':
            addMessage({ type: 'phase_skipped', phase: data.phase, reason: data.reason });
            break;
          case 'done':
            onSessionUpdate?.();
            break;
          case 'error':
            addMessage({ type: 'error', content: data.message });
            break;
        }
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        addMessage({ type: 'error', content: err.message });
      }
    } finally {
      setIsLoading(false);
    }
  }

  // Compress image on the client to avoid 413 server limits
  function compressImage(file, maxDim = 1920, quality = 0.85) {
    return new Promise((resolve) => {
      // Skip non-compressible or small files
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

  // Image upload handlers
  function handleImageSelect(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    // Reset input so same file can be re-selected
    e.target.value = '';

    const newImages = files.map(file => ({
      id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      file,
      preview: URL.createObjectURL(file),
      uploading: true,
      uploaded: null,
    }));
    setPendingImages(prev => [...prev, ...newImages]);

    // Upload each file, track promises
    for (const img of newImages) {
      const promise = uploadImage(img);
      uploadPromisesRef.current.set(img.id, promise);
      promise.finally(() => uploadPromisesRef.current.delete(img.id));
    }
  }

  async function uploadImage(img) {
    try {
      const compressed = await compressImage(img.file);
      const formData = new FormData();
      formData.append('file', compressed);
      if (sessionId) formData.append('session_id', sessionId);
      else if (briefId) formData.append('session_id', briefId);

      const res = await fetch('/api/campaign/upload', { method: 'POST', body: formData });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Upload failed');
      }
      const result = await res.json();
      setPendingImages(prev => prev.map(p =>
        p.id === img.id ? { ...p, uploading: false, uploaded: result } : p
      ));
    } catch (err) {
      console.error('Upload failed:', err);
      // Remove failed image from pending
      setPendingImages(prev => prev.filter(p => p.id !== img.id));
    }
  }

  function removeImage(imgId) {
    setPendingImages(prev => {
      const img = prev.find(p => p.id === imgId);
      if (img?.preview) URL.revokeObjectURL(img.preview);
      return prev.filter(p => p.id !== imgId);
    });
  }

  async function handleSend() {
    const hasImages = pendingImages.length > 0;
    if ((!input.trim() && !hasImages) || !briefId || isLoading || isHistoryLoading) return;

    // Wait for any in-progress uploads to finish
    const pending = [...uploadPromisesRef.current.values()];
    if (pending.length > 0) {
      await Promise.all(pending);
    }

    // Re-read state after awaiting (uploads may have finished updating state)
    const currentImages = await new Promise(resolve =>
      setPendingImages(prev => { resolve(prev); return prev; })
    );
    const userMsg = input.trim();
    const attachments = currentImages
      .filter(p => p.uploaded)
      .map(p => p.uploaded);
    if (!userMsg && !attachments.length) return; // nothing to send after upload failures
    setInput('');
    // Revoke object URLs
    currentImages.forEach(p => { if (p.preview) URL.revokeObjectURL(p.preview); });
    setPendingImages([]);
    isNearBottomRef.current = true; // user just sent, they want to follow the response
    addMessage({
      type: 'user',
      content: userMsg,
      attachments: attachments.length ? attachments : undefined,
    });

    // If awaiting feedback, treat user input as feedback response to resume the pipeline
    if (sessionStatus === 'awaiting_feedback' && sessionId) {
      await handleFeedbackRespond(userMsg);
      return;
    }

    setIsLoading(true);
    try {
      await sendChatMessage(userMsg, attachments);
    } catch (err) {
      if (err.name !== 'AbortError') {
        addMessage({ type: 'error', content: err.message });
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function handleStartOrchestration() {
    setIsLoading(true);
    try {
      await runOrchestration();
    } catch (err) {
      if (err.name !== 'AbortError') {
        // Network error mid-stream — fall back to polling
        console.log('[sse] orchestration fetch error, starting poll fallback:', err.message);
        startPolling(sessionId || briefId);
      }
    } finally {
      // Only clear loading if polling didn't take over
      if (!pollingRef.current) {
        setIsLoading(false);
      }
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleInputChange(e) {
    setInput(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  if (!briefId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="text-6xl mb-4 opacity-20">💬</div>
          <div className="text-gray-400 text-sm">{t('selectOrCreate')}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 min-h-0 flex-col overflow-hidden bg-gray-50">
      {/* Messages — full height scrollable area with bottom padding for floating input */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-7 pt-6 pb-28">
        {isHistoryLoading ? (
          <div className="mx-auto flex min-h-full max-w-3xl items-center justify-center py-16">
            <div className="flex items-center gap-3 rounded-2xl border border-gray-200 bg-white px-5 py-4 text-sm text-gray-500 shadow-sm">
              <div className="flex gap-1.5">
                <div className="h-2.5 w-2.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="h-2.5 w-2.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '120ms' }} />
                <div className="h-2.5 w-2.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '240ms' }} />
              </div>
              <span>{t('loadingConversation')}</span>
            </div>
          </div>
        ) : (
        <div className="max-w-3xl mx-auto space-y-5">
          {messages.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              onApprove={handleApprove}
              onReject={handleReject}
              onFeedbackRespond={handleFeedbackRespond}
              onStartOrchestration={handleStartOrchestration}
              isLoading={isLoading}
            />
          ))}

          {isLoading && messages[messages.length - 1]?.type !== 'assistant' && (
            <div className="flex gap-2.5">
              <div className="w-8 h-8 rounded-[10px] bg-gradient-to-br from-indigo-600 to-purple-600 flex items-center justify-center flex-shrink-0 text-white text-xs font-bold">
                AI
              </div>
              <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-sm">
                <div className="flex gap-1.5">
                  <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-2 h-2 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
        )}
      </div>

      {/* Floating input — sticky within the chat panel */}
      <div
        className="sticky bottom-0 z-10 shrink-0 px-7 pb-4 pt-6"
        style={{ background: 'linear-gradient(to bottom, transparent 0%, rgb(249 250 251 / 0.85) 35%, rgb(249 250 251) 100%)' }}
      >
        <div className="max-w-3xl mx-auto">
          {/* Image previews */}
          {pendingImages.length > 0 && (
            <div className="flex gap-2 mb-2 flex-wrap" data-testid="image-preview-bar">
              {pendingImages.map(img => (
                <div key={img.id} className="relative w-16 h-16 rounded-lg overflow-hidden border border-gray-200 bg-gray-100 group">
                  <img src={img.preview} alt="" className="w-full h-full object-cover" />
                  {img.uploading && (
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    </div>
                  )}
                  <button
                    onClick={() => removeImage(img.id)}
                    className="absolute top-0.5 right-0.5 w-4 h-4 bg-black/60 text-white rounded-full flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                    data-testid="remove-image"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="bg-white border border-gray-300 rounded-full px-4 h-12 flex items-center gap-3 shadow-lg focus-within:border-indigo-400 focus-within:shadow-xl focus-within:shadow-indigo-100/40 transition-all">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={handleImageSelect}
              data-testid="image-file-input"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isLoading || isHistoryLoading}
              className="text-gray-400 hover:text-gray-500 transition-colors shrink-0 disabled:opacity-30"
              title={t('uploadImage')}
              data-testid="image-upload-btn"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <path d="m21 15-5-5L5 21"/>
              </svg>
            </button>
            <input
              ref={textareaRef}
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isLoading || isHistoryLoading}
              placeholder={t('inputPlaceholder')}
              className="flex-1 bg-transparent border-none outline-none text-[14px] text-gray-700 h-full"
            />
            <button
              onClick={handleSend}
              disabled={isLoading || isHistoryLoading || (!input.trim() && !pendingImages.some(p => p.uploaded))}
              className="bg-gray-900 text-white w-8 h-8 rounded-full flex items-center justify-center shrink-0 hover:bg-gray-800 disabled:opacity-30 transition-colors"
              data-testid="send-btn"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M5 12h14M12 5l7 7-7 7"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
