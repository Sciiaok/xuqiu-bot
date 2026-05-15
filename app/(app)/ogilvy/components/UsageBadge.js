'use client';

import { useEffect, useState } from 'react';
import s from '../ogilvy.module.css';

/**
 * UsageBadge — Claude Code statusline 风格的小 pill，浮在 chat 区左上角。
 *
 * 显示当前 session 累计 token 用量（含 cache）对 200K context window 的占比；
 * hover 弹面板看 input / output / cache / cost / by_call_site / by_model。
 *
 * 触发刷新的两个时机：
 *   1. sessionId 变化（切换会话）
 *   2. refreshKey 变化（调用方在每轮 streaming 结束后递增）
 *
 * 注意 llm-client.js 的落表是 fire-and-forget，会有几百 ms 延迟。我们在
 * refreshKey 变化时延迟 800ms 再 fetch，避免拿到 stale 数据。
 */
export default function UsageBadge({ sessionId, refreshKey = 0 }) {
  const [usage, setUsage] = useState(null);
  const [open, setOpen] = useState(false);

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

  const used = usage.totals.total_input;
  const ctx = usage.context_window_tokens;
  const pct = ctx ? Math.round((used / ctx) * 100) : 0;
  const tone = pct < 50 ? 'ok' : pct < 80 ? 'warn' : 'danger';

  return (
    <div
      className={s.usageBadge}
      data-tone={tone}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      aria-label={`Token 用量 ${fmtTokens(used)} / ${fmtTokens(ctx)} (${pct}%)`}
    >
      <span className={s.usageBadgeNums}>
        {fmtTokens(used)} / {fmtTokens(ctx)}
      </span>
      <span className={s.usageBadgePct}>· {pct}%</span>

      {open && (
        <div className={s.usagePopover} role="tooltip">
          <UsagePopover usage={usage} />
        </div>
      )}
    </div>
  );
}

function UsagePopover({ usage }) {
  const { totals, by_model: byModel, by_call_site: byCallSite, turn_count: turnCount } = usage;
  return (
    <>
      <div className={s.usagePopoverHead}>本会话 Token 用量</div>

      <div className={s.usageRow}><span>输入(未缓存)</span><span>{fmtTokens(totals.prompt)}</span></div>
      <div className={s.usageRow}><span>缓存写入</span><span>{fmtTokens(totals.cache_create)}</span></div>
      <div className={s.usageRow}><span>缓存读取</span><span>{fmtTokens(totals.cache_read)}</span></div>
      <div className={s.usageRow}><span>输出</span><span>{fmtTokens(totals.completion)}</span></div>
      <div className={s.usageDivider} />
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
            .sort(([, a], [, b]) => b.count - a.count)
            .map(([cs, v]) => (
              <div key={cs} className={s.usageRow}>
                <span className={s.usageMuted}>{cs}</span>
                <span>×{v.count}</span>
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
