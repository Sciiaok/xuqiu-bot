'use client';

import { useCallback, useRef, useState } from 'react';
import { consumeSSE } from '../../../../lib/consume-sse';

/**
 * Wrap the Ogilvy SSE endpoint. Owns the in-flight assistant delta text,
 * the running tool progress ({ per-tool counts }), and a single AbortController
 * so a new send cancels any still-streaming prior send.
 *
 * Tool progress model: the Agent may emit multiple tool_call events in one
 * turn (they run concurrently server-side). We track { started, completed }
 * per tool name so the UI can render progress like "生成广告图 2/3…".
 *
 * Intentionally minimal: no SSE reconnect. If the user reloads mid-stream,
 * persisted messages come back via GET, but in-flight delta is lost.
 */
export function useMessageStream({ onUserSaved, onAssistantFinal, onToolResult, onPlanPartial, onError }) {
  const [streamingText, setStreamingText] = useState('');
  // toolProgress: { [toolName]: { started, completed } }. Purged on each turn.
  const [toolProgress, setToolProgress] = useState({});
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef(null);

  const send = useCallback(async (sessionId, message, attachments = []) => {
    if (abortRef.current) abortRef.current.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setStreamingText('');
    setToolProgress({});
    setIsStreaming(true);

    let accText = '';

    const bump = (tool, field) => {
      setToolProgress(prev => {
        const cur = prev[tool] || { started: 0, completed: 0 };
        return { ...prev, [tool]: { ...cur, [field]: cur[field] + 1 } };
      });
    };

    try {
      const res = await fetch(`/api/ogilvy/conversations/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, attachments }),
        signal: abort.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => res.statusText);
        throw new Error(body || `HTTP ${res.status}`);
      }

      await consumeSSE(res, (event, data) => {
        switch (event) {
          case 'user_saved':
            onUserSaved?.(data);
            break;
          case 'delta':
            accText += data.text || '';
            setStreamingText(accText);
            break;
          case 'tool_call':
            bump(data.tool, 'started');
            break;
          case 'plan_partial':
            onPlanPartial?.(data.plan);
            break;
          case 'tool_result':
            bump(data.tool, 'completed');
            onToolResult?.(data);
            // Flush any pre-tool assistant preamble as a final message so the
            // transcript shows it separately from whatever Sonnet says after
            // the tool returns.
            if (accText) {
              onAssistantFinal?.({ content: accText, final: false });
              accText = '';
              setStreamingText('');
            }
            break;
          case 'done':
            if (accText) onAssistantFinal?.({ content: accText, final: true });
            setStreamingText('');
            setToolProgress({});
            setIsStreaming(false);
            break;
          case 'error':
            setStreamingText('');
            setToolProgress({});
            setIsStreaming(false);
            onError?.(new Error(data.message || '发生错误'));
            break;
        }
      });
    } catch (err) {
      if (err.name !== 'AbortError') {
        onError?.(err);
      }
    } finally {
      if (abortRef.current === abort) {
        abortRef.current = null;
        setIsStreaming(false);
        setStreamingText('');
        setToolProgress({});
      }
    }
  }, [onUserSaved, onAssistantFinal, onToolResult, onPlanPartial, onError]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ── Derive a single "status line" for the composer/chat strip ──
  // Pick the most user-relevant tool to summarize (the one still running with
  // the highest concurrency). For generate_ad_creative we display "生成广告图
  // 2/3"; for others just "检索市场信息…".
  const activeTools = Object.entries(toolProgress)
    .filter(([, p]) => p.started > p.completed);
  const toolStatus = activeTools.length === 0
    ? null
    : buildToolStatus(activeTools, toolProgress);

  return { send, stop, streamingText, toolStatus, toolProgress, isStreaming };
}

function buildToolStatus(activeTools, progress) {
  // Prefer to surface generate_ad_creative (the slow one) if present.
  const creative = progress.generate_ad_creative;
  if (creative && creative.started > 0) {
    const total = creative.started;
    const done = creative.completed;
    if (done < total) return { tool: 'generate_ad_creative', label: `生成广告图 ${done}/${total}`, done, total };
  }
  // Fall back to whichever tool is in flight first.
  const [name, p] = activeTools[0];
  const total = p.started;
  const done = p.completed;
  const base = toolLabel(name);
  return { tool: name, label: total > 1 ? `${base} ${done}/${total}` : `${base}…`, done, total };
}

function toolLabel(name) {
  const map = {
    draft_ad_plan: '整理广告计划',
    web_search: '检索市场信息',
    read_webpage: '阅读网页',
    generate_ad_creative: '生成广告图',
    stage_campaigns: 'Meta 创建广告',
    activate_campaigns: '启动投放',
  };
  return map[name] || name;
}
