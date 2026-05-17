'use client';

import { useEffect, useRef, useState } from 'react';
import s from '../ogilvy.module.css';

/**
 * UsageBadge — Claude Code statusline 风格的小 pill，浮在 chat 区右下角（composer 旁）。
 *
 * 显示最近一次主对话调用 (ogilvy.turn) 的 input token (prompt + cache_*)
 * 对 1M context window 的占比 —— 这是当前 context 实际填到多少的 proxy。
 * hover 弹面板看 input / output / cache / cost / by_call_site / by_model。
 *
 * 1M 是 Sonnet 4.6 的 context window（ogilvy 主对话锁定 Sonnet）。工具
 * 调用 (web_search / read_webpage) 走 Haiku 4.5 (200K) 但 prompt 是 short
 * synthesis，不会接近上限，不算入此 badge。
 *
 * 触发刷新的两个时机：
 *   1. sessionId 变化（切换会话）
 *   2. refreshKey 变化（调用方在每轮 streaming 结束后递增）
 *
 * 注意 llm-client.js 的落表是 fire-and-forget，会有几百 ms 延迟。我们在
 * refreshKey 变化时延迟 800ms 再 fetch，避免拿到 stale 数据。
 */
export default function UsageBadge({ sessionId, refreshKey = 0, inline = false }) {
  const [usage, setUsage] = useState(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // Close on outside click or ESC. Listener only attaches when open is true
  // so we don't pay listener cost in the common closed state.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!sessionId) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    const fetchUsage = async () => {
      try {
        const res = await fetch(`/api/ogilvy/conversations/${sessionId}/usage`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setUsage(data);
      } catch {
        // Swallow — badge is non-critical UI.
      }
    };
    // First load: immediate. Refresh: small delay to let fire-and-forget commit.
    const delay = refreshKey === 0 ? 0 : 800;
    const timer = setTimeout(fetchUsage, delay);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [sessionId, refreshKey]);

  if (!usage) return null;

  // 当前 context 占用 = 最近一次主对话调用的 input(prompt + cache_*)
  // 工具调用（web_search / read_webpage）走独立短 prompt，跟主对话 history
  // 无关，不算 context 占用。无 ogilvy.turn 历史时按 0 显示。
  const used = usage.latest?.total_input || 0;
  const ctx = usage.context_window_tokens;
  const pct = ctx ? Math.round((used / ctx) * 100) : 0;
  const tone = pct < 50 ? 'ok' : pct < 80 ? 'warn' : 'danger';

  return (
    <button
      ref={rootRef}
      type="button"
      className={`${s.usageBadge} ${inline ? s.usageBadgeInline : ''}`}
      data-tone={tone}
      // Click-only toggle. Hover-trigger removed:was racing with click
      // (mouseenter → setOpen(true) → click → toggle → setOpen(false),
      // so a normal click flashed and closed). Click is also discoverable
      // on touch devices where hover doesn't fire.
      onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
      aria-expanded={open}
      aria-label={`当前上下文 ${fmtTokens(used)} / ${fmtTokens(ctx)} (${pct}%) · 点击查看详情`}
    >
      <span className={s.usageBadgeNums}>
        {fmtTokens(used)} / {fmtTokens(ctx)}
      </span>
      <span className={s.usageBadgePct}>· {pct}%</span>
      <span className={s.usageBadgePct}>· {fmtCost(usage.totals.cost_usd)}</span>

      {open && (
        <div
          className={s.usagePopover}
          role="tooltip"
          onClick={(e) => e.stopPropagation()}
        >
          <UsagePopover usage={usage} />
        </div>
      )}
    </button>
  );
}

function UsagePopover({ usage }) {
  const { totals, latest, by_model: byModel, by_call_site: byCallSite, turn_count: turnCount, context_window_tokens: ctxTokens } = usage;
  return (
    <>
      <div className={s.usagePopoverHead}>本会话 Token 用量</div>

      {latest ? (
        <>
          <div className={s.usageRowEm}>
            <span>当前上下文</span>
            <span>{fmtTokens(latest.total_input)} / {fmtTokens(ctxTokens)}</span>
          </div>
          <div className={s.usageRow}>
            <span className={s.usageMuted}>　输入(未缓存)</span>
            <span>{fmtTokens(latest.prompt)}</span>
          </div>
          <div className={s.usageRow}>
            <span className={s.usageMuted}>　缓存写入</span>
            <span>{fmtTokens(latest.cache_create)}</span>
          </div>
          <div className={s.usageRow}>
            <span className={s.usageMuted}>　缓存读取</span>
            <span>{fmtTokens(latest.cache_read)}</span>
          </div>
          <div className={s.usageRow}>
            <span className={s.usageMuted}>　上轮输出</span>
            <span>{fmtTokens(latest.completion)}</span>
          </div>
          <div className={s.usageRow}>
            <span className={s.usageMuted}>　上轮成本</span>
            <span>{fmtCost(latest.cost_usd)}</span>
          </div>
          <div className={s.usageDivider} />
        </>
      ) : null}

      <div className={s.usageRowEm}><span>累计成本</span><span>{fmtCost(totals.cost_usd)}</span></div>
      <div className={s.usageRowEm}><span>LLM 调用次数</span><span>{turnCount}</span></div>

      {Object.keys(byModel).length > 0 && (
        <>
          <div className={s.usageSep}>按模型</div>
          {Object.entries(byModel)
            .sort(([, a], [, b]) => b.count - a.count)
            .map(([m, v]) => (
              <div key={m} className={s.usageRow}>
                <span className={s.usageMuted}>{shortModelName(m)}</span>
                <span>×{v.count} · {fmtCost(v.cost_usd)}</span>
              </div>
            ))}
        </>
      )}

      {Object.keys(byCallSite).length > 0 && (
        <>
          <div className={s.usageSep}>按调用点</div>
          {Object.entries(byCallSite)
            .sort(([, a], [, b]) => b.cost_usd - a.cost_usd)
            .map(([cs, v]) => (
              <div key={cs} className={s.usageRow}>
                <span className={s.usageMuted}>{cs}</span>
                <span>×{v.count} · {fmtCost(v.cost_usd)}</span>
              </div>
            ))}
        </>
      )}
    </>
  );
}

function fmtTokens(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function fmtCost(n) {
  const v = Number(n) || 0;
  if (v < 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(2);
}

function shortModelName(m) {
  return String(m).replace(/^anthropic\//, '').replace(/^openai\//, '');
}
