'use client';

import { useEffect, useState, useMemo } from 'react';
import s from './CostStatsTab.module.css';

/**
 * CostStatsTab — per-product-line cost breakdown.
 *
 * 数据源:
 *   /api/product-lines/[id]/cost-stats  — LLM + 量化 + Ogilvy tenant-level
 *   /api/ads/dashboard?productLine=[id] — Meta 广告花费(复用现有 endpoint)
 *
 * 两路并行 fetch,任一失败不互相阻塞;ad spend 失败时降级显示"广告数据
 * 暂不可用"(通常是 Meta 未连接或 token 过期),不影响 LLM 区域。
 */
const RANGE_OPTIONS = [
  { key: '7d',  label: '近 7 天',  days: 7  },
  { key: '30d', label: '近 30 天', days: 30 },
  { key: '90d', label: '近 90 天', days: 90 },
];

export default function CostStatsTab({ productLineId }) {
  const [rangeKey, setRangeKey] = useState('30d');
  const [stats, setStats] = useState(null);
  const [adSummary, setAdSummary] = useState(null);
  const [adError, setAdError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setAdError('');

    const statsPromise = fetch(`/api/product-lines/${productLineId}/cost-stats?range=${rangeKey}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
        return r.json();
      });

    // ads/dashboard 不接受 `range=`,要么 preset=7d|30d 要么 days=N。90d 不是
    // 已知 preset,所以两个端点的参数名故意分开:cost-stats 用 range,ads 用
    // days(走 default 分支自动构造 ${days}d preset)。
    const days = RANGE_OPTIONS.find(o => o.key === rangeKey)?.days || 30;
    const adsPromise = fetch(`/api/ads/dashboard?productLine=${productLineId}&days=${days}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
        return r.json();
      });

    Promise.allSettled([statsPromise, adsPromise]).then(([statsRes, adsRes]) => {
      if (cancelled) return;
      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value);
      } else {
        setError(statsRes.reason?.message || '加载失败');
      }
      if (adsRes.status === 'fulfilled') {
        setAdSummary(adsRes.value?.summary || null);
      } else {
        setAdError(adsRes.reason?.message || '广告数据加载失败');
      }
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [productLineId, rangeKey]);

  if (loading && !stats) {
    return (
      <div className={s.loading}>
        <span className={s.spinner} />加载成本数据…
      </div>
    );
  }
  if (error) {
    return <div className={s.errorBox}>加载失败: {error}</div>;
  }
  if (!stats) return null;

  const adSpend = Number(adSummary?.spend) || 0;
  const llmCost = Number(stats.llm.totals.cost_usd) || 0;
  const llmCostPrev = Number(stats.llm_prev?.totals?.cost_usd) || 0;
  const totalCost = adSpend + llmCost;
  const llmDelta = computeDelta(llmCost, llmCostPrev);

  return (
    <div className={`${s.root} ${loading ? s.refreshing : ''}`}>
      {/* ── Range selector ─────────────────────────────────────────── */}
      <div className={s.rangeBar}>
        <span className={s.rangeLabel}>时间范围 · 当期 vs 上一周期对比</span>
        <div className={s.rangePills}>
          {RANGE_OPTIONS.map(opt => (
            <button
              key={opt.key}
              className={`${s.rangePill} ${rangeKey === opt.key ? s.rangePillActive : ''}`}
              onClick={() => setRangeKey(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── KPI strip ──────────────────────────────────────────────── */}
      <div className={s.kpiGrid}>
        <KpiCard
          label="本期总成本"
          value={fmtUsd(totalCost)}
          sub="= 广告花费 + LLM 推理"
        />
        <KpiCard
          label="广告花费 (Meta)"
          value={adError ? '—' : fmtUsd(adSpend)}
          sub={adError ? '数据不可用' : `${adSummary?.waConversations || 0} 个 WA 对话 · CPA ${fmtUsd(adSummary?.cpa || 0)}`}
        />
        <KpiCard
          label="LLM 推理成本"
          value={fmtUsd(llmCost)}
          sub={`${stats.llm.totals.count} 次调用 · ${renderDelta(llmDelta)}`}
        />
        <KpiCard
          label="Ogilvy 工作台(租户级)"
          value={fmtUsd(stats.ogilvy_tenant.total_usd)}
          sub={
            <>
              推理 {fmtUsd(stats.ogilvy_tenant.reasoning_usd)} · 图 {stats.ogilvy_tenant.image_count}张 {fmtUsd(stats.ogilvy_tenant.image_usd)}
              <br />跨产品线
            </>
          }
          info
        />
      </div>

      {/* ── Daily LLM trend ────────────────────────────────────────── */}
      <DailyTrend days={stats.llm.by_day} rangeDays={stats.range.days} />

      {/* ── AI by call_site ────────────────────────────────────────── */}
      <CallSiteTable bySite={stats.llm.by_call_site} grandTotal={llmCost} />

      {/* ── AI by model ────────────────────────────────────────────── */}
      <ModelTable byModel={stats.llm.by_model} grandTotal={llmCost} />

      {/* ── Volume + derived ───────────────────────────────────────── */}
      <VolumeSection volume={stats.volume} llmCost={llmCost} adSpend={adSpend} />

      <p className={s.notice}>
        说明: LLM 成本只统计能归属到本产品线的调用 (medici 应答、KB 搜索/上传抽取/视觉理解、知识教学、画像总结、单产品线日报)。
        Ogilvy 工作台 (会话推理 / 网页搜索 / 图片生成) 跨产品线共用,作为租户级数据单独展示。
        历史数据 (本功能上线前) 在按时间窗反推回填后才会出现在表中,详见 supabase/operations/2026-05-16-backfill-llm-usage-product-line.sql。
        <br />
        时区: LLM 成本按 UTC 日历切窗 (近 N 天 = 今天 UTC 整天 + 之前 N-1 天)。
        广告花费按 Asia/Shanghai 昨日截止取数 (Meta cache 策略,避开今日未稳数据),所以两边窗口可能差约 1 天 —— 30/90 天窗口里影响在 1-3% 量级。
      </p>
    </div>
  );
}

// ── KPI card ─────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, info = false }) {
  return (
    <div className={`${s.kpiCard} ${info ? s.kpiCardInfo : ''}`}>
      <div className={s.kpiLabel}>{label}</div>
      <div className={`${s.kpiValue} ${info ? s.kpiValueSmall : ''}`}>{value}</div>
      {sub ? <div className={s.kpiSub}>{sub}</div> : null}
    </div>
  );
}

// ── Daily trend ──────────────────────────────────────────────────────
function DailyTrend({ days, rangeDays }) {
  // 补齐 range 内每一天 0 值,保证柱图轴对齐
  const fullDays = useMemo(() => fillMissingDays(days, rangeDays), [days, rangeDays]);
  const maxCost = Math.max(0.0001, ...fullDays.map(d => d.cost_usd));

  if (fullDays.every(d => d.cost_usd === 0)) {
    return (
      <div className={s.section}>
        <h3 className={s.sectionTitle}>LLM 每日成本</h3>
        <div className={s.emptyBox}>本期无可归属调用</div>
      </div>
    );
  }

  // 轴标签:头/尾 + 中间 1-2 个采样,避免堆叠
  const labelIdxs = pickLabelIndices(fullDays.length);

  return (
    <div className={s.section}>
      <h3 className={s.sectionTitle}>LLM 每日成本</h3>
      <p className={s.sectionHint}>当期共 {fmtUsd(fullDays.reduce((a, d) => a + d.cost_usd, 0))} · 峰值 {fmtUsd(maxCost)}</p>
      <div className={s.trendWrap}>
        <div className={s.trendBars}>
          {fullDays.map(d => (
            <div key={d.day} className={s.trendBarCol} title={`${d.day} · ${fmtUsd(d.cost_usd)} · ${d.count} 次`}>
              <div className={s.trendBar} style={{ height: `${Math.max(2, (d.cost_usd / maxCost) * 100)}%` }} />
            </div>
          ))}
        </div>
        <div className={s.trendAxis}>
          {fullDays.map((d, i) => (
            <span key={d.day} className={s.trendAxisLabel}>
              {labelIdxs.has(i) ? d.day.slice(5) : ''}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Call site table ──────────────────────────────────────────────────
function CallSiteTable({ bySite, grandTotal }) {
  const rows = useMemo(() => {
    return Object.entries(bySite)
      .map(([cs, v]) => ({ cs, ...v }))
      .sort((a, b) => b.cost_usd - a.cost_usd);
  }, [bySite]);

  if (rows.length === 0) {
    return (
      <div className={s.section}>
        <h3 className={s.sectionTitle}>按调用点 (call_site)</h3>
        <div className={s.emptyBox}>本期无数据</div>
      </div>
    );
  }

  return (
    <div className={s.section}>
      <h3 className={s.sectionTitle}>按调用点 (call_site)</h3>
      <p className={s.sectionHint}>从大到小排序;成本条占比反映该 call_site 在本产品线 LLM 总成本中的占比。</p>
      <table className={s.table}>
        <thead>
          <tr>
            <th>调用点</th>
            <th className={s.cellRight}>调用次数</th>
            <th className={s.cellRight}>输入 (含缓存)</th>
            <th className={s.cellRight}>输出</th>
            <th className={s.cellRight}>成本 (USD)</th>
            <th>占比</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const pct = grandTotal > 0 ? (row.cost_usd / grandTotal) * 100 : 0;
            return (
              <tr key={row.cs}>
                <td className={s.callSite}>{row.cs}</td>
                <td className={s.cellRight}>{row.count}</td>
                <td className={s.cellRight}>{fmtTokens(row.prompt + row.cache_read + row.cache_create)}</td>
                <td className={s.cellRight}>{fmtTokens(row.completion)}</td>
                <td className={s.cellRight}>{fmtUsd(row.cost_usd)}</td>
                <td className={s.barCell}>
                  <div className={s.barFill} style={{ width: `${Math.min(100, pct)}%` }} />
                  <span className={s.cellMuted}>{pct.toFixed(1)}%</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Model table ──────────────────────────────────────────────────────
function ModelTable({ byModel, grandTotal }) {
  const rows = useMemo(() => {
    return Object.entries(byModel)
      .map(([m, v]) => ({ m, ...v }))
      .sort((a, b) => b.cost_usd - a.cost_usd);
  }, [byModel]);

  if (rows.length === 0) return null;

  return (
    <div className={s.section}>
      <h3 className={s.sectionTitle}>按模型</h3>
      <table className={s.table}>
        <thead>
          <tr>
            <th>模型</th>
            <th className={s.cellRight}>调用次数</th>
            <th className={s.cellRight}>输入 (含缓存)</th>
            <th className={s.cellRight}>输出</th>
            <th className={s.cellRight}>成本 (USD)</th>
            <th>占比</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const pct = grandTotal > 0 ? (row.cost_usd / grandTotal) * 100 : 0;
            return (
              <tr key={row.m}>
                <td className={s.callSite}>{shortModelName(row.m)}</td>
                <td className={s.cellRight}>{row.count}</td>
                <td className={s.cellRight}>{fmtTokens(row.prompt + row.cache_read + row.cache_create)}</td>
                <td className={s.cellRight}>{fmtTokens(row.completion)}</td>
                <td className={s.cellRight}>{fmtUsd(row.cost_usd)}</td>
                <td className={s.barCell}>
                  <div className={s.barFill} style={{ width: `${Math.min(100, pct)}%` }} />
                  <span className={s.cellMuted}>{pct.toFixed(1)}%</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Volume + derived ─────────────────────────────────────────────────
function VolumeSection({ volume, llmCost, adSpend }) {
  const totalForLead = llmCost + adSpend;
  const costPerConv = volume.conversations > 0 ? totalForLead / volume.conversations : 0;
  const costPerLead = volume.leads_qualified > 0 ? totalForLead / volume.leads_qualified : 0;
  const llmPerInbound = volume.msgs_in > 0 ? llmCost / volume.msgs_in : 0;

  return (
    <div className={s.section}>
      <h3 className={s.sectionTitle}>量化指标 · 单位成本</h3>
      <div className={s.volumeGrid}>
        <Cell label="本期新开对话" value={volume.conversations} />
        <Cell label="本期入站消息" value={volume.msgs_in} />
        <Cell label="本期出站消息" value={volume.msgs_out} />
        <Cell label="本期合格线索 GOOD+" value={volume.leads_qualified} />
        <Cell label="本期 KB 新增文档" value={volume.kb_docs} />
        <Cell label="单新开对话成本" value={fmtUsd(costPerConv)} />
        <Cell label="单合格线索成本" value={fmtUsd(costPerLead)} />
        <Cell label="单入站消息 LLM 成本" value={fmtUsd(llmPerInbound)} />
      </div>
    </div>
  );
}

function Cell({ label, value }) {
  return (
    <div className={s.volumeCell}>
      <div className={s.volumeLabel}>{label}</div>
      <div className={s.volumeValue}>{value}</div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────
function fmtUsd(n) {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return '$' + v.toFixed(4);
  if (v < 1) return '$' + v.toFixed(3);
  if (v < 1000) return '$' + v.toFixed(2);
  if (v < 100_000) return '$' + v.toFixed(0);
  return '$' + (v / 1000).toFixed(1) + 'K';
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v === 0) return '0';
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K';
  return String(v);
}

function shortModelName(m) {
  return String(m).replace(/^anthropic\//, '').replace(/^openai\//, '').replace(/^google\//, '');
}

function computeDelta(curr, prev) {
  if (!prev || prev === 0) {
    return { kind: curr > 0 ? 'up' : 'flat', pct: null };
  }
  const diff = curr - prev;
  const pct = (diff / prev) * 100;
  return { kind: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat', pct };
}

function renderDelta(d) {
  if (d.pct == null) return <span className={s.deltaFlat}>无上期数据</span>;
  const cls = d.kind === 'up' ? s.deltaUp : d.kind === 'down' ? s.deltaDown : s.deltaFlat;
  const sign = d.kind === 'up' ? '↑' : d.kind === 'down' ? '↓' : '—';
  return <span className={cls}>{sign} {Math.abs(d.pct).toFixed(1)}% vs 上期</span>;
}

function fillMissingDays(days, rangeDays) {
  const map = new Map(days.map(d => [d.day, d]));
  const out = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    out.push(map.get(key) || { day: key, cost_usd: 0, count: 0 });
  }
  return out;
}

function pickLabelIndices(len) {
  if (len <= 7) return new Set(Array.from({ length: len }, (_, i) => i));
  // 头、尾、再 3 个中间均分采样
  const idxs = new Set([0, len - 1]);
  for (let k = 1; k <= 3; k++) {
    idxs.add(Math.round((k / 4) * (len - 1)));
  }
  return idxs;
}
