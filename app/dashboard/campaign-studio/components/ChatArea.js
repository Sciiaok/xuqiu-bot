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

  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const textareaRef = useRef(null);
  const abortRef = useRef(null);
  const isNearBottomRef = useRef(true);
  const phaseLabels = {
    intake: t('phases.intake'),
    research: t('phases.research'),
    strategy: t('phases.strategy'),
    creative_reference: t('phases.creativeReference'),
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
        const [briefRes, orchRes] = await Promise.all([
          fetch(`/api/campaign/intake/${briefId}`),
          sessionId ? fetch(`/api/campaign/orchestrate/${sessionId}`) : Promise.resolve(null),
        ]);
        if (cancelled) return;

        if (briefRes.ok) {
          const briefData = await briefRes.json();
          if (cancelled) return;
          setBrief(briefData.brief || {});
          setCompletion(briefData.completion || {});
        }

        if (orchRes?.ok) {
          const orchData = await orchRes.json();
          if (cancelled) return;

          setCurrentPhase(orchData.current_phase);

          // Reconstruct messages from phase_results, messages, and tool_result
          const phaseResults = orchData.phase_results || {};
          const reconstructed = [];

          // 1. Show intake conversation (user + assistant messages only)
          const intakeMsgs = orchData.messages
            .filter(m => m.phase === 'intake' && (m.role === 'user' || (m.role === 'assistant' && m.content)))
            .map(m => ({
              id: nextMsgId(),
              type: m.role === 'user' ? 'user' : 'assistant',
              content: m.content,
            }));
          reconstructed.push(...intakeMsgs);

          // 2. Add phase result cards in order
          //    Try phase_results first, fall back to tool_result in messages
          const phaseCards = [
            { phase: 'research',           build: r => ({ type: 'research_complete', report: r, duration: null }) },
            { phase: 'strategy',           build: r => ({ type: 'strategy_complete', plan: r }) },
            { phase: 'creative_reference', build: r => r?.references?.length ? { type: 'creative_reference_complete', references: r.references } : null },
            { phase: 'creative',           build: r => ({ type: 'creative_complete', creatives: r?.assets || r?.creatives || r || [] }) },
            { phase: 'execution',          build: r => ({ type: 'execution_complete', result: r }) },
          ];
          for (const { phase, build } of phaseCards) {
            const result = phaseResults[phase]
              || orchData.messages.find(m => m.phase === phase && m.tool_result && Object.keys(m.tool_result).length > 0)?.tool_result;
            if (result) {
              const msg = build(result);
              if (msg) reconstructed.push({ id: nextMsgId(), ...msg });
            }
          }

          // 3. Add user chat messages (phase=null, non-tool)
          const chatMsgs = orchData.messages
            .filter(m => m.phase === null && m.role !== 'tool')
            .map(m => {
              if (m.role === 'user') return { id: nextMsgId(), type: 'user', content: m.content };
              return { id: nextMsgId(), type: 'assistant', content: m.content };
            });

          // Show status-specific UI
          if (orchData.status === 'awaiting_approval' || orchData.status === 'awaiting_feedback') {
            reconstructed.push({
              id: nextMsgId(),
              type: 'feedback_required',
              message: t('planReadyConfirm'),
              options: [t('confirmExecute'), t('cancel')],
            });
          }

          setMessages([...reconstructed, ...chatMsgs]);
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

  // Send message in intake phase
  async function sendIntakeMessage(userMsg) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let assistantText = '';

    const res = await fetch(`/api/campaign/intake/${briefId}/chat?stream_level=full`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userMsg }),
      signal: controller.signal,
    });

    await consumeSSE(res, (event, data) => {
      switch (event) {
        case 'delta':
          assistantText += data.text;
          updateLastAssistant(assistantText);
          break;
        case 'thinking':
          addMessage({ type: 'thinking', content: data.text });
          break;
        case 'tool_call':
          addMessage({ type: 'tool_call', tool: data.tool, content: JSON.stringify(data.input, null, 2) });
          break;
        case 'tool_result':
          addMessage({ type: 'tool_result', tool: data.tool, content: JSON.stringify(data.result, null, 2) });
          break;
        case 'brief_update':
          setBrief(data.brief);
          setCompletion(data.completion);
          addMessage({ type: 'brief_update', brief: data.brief, completion: data.completion });
          break;
        case 'done':
          if (data.status === 'completed') {
            onSessionUpdate?.();
          }
          break;
        case 'error':
          addMessage({ type: 'error', content: data.message });
          break;
      }
    });
  }

  // Send chat message during orchestration phase
  async function sendOrchestrationChat(userMsg) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    let assistantText = '';

    const endpoint = sessionId
      ? `/api/campaign/orchestrate/${sessionId}`
      : `/api/campaign/orchestrate/${briefId}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: userMsg }),
      signal: controller.signal,
    });

    let shouldStartOrchestration = false;

    await consumeSSE(res, (event, data) => {
      switch (event) {
        case 'delta':
          assistantText += data.text;
          updateLastAssistant(assistantText);
          break;
        case 'trigger_orchestration':
          shouldStartOrchestration = true;
          break;
        case 'done':
          break;
        case 'error':
          addMessage({ type: 'error', content: data.message });
          break;
      }
    });

    // If chat agent triggered a pipeline restart, auto-start orchestration
    if (shouldStartOrchestration) {
      await runOrchestration();
    }
  }

  // Run orchestration pipeline
  async function runOrchestration() {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const endpoint = sessionId
      ? `/api/campaign/orchestrate/${sessionId}`
      : `/api/campaign/orchestrate/${briefId}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    });

    let strategySteps = [
      { label: '预算分配方案', done: false, active: false },
      { label: '关键词规划', done: false, active: false },
      { label: '受众定向方案', done: false, active: false },
      { label: '广告结构生成', done: false, active: false },
    ];
    let strategyStepIndex = 0;

    await consumeSSE(res, (event, data) => {
      switch (event) {
        case 'phase_start':
          setCurrentPhase(data.phase);
          addMessage({
            type: 'phase_start',
            content: phaseLabels[data.phase] || data.phase,
          });
          if (data.phase === 'strategy') {
            strategyStepIndex = 0;
            strategySteps = strategySteps.map((s, i) => ({ ...s, active: i === 0, done: false }));
            addMessage({ type: 'strategy_progress', steps: strategySteps });
          }
          if (data.phase === 'creative') {
            addMessage({ type: 'creative_progress' });
          }
          if (data.phase === 'execution') {
            addMessage({ type: 'execution_progress' });
          }
          break;

        case 'phase_complete':
          if (data.phase === 'research') {
            addMessage({
              type: 'research_complete',
              report: data.result,
              duration: data.duration,
            });
          }
          if (data.phase === 'strategy') {
            setMessages(prev => prev.filter(m => m.type !== 'strategy_progress'));
            addMessage({ type: 'strategy_complete', plan: data.result });
          }
          if (data.phase === 'creative_reference') {
            addMessage({
              type: 'creative_reference_complete',
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

        case 'heartbeat':
          // Advance strategy progress steps based on heartbeat count
          if (data.phase === 'strategy' && strategyStepIndex < strategySteps.length) {
            strategySteps = strategySteps.map((s, i) => ({
              ...s,
              done: i < strategyStepIndex,
              active: i === strategyStepIndex,
            }));
            strategyStepIndex++;
            setMessages(prev => {
              const idx = prev.findIndex(m => m.type === 'strategy_progress');
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = { ...updated[idx], steps: strategySteps };
                return updated;
              }
              return prev;
            });
          }
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

        case 'error':
          addMessage({ type: 'error', content: data.message });
          break;
      }
    });
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

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

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

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
      });

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
                ...(data.phase === 'creative_reference' ? { references: data.result?.references || [] } : {}),
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

  async function handleSend() {
    if (!input.trim() || !briefId || isLoading || isHistoryLoading) return;

    const userMsg = input.trim();
    setInput('');
    isNearBottomRef.current = true; // user just sent, they want to follow the response
    addMessage({ type: 'user', content: userMsg });

    // If brief is already completed, start orchestration instead of intake
    if (sessionStatus === 'brief_completed') {
      handleStartOrchestration();
      return;
    }

    // If in orchestration phase, send through orchestrator chat
    const orchStatuses = ['running', 'awaiting_approval', 'completed', 'failed'];
    if (orchStatuses.includes(sessionStatus) && sessionId) {
      setIsLoading(true);
      try {
        await sendOrchestrationChat(userMsg);
      } catch (err) {
        if (err.name !== 'AbortError') {
          addMessage({ type: 'error', content: err.message });
        }
      } finally {
        setIsLoading(false);
      }
      return;
    }

    setIsLoading(true);

    try {
      await sendIntakeMessage(userMsg);
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
        addMessage({ type: 'error', content: err.message });
      }
    } finally {
      setIsLoading(false);
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
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overscroll-contain px-7 pt-6 pb-28">
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
          <div className="bg-white border border-gray-300 rounded-full px-4 h-12 flex items-center gap-3 shadow-lg focus-within:border-indigo-400 focus-within:shadow-xl focus-within:shadow-indigo-100/40 transition-all">
            <button className="text-gray-400 hover:text-gray-500 transition-colors shrink-0">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 5v14M5 12h14"/>
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
              disabled={isLoading || isHistoryLoading || !input.trim()}
              className="bg-gray-900 text-white w-8 h-8 rounded-full flex items-center justify-center shrink-0 hover:bg-gray-800 disabled:opacity-30 transition-colors"
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
