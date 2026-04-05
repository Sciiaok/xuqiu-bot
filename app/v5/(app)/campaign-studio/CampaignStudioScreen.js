'use client';

import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import s from './page.module.css';
import MetricCard from '../../components/MetricCard/MetricCard';
import AIPanel from '../../components/AIPanel/AIPanel';
import Card from '../../components/Card/Card';
import TabBar from '../../components/TabBar/TabBar';
import Button from '../../components/Button/Button';
import Tag from '../../components/Tag/Tag';
import { createClient } from '../../../../lib/supabase-browser';
import Markdown from '../../components/Markdown/Markdown';
import {
  ResearchCard, StrategyCard, CreativePlanCard, CreativeCard,
  ExecutionCard, FeedbackCard, PhaseDivider,
} from '../../components/PhaseCards/PhaseCards';
import { ResearchCardV2 } from '../../components/PhaseCards/ResearchCardV2';

// ─── Tab definitions ──────────────────────────────────────────────
const MAIN_TABS = [
  { key: 'list', label: '📊 广告计划列表' },
  { key: 'ai', label: '✦ AI 自动化投放' },
  { key: 'attribution', label: '🎯 深度归因分析' },
];


// ─── Spark Bars ──────────────────────────────────────────────────
function SparkBars({ data, color = 'var(--accent)' }) {
  const max = Math.max(...data, 1);
  return (
    <div className={s.spark}>
      {data.map((v, i) => (
        <div
          key={i}
          className={s.sparkBar}
          style={{ height: `${Math.round((v / max) * 20)}px`, background: color }}
        />
      ))}
    </div>
  );
}

// ─── Score Ring ──────────────────────────────────────────────────
function ScoreRing({ score, color }) {
  const r = 22;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  const colorMap = {
    green: 'var(--green)',
    amber: 'var(--amber)',
    accent: 'var(--accent)',
    red: 'var(--red)',
    teal: 'var(--teal)',
  };
  const strokeColor = colorMap[color] || 'var(--accent)';
  return (
    <svg className={s.scoreRing} width="56" height="56" viewBox="0 0 56 56">
      <circle cx="28" cy="28" r={r} fill="none" stroke="var(--border)" strokeWidth="4" />
      <circle
        cx="28" cy="28" r={r} fill="none"
        stroke={strokeColor} strokeWidth="4"
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 28 28)"
      />
      <text x="28" y="33" textAnchor="middle" fontSize="13" fontWeight="700" fill={strokeColor} fontFamily="var(--font-mono)">
        {score}
      </text>
    </svg>
  );
}

// ─── Ad Row (real data) ──────────────────────────────────────────
function AdRow({ ad, isExpanded, onToggle, metricsMap }) {
  const m = metricsMap?.get(ad.metaAdId);
  // Derive verdict color based on proofConversationRate
  const rate = ad.proofConversationRate || 0;
  let verdictColor = 'amber';
  let verdict = '表现正常';
  let score = 50;
  if (rate >= 80) { verdictColor = 'green'; verdict = '表现最佳'; score = Math.min(95, 70 + rate); }
  else if (rate >= 60) { verdictColor = 'teal'; verdict = '稳定运行'; score = 60 + Math.round(rate / 5); }
  else if (rate >= 40) { verdictColor = 'amber'; verdict = '表现正常'; score = 40 + Math.round(rate / 4); }
  else { verdictColor = 'red'; verdict = '需要关注'; score = Math.max(10, rate); }

  const verdictClass = {
    green: s.verdictGreen,
    amber: s.verdictAmber,
    accent: s.verdictAccent,
    teal: s.verdictTeal,
    red: s.verdictRed,
  }[verdictColor] || '';

  const sparkColorMap = {
    green: 'var(--green)',
    amber: 'var(--amber)',
    accent: 'var(--accent)',
    teal: 'var(--teal)',
    red: 'var(--red)',
  };
  const sparkColor = sparkColorMap[verdictColor] || 'var(--accent)';

  // Build spark from last 7 days of dailyConversations
  const sparkData = (ad.dailyConversations || [])
    .slice(-7)
    .map(d => d.count);
  const hasSparkData = sparkData.some(v => v > 0);

  return (
    <>
      <tr
        className={`${s.adRow} ${isExpanded ? s.adRowExpanded : ''}`}
        onClick={onToggle}
      >
        <td className={s.adThumb}>💬</td>
        <td className={s.adName}>
          <div className={s.adNameMain}>{ad.metaAdId}</div>
          <div className={s.adId}>Meta 广告 ID</div>
        </td>
        <td className={s.adNum}>{m ? `$${m.spend.toLocaleString()}` : '—'}</td>
        <td className={s.adNum}>{m ? m.impressions.toLocaleString() : '—'}</td>
        <td className={s.adNum}>{m ? `${m.ctr}%` : '—'}</td>
        <td className={s.adNum}>{ad.conversationCount.toLocaleString()}</td>
        <td className={s.adNum}>{m && ad.conversationCount > 0 ? `$${(m.spend / ad.conversationCount).toFixed(2)}` : '—'}</td>
        <td className={s.adNum}>
          <span className={s.proofBadge}>{ad.proofConversationRate}%</span>
        </td>
        <td className={s.adSparkCell}>
          {hasSparkData
            ? <SparkBars data={sparkData} color={sparkColor} />
            : <span style={{ color: 'var(--text3)', fontSize: '11px' }}>—</span>}
        </td>
        <td className={s.adArrowCell}>
          <span className={`${s.arrow} ${isExpanded ? s.arrowOpen : ''}`}>›</span>
        </td>
      </tr>
      {isExpanded && (
        <tr className={s.adDetailRow}>
          <td colSpan={10}>
            <div className={s.adDetail}>
              {/* Creative preview */}
              <div className={s.detailCreative}>
                <div className={s.creativePlaceholder}>
                  <span className={s.creativeEmoji}>💬</span>
                  <span className={s.creativeLabel}>素材预览</span>
                </div>
                <div className={`${s.verdictBadge} ${verdictClass}`}>{verdict}</div>
              </div>

              {/* Metrics grid */}
              <div className={s.detailMetrics}>
                <div className={s.metricsGrid}>
                  {[
                    ['WA 对话', ad.conversationCount.toLocaleString()],
                    ['中质量对话', ad.qualifyConversationCount.toLocaleString()],
                    ['高质量对话', ad.proofConversationCount.toLocaleString()],
                    ['中质量率', `${ad.qualifyConversationRate}%`],
                    ['高质量率', `${ad.proofConversationRate}%`],
                    ['最近对话', ad.lastConversationAt ? ad.lastConversationAt.split('T')[0] : '—'],
                    ['花费', m ? `$${m.spend.toLocaleString()}` : '—'],
                    ['展示', m ? m.impressions.toLocaleString() : '—'],
                  ].map(([label, val]) => (
                    <div key={label} className={s.metricBox}>
                      <div className={s.metricBoxLabel}>{label}</div>
                      <div className={s.metricBoxValue}>{val}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* AI eval placeholder */}
              <div className={s.detailAI}>
                <div className={s.aiEvalHead}>
                  <ScoreRing score={score} color={verdictColor} />
                  <div className={s.aiEvalText}>
                    <div className={s.aiEvalTitle}>AI 评估</div>
                    <div className={s.aiEvalBody}>
                      高质量率 {ad.proofConversationRate}%，中质量率 {ad.qualifyConversationRate}%。
                      共产生 {ad.conversationCount} 条 WA 对话，其中 {ad.proofConversationCount} 条达到高质量。
                      创意预览与深度 AI 评估需接入 Meta API 后启用。
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Day Card (real data) ────────────────────────────────────────
function DayCard({ day, defaultExpanded, metricsMap, dailyMetrics }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [expandedAd, setExpandedAd] = useState(null);

  useEffect(() => {
    if (defaultExpanded && day.ads.length > 0) {
      setExpandedAd(day.ads[0].metaAdId);
    }
  }, [defaultExpanded, day.ads]);

  const toggleAd = (id) => setExpandedAd(prev => prev === id ? null : id);
  const statusClass = day.isToday ? s.statusGreen : s.statusNeutral;
  const statusLabel = day.isToday ? '投放中' : '已完成';

  // Compute day-level spend/impressions from dailyMetrics (per-day breakdown)
  let daySpend = null;
  let dayImpressions = null;
  if (dailyMetrics) {
    daySpend = 0;
    dayImpressions = 0;
    for (const ad of day.ads) {
      const m = dailyMetrics[ad.metaAdId];
      if (m) {
        daySpend += m.spend;
        dayImpressions += m.impressions;
      }
    }
  }

  return (
    <div className={`${s.dayCard} ${expanded ? s.dayCardOpen : ''}`}>
      <div className={s.dayHeader} onClick={() => setExpanded(v => !v)}>
        <div className={s.dayLeft}>
          <span className={`${s.arrow} ${expanded ? s.arrowOpen : ''}`}>›</span>
          <span className={s.dayDate}>{day.date}{day.isToday ? ' (今日)' : ''}</span>
          <span className={`${s.statusBadge} ${statusClass}`}>{statusLabel}</span>
        </div>
        <div className={s.dayMetrics}>
          <span className={s.dayMetric}><span className={s.dayMetricLabel}>花费</span>{daySpend !== null ? `$${daySpend.toLocaleString()}` : '—'}</span>
          <span className={s.dayMetric}><span className={s.dayMetricLabel}>展示</span>{dayImpressions !== null ? dayImpressions.toLocaleString() : '—'}</span>
          <span className={s.dayMetric}><span className={s.dayMetricLabel}>对话</span>{day.totalConversations.toLocaleString()}</span>
          <span className={s.dayMetric}><span className={s.dayMetricLabel}>CPA</span>{daySpend !== null && day.totalConversations > 0 ? `$${(daySpend / day.totalConversations).toFixed(2)}` : '—'}</span>
        </div>
      </div>

      {expanded && day.ads.length > 0 && (
        <div className={s.dayBody}>
          <AIPanel title="当日广告总结" tag="自动分析">
            <p>
              当日共 {day.ads.length} 个广告产生 {day.totalConversations.toLocaleString()} 条 WA 对话。
              {daySpend !== null ? `总花费 $${daySpend.toLocaleString()}，展示 ${(dayImpressions || 0).toLocaleString()} 次。` : '花费数据需配置 Meta API Token 后展示。'}
            </p>
          </AIPanel>

          <div className={s.adTableWrap}>
            <table className={s.adTable}>
              <thead>
                <tr>
                  <th></th>
                  <th className={s.thName}>广告 ID</th>
                  <th className={s.thNum}>花费</th>
                  <th className={s.thNum}>展示</th>
                  <th className={s.thNum}>CTR</th>
                  <th className={s.thNum}>对话</th>
                  <th className={s.thNum}>CPA</th>
                  <th className={s.thNum}>高质量询盘</th>
                  <th className={s.thNum}>趋势</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {day.ads.map(ad => (
                  <AdRow
                    key={ad.metaAdId}
                    ad={ad}
                    isExpanded={expandedAd === ad.metaAdId}
                    onToggle={() => toggleAd(ad.metaAdId)}
                    metricsMap={metricsMap}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {expanded && day.ads.length === 0 && (
        <div className={s.dayBody} style={{ padding: '16px', color: 'var(--text3)', fontSize: '13px' }}>
          当日暂无广告对话数据
        </div>
      )}
    </div>
  );
}

// ─── List Tab ────────────────────────────────────────────────────
function ListTab({ days, loading, metricsMap, dailyMetricsMap }) {
  if (loading) {
    return (
      <div className={s.dayList} style={{ padding: '40px', textAlign: 'center', color: 'var(--text3)' }}>
        加载广告数据中…
      </div>
    );
  }

  if (!days || days.length === 0) {
    return (
      <div className={s.dayList} style={{ padding: '40px', textAlign: 'center', color: 'var(--text3)' }}>
        暂无广告数据
      </div>
    );
  }

  return (
    <div className={s.dayList}>
      {days.map((day, i) => (
        <DayCard key={day.date} day={day} defaultExpanded={i === 0} metricsMap={metricsMap} dailyMetrics={dailyMetricsMap[day.date]} />
      ))}
    </div>
  );
}

// ─── Phase result card builders (structured, not markdown) ──────
const phaseResultBuilders = {
  research:      r => ({ type: 'research_complete', report: r, duration: null }),
  strategy:      r => ({ type: 'strategy_complete', plan: r }),
  creative_plan: r => r?.creative_tasks?.length ? { type: 'creative_plan_complete', creativeTasks: r.creative_tasks, references: r.references || [] } : null,
  creative:      r => ({ type: 'creative_complete', creatives: r?.assets || r?.creatives || r || [] }),
  execution:     r => ({ type: 'execution_complete', result: r }),
};

// ─── Chat Tab ────────────────────────────────────────────────────
const PHASE_LABELS = {
  intake: '需求收集',
  research: '市场调研',
  strategy: '投放策略',
  creative_plan: '创意规划',
  creative: '素材生成',
  execution: '执行发布',
};

const STATUS_LABELS = {
  intake: '需求收集中',
  brief_completed: '简报已完成',
  research: '调研中',
  strategy: '制定策略',
  creative_plan: '规划创意',
  creative: '生成素材',
  execution: '执行中',
  completed: '已完成',
  draft: '草稿',
};

/**
 * Group orchestrator messages: user msgs and assistant msgs with content stay as-is.
 * Consecutive empty/tool/thinking assistant msgs get collapsed into a "thinking group".
 */
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

function ChatTab({ workspaceMode = false }) {
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
  useEffect(() => { streamingStepsRef.current = streamingSteps; }, [streamingSteps]);
  useEffect(() => { selectedSessionRef.current = selectedSession; }, [selectedSession]);
  useEffect(() => { pendingImagesRef.current = pendingImages; }, [pendingImages]);
  useEffect(() => {
    return () => { pendingImagesRef.current.forEach(p => p.preview && URL.revokeObjectURL(p.preview)); };
  }, []);

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
        const meaningful = next.filter(s => s.tool || s.phase || (s.content && s.content.trim()));
        if (meaningful.length > 0) {
          setMessages(msgs => [...msgs, { id: `tg-${Date.now()}`, type: 'thinking', steps: meaningful }]);
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
    // Only persist steps that have meaningful content (tool name, phase, or non-empty content)
    const meaningful = steps.filter(s => s.tool || s.phase || (s.content && s.content.trim()));
    if (meaningful.length > 0) {
      setMessages(prev => [...prev, { id: `tg-${Date.now()}`, type: 'thinking', steps: [...meaningful] }]);
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
    async function fetchMessages() {
      setLoadingMessages(true);
      try {
        const res = await fetch(`/api/campaign/orchestrate/${selectedSession.session_id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    const { consumeSSE } = await import('../../../../lib/consume-sse');

    const handleEvent = (event, data, eventId) => {
      if (eventId) saveLastEventId(sessionId, eventId);
      if (!isActiveSessionKey(sessionKey)) return;
      switch (event) {
        case 'delta':
          assistantText += data.text;
          setStreamingTextForSession(sessionKey, assistantText);
          break;
        case 'thinking':
          pushStreamingStepForSession(sessionKey, { tool: null, content: data.text, phase: null });
          break;
        case 'tool_start':
          pushStreamingStepForSession(sessionKey, { tool: data.tool, content: '', phase: null });
          break;
        case 'tool_call':
          pushStreamingStepForSession(sessionKey, { tool: data.tool, content: JSON.stringify(data.input, null, 2).slice(0, 200), phase: null });
          break;
        case 'tool_result':
          pushStreamingStepForSession(sessionKey, { tool: data.tool, content: JSON.stringify(data.result, null, 2).slice(0, 200), phase: null });
          break;
        case 'orchestration_start':
          if (assistantText) {
            appendMessageForSession(sessionKey, { id: `ai-${Date.now()}`, type: 'assistant', content: assistantText });
            setStreamingTextForSession(sessionKey, '');
            assistantText = '';
          }
          flushStreamingSteps(sessionKey);
          pushStreamingStepForSession(sessionKey, { tool: null, content: '▶ 投放流程启动' });
          updateSessionStatus(sessionKey, { status: 'running', current_phase: 'orchestrating' });
          break;
        case 'phase_start':
          pushStreamingStepForSession(sessionKey, { tool: null, content: `▶ ${PHASE_LABELS[data.phase] || data.phase}`, phase: data.phase });
          updateSessionStatus(sessionKey, { current_phase: data.phase });
          break;
        case 'phase_progress':
          pushStreamingStepForSession(sessionKey, { tool: data.step, content: data.detail || data.step, phase: data.phase });
          break;
        case 'phase_complete': {
          pushStreamingStepForSession(sessionKey, { tool: null, content: `✓ ${PHASE_LABELS[data.phase] || data.phase} 完成`, phase: data.phase });
          // Flush accumulated thinking steps BEFORE appending the result card,
          // so the card always appears after the thinking group in the message list.
          flushStreamingSteps(sessionKey);
          const builder = phaseResultBuilders[data.phase];
          if (builder && data.result) {
            const card = builder(data.result);
            if (card) appendMessageForSession(sessionKey, { id: `phase-${data.phase}-${Date.now()}`, ...card });
          }
          break;
        }
        case 'approval_required':
          appendMessageForSession(sessionKey, { id: `approval-${Date.now()}`, type: 'execution_approval', plan: data.plan, status: 'awaiting_approval' });
          updateSessionStatus(sessionKey, { status: 'awaiting_approval' });
          break;
        case 'feedback_required':
          flushStreamingSteps(sessionKey);
          appendMessageForSession(sessionKey, { id: `fb-${Date.now()}`, type: 'feedback_required', message: data.message || '需要您的确认', options: data.options || [] });
          updateSessionStatus(sessionKey, { status: 'awaiting_feedback' });
          break;
        case 'user_injected':
          break;
        case 'phase_error':
          appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: `${PHASE_LABELS[data.phase] || data.phase} 失败: ${data.error}` });
          break;
        case 'error':
          appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: data.message || '发生错误' });
          streamDone = true;
          break;
        case 'done':
          // Flush any pending streaming text so the cursor stops
          if (assistantText) {
            appendMessageForSession(sessionKey, { id: `ai-${Date.now()}`, type: 'assistant', content: assistantText });
            assistantText = '';
          }
          setStreamingTextForSession(sessionKey, '');
          flushStreamingSteps(sessionKey);
          if (data.phases_completed?.length) {
            appendMessageForSession(sessionKey, { id: `done-${Date.now()}`, type: 'assistant', content: `投放方案已完成！共执行 ${data.phases_completed.length} 个阶段：${data.phases_completed.join(' → ')}` });
            updateSessionStatus(sessionKey, { status: 'completed', current_phase: 'done' });
          }
          streamDone = true;
          break;
      }
    };

    const streamUrl = `/api/campaign/orchestrate/${baseId}/stream?lastEventId=${encodeURIComponent(startEventId)}`;
    try {
      const streamRes = await fetch(streamUrl, { signal: abortController.signal });
      if (streamRes.ok) {
        await consumeSSE(streamRes, handleEvent);
      }
    } catch (err) {
      if (err.name === 'AbortError' || abortController.signal.aborted) return;
      console.warn('Stream connection failed:', err.message);
    } finally {
      // Only clear active flag if this connection is still the current one.
      // A newer connectToStream() may have already replaced streamAbortRef.
      if (streamAbortRef.current === abortController) {
        streamActiveRef.current = false;
      }
    }

    if (assistantText) {
      appendMessageForSession(sessionKey, { id: `ai-${Date.now()}`, type: 'assistant', content: assistantText });
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
    const userMsg = { id: `tmp-${Date.now()}`, type: 'user', content: text, attachments: attachments.length ? attachments : undefined };
    appendMessageForSession(sessionKey, userMsg);
    setStreamingTextForSession(sessionKey, '');
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
          appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: `发送失败: ${err.message}` });
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

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => res.statusText);
        throw new Error(errBody || `Server error (${res.status})`);
      }

      // All paths now return JSON + fire-and-forget; connect to /stream for events
      // Use saved lastEventId to avoid replaying already-seen events from earlier requests
      const startId = loadLastEventId(session.session_id);
      // Don't await — stream reading is a background activity, sendingMsg only covers the POST
      connectToStream(sessionKey, session.session_id, baseId, startId).catch(err => {
        if (err.name !== 'AbortError') console.warn('Stream connection failed:', err.message);
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('Error sending message:', err);
      appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: `发送失败: ${err.message}` });
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
        id: `fb-resp-${Date.now()}`,
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
        appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: `反馈提交失败: ${res.status}` });
        return;
      }
      // Connect to /stream — don't await, stream reading is background
      const fbStartId = loadLastEventId(session.session_id);
      connectToStream(sessionKey, session.session_id, baseId, fbStartId).catch(err => {
        if (err.name !== 'AbortError') console.warn('Stream connection failed:', err.message);
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: err.message });
    } finally {
      setSendingMsg(false);
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

  return (
    <>
    <div className={`${s.chatLayout} ${workspaceMode ? s.chatLayoutWorkspace : ''}`}>
      {/* Session sidebar list */}
      <div className={s.chatMain}>
        <Card title="AI 投放助手" className={workspaceMode ? s.chatCardWorkspace : ''}>
          <div
            className={`${s.chatDropZone} ${isDragActive ? s.chatDropZoneActive : ''}`}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
          {loadingMessages ? (
            <div className={s.chatMessages} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)' }}>
              加载对话中…
            </div>
          ) : messages.length === 0 && selectedSession ? (
            <div className={s.chatMessages} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', flexDirection: 'column', gap: 12 }}>
              <span style={{ fontSize: '28px' }}>✦</span>
              <span style={{ fontWeight: 600, color: 'var(--text)' }}>开始你的 AI 投放计划</span>
              <span style={{ fontSize: 12 }}>试试以下提示，或直接输入你的推广需求</span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
                {['帮我推广一款新能源汽车到东南亚市场', '分析我的竞品广告投放策略', '为我的农机产品生成 Facebook 广告素材'].map(hint => (
                  <button
                    key={hint}
                    onClick={() => { setInputVal(hint); }}
                    style={{ padding: '6px 12px', fontSize: 12, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--r)', cursor: 'pointer', color: 'var(--text2)', transition: 'background 0.12s' }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg4)'}
                    onMouseLeave={e => e.currentTarget.style.background = 'var(--bg3)'}
                  >
                    {hint}
                  </button>
                ))}
              </div>
            </div>
          ) : messages.length === 0 ? (
            <div className={s.chatMessages} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: '24px' }}>✦</span>
              <span>从左侧选择一个投放计划查看对话</span>
            </div>
          ) : (
            <div className={s.chatMessages} ref={chatContainerRef}>
              {groupChatMessages(messages).map((item, i) => {
                if (item.type === 'user') {
                  return (
                    <div key={item.id || i} className={`${s.chatMsg} ${s.chatUser}`}>
                      <div className={s.chatBubble}>
                        {item.attachments?.length > 0 && (
                          <div style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                            {item.attachments.map((att, j) => (
                              <div key={j} style={{ position: 'relative', cursor: 'pointer' }} onClick={() => setLightboxUrl(att.url)}>
                                <img src={att.url} alt={att.filename || ''} style={{ width: 80, height: 80, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--border)' }} />
                                <span style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.5)', color: '#fff', borderRadius: 4, fontSize: 10, padding: '1px 4px', lineHeight: 1.2 }}>⤢</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <p style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                          {item.content}
                        </p>
                      </div>
                    </div>
                  );
                }
                if (item.type === 'assistant') {
                  return (
                    <div key={item.id || i} className={`${s.chatMsg} ${s.chatAI}`}>
                      <div className={s.aiAvatar}>AI</div>
                      <div className={s.chatBubble}>
                        <Markdown>{formatAssistantContent(item.content)}</Markdown>
                      </div>
                    </div>
                  );
                }
                if (item.type === 'phase_start') {
                  return <PhaseDivider key={item.id || i} label={item.content} />;
                }
                if (item.type === 'research_complete') {
                  if (item.report?._v2) {
                    return <ResearchCardV2 key={item.id || i} report={item.report} duration={item.duration} />;
                  }
                  return <ResearchCard key={item.id || i} report={item.report} duration={item.duration} />;
                }
                if (item.type === 'strategy_complete') {
                  return <StrategyCard key={item.id || i} plan={item.plan} />;
                }
                if (item.type === 'creative_plan_complete') {
                  return <CreativePlanCard key={item.id || i} creativeTasks={item.creativeTasks} references={item.references} />;
                }
                if (item.type === 'creative_complete') {
                  return <CreativeCard key={item.id || i} creatives={item.creatives} />;
                }
                if (item.type === 'creative_progress') {
                  return <CreativeCard key={item.id || i} inProgress completed={item.completed} total={item.total} errors={item.errors} lastDetail={item.lastDetail} />;
                }
                if (item.type === 'execution_approval') {
                  return <ExecutionCard key={item.id || i} plan={item.plan} status="awaiting_approval" />;
                }
                if (item.type === 'execution_complete') {
                  return <ExecutionCard key={item.id || i} result={item.result} status="completed" />;
                }
                if (item.type === 'feedback_required') {
                  return <FeedbackCard key={item.id || i} message={item.message} options={item.options} onRespond={handleFeedbackRespond} />;
                }
                if (item.type === 'feedback_resolved') {
                  return <FeedbackCard key={item.id || i} message={item.message} options={item.options} resolved selectedOption={item.selectedOption} />;
                }
                if (item.type === 'error') {
                  return (
                    <div key={item.id || i} className={`${s.chatMsg} ${s.chatAI}`}>
                      <div className={s.aiAvatar}>AI</div>
                      <div className={s.chatBubble}>❌ {item.content}</div>
                    </div>
                  );
                }
                // Thinking group — collapsed by default
                return <ThinkingGroup key={`tg-${i}`} steps={item.steps} />;
              })}

              {/* Live streaming status bar — always visible during pipeline */}
              {streamingSteps.length > 0 && (
                <div style={{ flexShrink: 0, borderRadius: 'var(--rl)', border: '1px solid var(--border2)', background: 'var(--bg)', padding: '10px 14px' }}>
                  {/* Latest step — always visible */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: streamingSteps.length > 1 ? 8 : 0 }}>
                    <span style={{ display: 'inline-block', width: 10, height: 10, border: '2px solid var(--accent)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                    <span style={{ fontSize: 12, color: 'var(--text2)', flex: 1 }}>
                      {streamingSteps[streamingSteps.length - 1]?.content || '处理中…'}
                    </span>
                    {streamingSteps[streamingSteps.length - 1]?.phase && (
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 3, background: 'var(--accent-dim)', color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>
                        {streamingSteps[streamingSteps.length - 1].phase}
                      </span>
                    )}
                  </div>
                  {/* Collapsible full step list */}
                  {streamingSteps.length > 1 && (
                    <ThinkingGroup steps={streamingSteps} />
                  )}
                </div>
              )}

              {/* Live streaming assistant text */}
              {streamingText && (
                <div className={`${s.chatMsg} ${s.chatAI}`}>
                  <div className={s.aiAvatar}>AI</div>
                  <div className={s.chatBubble}>
                    <Markdown>{streamingText}</Markdown>
                    <span style={{ display: 'inline-block', width: 6, height: 14, background: 'var(--accent)', borderRadius: 1, animation: 'blink 1s step-end infinite', marginLeft: 2, verticalAlign: 'text-bottom' }} />
                  </div>
                </div>
              )}


            </div>
          )}

          {/* Reconnect bar */}
          {showReconnect && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', fontSize: 12, color: 'var(--amber)' }}>
              <span>⚠ 连接中断</span>
              <button
                onClick={() => { setShowReconnect(false); setRefreshKey(k => k + 1); }}
                style={{ padding: '3px 10px', fontSize: 11, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 'var(--r)', cursor: 'pointer', color: 'var(--text2)' }}
              >
                🔄 重新连接
              </button>
            </div>
          )}

          {/* Input bar */}
          <div className={s.chatInput}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileSelect}
            />
            {/* Image previews */}
            {pendingImages.length > 0 && (
              <div style={{ display: 'flex', gap: 6, padding: '6px 0', flexWrap: 'wrap', width: '100%' }}>
                {pendingImages.map(img => {
                  const isImage = img.file?.type?.startsWith('image/');
                  return (
                  <div key={img.id} style={{ position: 'relative', width: 48, height: 48, borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
                    {isImage ? (
                      <img src={img.preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary, #888)', fontSize: 10 }}>
                        <span style={{ fontSize: 18 }}>📄</span>
                        <span style={{ fontSize: 8, marginTop: 1 }}>{img.file?.name?.split('.').pop()?.toUpperCase()}</span>
                      </div>
                    )}
                    {img.uploading && (
                      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ fontSize: 12, color: '#fff' }}>⏳</span>
                      </div>
                    )}
                    <button
                      onClick={() => setPendingImages(prev => prev.filter(p => p.id !== img.id))}
                      style={{ position: 'absolute', top: 1, right: 1, width: 16, height: 16, background: 'rgba(0,0,0,0.5)', color: '#fff', border: 'none', borderRadius: '50%', fontSize: 10, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    >×</button>
                  </div>
                  );
                  })}
              </div>
            )}
            <div className={s.chatInputRow}>
              <button className={s.uploadBtn} title="上传图片/文档" onClick={handleUploadClick} disabled={sendingMsg}>📎</button>
              <input
                className={s.textInput}
                placeholder="描述你的推广目标，或拖拽 / 粘贴素材…"
                value={inputVal}
                onChange={e => setInputVal(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handleInputPaste}
                disabled={sendingMsg}
              />
              <button
                className={s.sendBtn}
                onClick={handleSend}
                disabled={(!inputVal.trim() && !pendingImages.some(p => p.uploaded)) || sendingMsg || !selectedSession}
              >
                {sendingMsg ? '发送中…' : '发送 ›'}
              </button>
            </div>
          </div>
          {isDragActive && (
            <div className={s.dropOverlay}>
              <div className={s.dropOverlayInner}>
                <div className={s.dropOverlayTitle}>松开以上传素材</div>
                <div className={s.dropOverlayText}>支持图片、PDF 和表格文件</div>
              </div>
            </div>
          )}
          </div>
        </Card>
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
                ? new Date(session.created_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
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
                        {statusLabel} · {phaseLabel} · {createdDate}
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
function AttributionTab({ adsData, loading, daysFilter, metricsMap }) {
  // Compute per-country conversation counts from joined conversation data
  const [countryData, setCountryData] = useState([]);
  const [productLineData, setProductLineData] = useState([]);
  const [loadingAttr, setLoadingAttr] = useState(true);
  const [attrInsights, setAttrInsights] = useState(null);
  const [attrLoading, setAttrLoading] = useState(false);

  useEffect(() => {
    async function fetchAIInsights() {
      setAttrLoading(true);
      try {
        const res = await fetch('/api/ai/report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'attribution', days: daysFilter || 30 }),
        });
        if (!res.ok) throw new Error('Failed to fetch AI insights');
        const data = await res.json();
        setAttrInsights(data);
      } catch (err) {
        console.error('Error fetching AI insights:', err);
        setAttrInsights(null);
      } finally {
        setAttrLoading(false);
      }
    }
    fetchAIInsights();
  }, [daysFilter]);

  useEffect(() => {
    // Fix #8: Fetch current + previous period for real trend comparison
    async function fetchAttributionData() {
      try {
        const supabase = createClient();
        const effectiveDays = daysFilter || 30;

        // Build date ranges: current period + equal-length previous period
        const toDate = new Date();
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - effectiveDays + 1);
        fromDate.setHours(0, 0, 0, 0);
        const prevTo = new Date(fromDate.getTime() - 1);
        const prevFrom = new Date(prevTo);
        prevFrom.setDate(prevFrom.getDate() - effectiveDays + 1);
        prevFrom.setHours(0, 0, 0, 0);

        // Fetch both periods in parallel
        const [currentRes, prevRes] = await Promise.all([
          supabase
            .from('conversations')
            .select('meta_ad_id, agent_id, created_at, agents(product_line), leads(inquiry_quality, destination_country)')
            .not('meta_ad_id', 'is', null)
            .gte('created_at', fromDate.toISOString())
            .lte('created_at', toDate.toISOString()),
          supabase
            .from('conversations')
            .select('meta_ad_id, agent_id, created_at, agents(product_line), leads(inquiry_quality, destination_country)')
            .not('meta_ad_id', 'is', null)
            .gte('created_at', prevFrom.toISOString())
            .lte('created_at', prevTo.toISOString()),
        ]);

        if (currentRes.error) throw currentRes.error;
        if (prevRes.error) throw prevRes.error;

        // Helper: aggregate conversations into line/country buckets
        function aggregateConversations(convs) {
          const countryMap = new Map();
          const lineMap = new Map();

          for (const conv of convs || []) {
            const leadsArr = Array.isArray(conv.leads) ? conv.leads : (conv.leads ? [conv.leads] : []);
            const agentLine = conv.agents?.product_line || '其他';

            if (!lineMap.has(agentLine)) {
              lineMap.set(agentLine, { line: agentLine, conversations: 0, qualifyCount: 0, proofCount: 0, adIds: new Set() });
            }
            const lineBucket = lineMap.get(agentLine);
            lineBucket.conversations += 1;
            if (conv.meta_ad_id) lineBucket.adIds.add(String(conv.meta_ad_id));

            for (const lead of leadsArr) {
              const country = lead.destination_country || '未知';
              if (!countryMap.has(country)) {
                countryMap.set(country, { country, conversationCount: 0, qualifyCount: 0, proofCount: 0 });
              }
              const bucket = countryMap.get(country);
              bucket.conversationCount += 1;

              const quality = String(lead.inquiry_quality || '').toUpperCase();
              if (quality === 'QUALIFY') {
                bucket.qualifyCount += 1;
                lineBucket.qualifyCount += 1;
              }
              if (quality === 'PROOF') {
                bucket.proofCount += 1;
                lineBucket.proofCount += 1;
              }
            }
          }
          return { countryMap, lineMap };
        }

        const currentAgg = aggregateConversations(currentRes.data);
        const prevAgg = aggregateConversations(prevRes.data);

        // Build previous period proofRate lookup by product line
        const prevProofRateByLine = {};
        for (const [line, bucket] of prevAgg.lineMap) {
          prevProofRateByLine[line] = bucket.conversations > 0
            ? Math.round((bucket.proofCount / bucket.conversations) * 100)
            : 0;
        }

        // Sort countries by conversation count desc
        const sortedCountries = Array.from(currentAgg.countryMap.values())
          .sort((a, b) => b.conversationCount - a.conversationCount)
          .slice(0, 10);

        const maxConv = sortedCountries[0]?.conversationCount || 1;
        const withPct = sortedCountries.map(c => {
          const pct = Math.round((c.conversationCount / maxConv) * 100);
          const proofRate = c.conversationCount > 0
            ? Math.round((c.proofCount / c.conversationCount) * 100)
            : 0;
          let color = 'var(--red)';
          if (proofRate >= 60) color = 'var(--green)';
          else if (proofRate >= 30) color = 'var(--teal)';
          else if (proofRate >= 10) color = 'var(--amber)';
          return { ...c, pct, proofRate, color };
        });

        setCountryData(withPct);

        const sortedLines = Array.from(currentAgg.lineMap.values())
          .map(line => {
            let spend = null;
            if (metricsMap && metricsMap.size > 0) {
              spend = 0;
              for (const adId of line.adIds) {
                const m = metricsMap.get(adId);
                if (m) spend += m.spend;
              }
            }
            // Attach previous period proofRate for trend comparison
            const prevProofRate = prevProofRateByLine[line.line] ?? null;
            return { ...line, adIds: undefined, spend, prevProofRate };
          })
          .sort((a, b) => b.conversations - a.conversations);
        setProductLineData(sortedLines);
      } catch (err) {
        console.error('Error fetching attribution data:', err);
      } finally {
        setLoadingAttr(false);
      }
    }
    fetchAttributionData();
  }, [daysFilter, metricsMap]);

  return (
    <div className={s.attrRoot}>
      {/* Core insights */}
      <section className={s.section}>
        <div className={s.sectionTitle}>核心战略洞察</div>
        {attrLoading ? (
          <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>AI 洞察生成中…</div>
        ) : attrInsights?.insights ? (
          <div className={s.insightGrid}>
            {attrInsights.insights.map((ins, i) => {
              const cls = {
                red: s.insightRed,
                purple: s.insightPurple,
                green: s.insightGreen,
                amber: s.insightAmber,
              }[ins.color] || '';
              return (
                <div key={i} className={`${s.insightBox} ${cls}`}>
                  <div className={s.insightIcon}>{ins.icon}</div>
                  <div className={s.insightTitle}>{ins.title}</div>
                  <div className={s.insightBody}>{ins.body}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>暂无 AI 洞察</div>
        )}
      </section>

      {/* Product line comparison */}
      <section className={s.section}>
        <div className={s.sectionTitle}>业务线对比</div>
        {loadingAttr ? (
          <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>加载中…</div>
        ) : productLineData.length === 0 ? (
          <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>暂无业务线数据</div>
        ) : (
          <>
            <div className={s.bizTableWrap}>
              <table className={s.bizTable}>
                <thead>
                  <tr>
                    <th>业务线</th>
                    <th>花费</th>
                    <th>WA 对话</th>
                    <th>中质量率</th>
                    <th>高质量率</th>
                    <th>趋势</th>
                  </tr>
                </thead>
                <tbody>
                  {productLineData.map(row => {
                    const qualifyRate = row.conversations > 0
                      ? Math.round((row.qualifyCount / row.conversations) * 100)
                      : 0;
                    const proofRate = row.conversations > 0
                      ? Math.round((row.proofCount / row.conversations) * 100)
                      : 0;
                    // Fix #8: Compare current proofRate with previous period
                    const prevRate = row.prevProofRate;
                    let trendEl;
                    if (prevRate == null) {
                      trendEl = <span className={s.trendNeutral}>—</span>;
                    } else if (proofRate > prevRate) {
                      trendEl = <span className={s.trendUp}>↑ +{proofRate - prevRate}%</span>;
                    } else if (proofRate < prevRate) {
                      trendEl = <span className={s.trendDown}>↓ {proofRate - prevRate}%</span>;
                    } else {
                      trendEl = <span className={s.trendNeutral}>→ 持平</span>;
                    }
                    return (
                      <tr key={row.line}>
                        <td className={s.bizLineName}>{row.line || '其他'}</td>
                        <td>{row.spend != null ? `$${row.spend.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</td>
                        <td>{row.conversations.toLocaleString()}</td>
                        <td><span className={s.roasVal}>{qualifyRate}%</span></td>
                        <td><span className={s.roasVal}>{proofRate}%</span></td>
                        <td>{trendEl}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {productLineData.length > 0 && (() => {
              const bestProofLine = productLineData.reduce((best, row) => {
                const rate = row.conversations > 0 ? row.proofCount / row.conversations : 0;
                const bestRate = best.conversations > 0 ? best.proofCount / best.conversations : 0;
                return rate > bestRate ? row : best;
              }, productLineData[0]);
              const bestConvLine = productLineData.reduce((best, row) =>
                row.conversations > best.conversations ? row : best, productLineData[0]);
              const bestQualLine = productLineData.reduce((best, row) => {
                const rate = row.conversations > 0 ? row.qualifyCount / row.conversations : 0;
                const bestRate = best.conversations > 0 ? best.qualifyCount / best.conversations : 0;
                return rate > bestRate ? row : best;
              }, productLineData[0]);

              return (
                <div className={s.bizCompGrid}>
                  <div className={s.bizCompCell}>
                    <div className={s.bizCompLabel}>最高高质量率</div>
                    <div className={s.bizCompValue} style={{ color: 'var(--green)' }}>
                      {bestProofLine.line} {bestProofLine.conversations > 0
                        ? Math.round((bestProofLine.proofCount / bestProofLine.conversations) * 100)
                        : 0}%
                    </div>
                  </div>
                  <div className={s.bizCompCell}>
                    <div className={s.bizCompLabel}>最多对话</div>
                    <div className={s.bizCompValue} style={{ color: 'var(--accent)' }}>
                      {bestConvLine.line} {bestConvLine.conversations.toLocaleString()}
                    </div>
                  </div>
                  <div className={s.bizCompCell}>
                    <div className={s.bizCompLabel}>最高中质量率</div>
                    <div className={s.bizCompValue} style={{ color: 'var(--purple)' }}>
                      {bestQualLine.line} {bestQualLine.conversations > 0
                        ? Math.round((bestQualLine.qualifyCount / bestQualLine.conversations) * 100)
                        : 0}%
                    </div>
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </section>

      {/* Country conversation ranking */}
      <section className={s.section}>
        <div className={s.sectionTitle}>国家对话排行</div>
        {loadingAttr ? (
          <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>加载中…</div>
        ) : countryData.length === 0 ? (
          <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>暂无国家数据</div>
        ) : (
          <div className={s.cpaList}>
            {countryData.map((row, i) => (
              <div key={i} className={s.cpaRow}>
                <div className={s.cpaCountry}>{row.country}</div>
                <div className={s.cpaTrack}>
                  <div
                    className={s.cpaFill}
                    style={{ width: `${row.pct}%`, background: row.color }}
                  />
                </div>
                <div className={s.cpaValue}>
                  {row.conversationCount.toLocaleString()} 对话 · PROOF {row.proofRate}%
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Recommendations */}
      <section className={s.section}>
        <div className={s.sectionTitle}>执行建议</div>
        {attrLoading ? (
          <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>AI 建议生成中…</div>
        ) : attrInsights?.recommendations ? (
          <div className={s.recGrid}>
            {attrInsights.recommendations.map((rec, i) => {
              const prioClass = rec.color === 'red' ? s.prioRed : s.prioAmber;
              const cardClass = rec.color === 'red' ? s.recCardRed : s.recCardAmber;
              return (
                <div key={i} className={`${s.recCard} ${cardClass}`}>
                  <div className={s.recHead}>
                    <span className={`${s.prioBadge} ${prioClass}`}>{rec.priority}</span>
                    <span className={s.recTitle}>{rec.title}</span>
                  </div>
                  <p className={s.recBody}>{rec.body}</p>
                  <ul className={s.recActions}>
                    {(rec.actions || []).map((a, j) => (
                      <li key={j}>{a}</li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>暂无执行建议</div>
        )}
      </section>

      {/* Final insight */}
      {attrInsights?.summary && (
        <div className={s.finalInsight}>
          <span className={s.finalIcon}>✦</span>
          <div>
            <strong>综合优化潜力：</strong>{attrInsights.summary}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────
export function CampaignStudioScreen({
  title = 'Campaign Studio',
  subtitle = 'AI 自动化投放 · 广告管理 · 深度效果分析 · 近 {days} 天',
  visibleTabKeys = ['list', 'ai', 'attribution'],
  defaultTab = 'list',
  showMetrics = true,
  showExportAction = true,
  showGlobalAnalysis = true,
  workspaceMode = false,
}) {
  const tabs = MAIN_TABS.filter(item => visibleTabKeys.includes(item.key));
  const initialTab = tabs.find(item => item.key === defaultTab)?.key || tabs[0]?.key || 'list';
  const requiresAdsData = showMetrics || visibleTabKeys.includes('list') || visibleTabKeys.includes('attribution');
  const [tab, setTab] = useState(initialTab);
  const [adsData, setAdsData] = useState(null);
  const [loadingAds, setLoadingAds] = useState(requiresAdsData);
  const [daysFilter] = useState(30);
  const [metricsMap, setMetricsMap] = useState(new Map());
  const [metricsTotals, setMetricsTotals] = useState(null);
  const [dailyMetricsMap, setDailyMetricsMap] = useState({});
  const [aiAnalysis, setAiAnalysis] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    if (!tabs.some(item => item.key === tab)) {
      setTab(initialTab);
    }
  }, [initialTab, tab, tabs]);

  async function handleAiAnalysis() {
    setAiLoading(true);
    try {
      const res = await fetch('/api/ai/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'campaign_analysis', days: daysFilter || 30 }),
      });
      const data = await res.json();
      setAiAnalysis(data.report);
    } catch (err) {
      console.error('AI analysis error:', err);
    } finally {
      setAiLoading(false);
    }
  }

  const handleExportReport = () => {
    const url = `/api/reports/export?type=campaign&format=csv&days=${daysFilter || 30}`;
    window.open(url, '_blank');
  };

  useEffect(() => {
    if (!requiresAdsData) {
      setLoadingAds(false);
      return;
    }

    async function fetchAds() {
      setLoadingAds(true);
      try {
        const [adsRes, metricsRes] = await Promise.all([
          fetch(`/api/ads?days=${daysFilter}`),
          fetch(`/api/ads/metrics?days=${daysFilter}`),
        ]);
        if (!adsRes.ok) throw new Error('Failed to fetch ads');
        const data = await adsRes.json();
        setAdsData(data);
        if (metricsRes.ok) {
          const metricsData = await metricsRes.json();
          const map = new Map();
          for (const item of metricsData.metrics || []) {
            map.set(item.adId, item);
          }
          setMetricsMap(map);
          if (metricsData.totals) setMetricsTotals(metricsData.totals);
          if (metricsData.dailyMetrics) setDailyMetricsMap(metricsData.dailyMetrics);
        }
      } catch (err) {
        console.error('Error fetching ads:', err);
        setAdsData(null);
      } finally {
        setLoadingAds(false);
      }
    }
    fetchAds();
  }, [daysFilter, requiresAdsData]);

  // Build day cards by grouping ads by lastConversationAt date
  const dayCards = (() => {
    if (!adsData?.summary) return [];

    const dayMap = new Map();
    for (const ad of adsData.summary) {
      const dateKey = ad.lastConversationAt
        ? ad.lastConversationAt.split('T')[0]
        : 'unknown';
      if (!dayMap.has(dateKey)) {
        dayMap.set(dateKey, { date: dateKey, ads: [], totalConversations: 0 });
      }
      const day = dayMap.get(dateKey);
      day.ads.push(ad);
      day.totalConversations += ad.conversationCount;
    }

    const today = new Date().toISOString().split('T')[0];
    return Array.from(dayMap.values())
      .sort((a, b) => b.date.localeCompare(a.date))
      .map(day => ({ ...day, isToday: day.date === today }));
  })();

  const totals = adsData?.totals;

  return (
    <div className={`${s.root} ${workspaceMode ? s.rootWorkspace : ''}`}>
      {/* Page header */}
      <div className={`${s.header} ${workspaceMode ? s.headerWorkspace : ''}`}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>{title}</h1>
          <span className={s.subtitle}>{subtitle.replace('{days}', String(daysFilter))}</span>
        </div>
        {(showExportAction || showGlobalAnalysis) && (
          <div className={s.headerRight}>
            {showExportAction && (
              <Button variant="ghost" size="sm" onClick={handleExportReport}>↓ 导出报告</Button>
            )}
            {showGlobalAnalysis && (
              <Button variant="primary" size="sm" onClick={handleAiAnalysis} disabled={aiLoading}>
                {aiLoading ? '分析中…' : '✦ AI 全局分析'}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* AI Analysis Result */}
      {showGlobalAnalysis && aiAnalysis && (
        <AIPanel title="AI 全局分析" tag="campaign_analysis">
          <Markdown>{aiAnalysis}</Markdown>
        </AIPanel>
      )}

      {/* Metric strip */}
      {showMetrics && (
        <div className={s.metrics}>
          <MetricCard
            label="总花费"
            value={
              loadingAds
                ? '…'
                : metricsTotals?.spend != null
                  ? `$${Number(metricsTotals.spend).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : '—'
            }
            delta={metricsTotals?.spend != null ? `CTR ${metricsTotals.avgCtr}%` : '未配置'}
            trend="neutral"
          />
          <MetricCard
            label="WA 对话"
            value={loadingAds ? '…' : (totals?.conversationCount?.toLocaleString() ?? '—')}
            delta={totals ? `中质量率 ${totals.qualifyConversationRate}%` : ''}
            trend="up"
            color="green"
          />
          <MetricCard
            label="活跃广告"
            value={loadingAds ? '…' : (totals?.adsCount?.toLocaleString() ?? '—')}
            delta={totals ? `${daysFilter} 天数据` : ''}
            trend="neutral"
            color="teal"
          />
          <MetricCard
            label="中质量对话"
            value={loadingAds ? '…' : (totals?.qualifyConversationCount?.toLocaleString() ?? '—')}
            delta={totals ? `${totals.qualifyConversationRate}% 率` : ''}
            trend="neutral"
            color="purple"
          />
          <MetricCard
            label="高质量对话"
            value={loadingAds ? '…' : (totals?.proofConversationCount?.toLocaleString() ?? '—')}
            delta={totals ? `${totals.proofConversationRate}% 率` : ''}
            trend="up"
            color="amber"
          />
        </div>
      )}

      {/* Tab bar */}
      {tabs.length > 1 && <TabBar tabs={tabs} active={tab} onChange={setTab} />}

      {/* Tab content */}
      <div className={`${s.tabContent} ${workspaceMode ? s.tabContentWorkspace : ''}`}>
        {tab === 'list' && (
          <ListTab days={dayCards} loading={loadingAds} metricsMap={metricsMap} dailyMetricsMap={dailyMetricsMap} />
        )}
        {tab === 'ai' && <Suspense><ChatTab workspaceMode={workspaceMode} /></Suspense>}
        {tab === 'attribution' && (
          <AttributionTab adsData={adsData} loading={loadingAds} daysFilter={daysFilter} metricsMap={metricsMap} />
        )}
      </div>
    </div>
  );
}

export default CampaignStudioScreen;
