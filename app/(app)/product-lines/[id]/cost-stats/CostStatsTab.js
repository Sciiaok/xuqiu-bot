'use client';

import { useEffect, useState, useMemo } from 'react';
import s from './CostStatsTab.module.css';
import { DATE_PRESETS, resolveDateRange } from '../../../../../lib/date-range-presets';
import { COST_STATS_FLOOR_LABEL } from '../../../../../lib/cost-stats-floor';

/**
 * CostStatsTab — 产品线粒度成本分析。
 *
 * 关键设计:
 *   - 时间窗口跟 leadhub 一致(全部 / 昨天 / 前一周 / 前一个月 / 前一年 / 自定义),
 *     yesterday-aligned 北京时区,共用 lib/date-range-presets.js。
 *   - "成本视角" 切换 Medici-only vs 全成本:
 *       Medici-only: 仅 LLM Medici 类成本(运营产品线本身花的钱)
 *       全成本(default): Medici + Ogilvy 工作台(推理+图片) + Meta 广告花费
 *     "实际投入这条产品线的总钱"用全成本更直观。
 *   - 数据源:
 *       /api/product-lines/[id]/cost-stats — medici / ogilvy / volume / prev
 *       /api/ads/dashboard                 — Meta 广告花费 (复用现成 endpoint)
 *     两路并行 fetch,广告挂掉不影响 LLM 区域。
 */
const VIEW_OPTIONS = [
  { key: 'all',    label: '全成本' },
  { key: 'medici', label: '仅 Medici' },
];

export default function CostStatsTab({ productLineId }) {
  const [preset, setPreset] = useState('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [view, setView] = useState('all'); // 'all' | 'medici'
  const [stats, setStats] = useState(null);
  const [adSummary, setAdSummary] = useState(null);
  const [adError, setAdError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // 把当前 preset/custom 化为 ISO 范围,用来串到两个 endpoint。
  const range = useMemo(
    () => resolveDateRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  useEffect(() => {
    // custom 模式只在用户填了两端日期才发请求,否则等输入。
    if (preset === 'custom' && (!range.dateFrom || !range.dateTo)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    setAdError('');

    const statsQs = new URLSearchParams({ preset });
    // custom mode: 直接传 YYYY-MM-DD(input 原值),route 会再调一次 resolveDateRange
    // 把它扩成北京时区的 [00:00, 23:59.999] —— UI 已 resolve 过的 ISO 串再丢回去
    // 会被 dateInputToIso 拼坏(2026-...ZT00:00:00.000+08:00),route 500。
    if (preset === 'custom') {
      if (customFrom) statsQs.set('from', customFrom);
      if (customTo) statsQs.set('to', customTo);
    }
    const statsPromise = fetch(`/api/product-lines/${productLineId}/cost-stats?${statsQs.toString()}`)
      .then(async r => {
        if (!r.ok) throw new Error((await r.json()).error || `HTTP ${r.status}`);
        return r.json();
      });

    // 切到专用的 Ogilvy-only ad spend endpoint —— 只数从本产品线 Ogilvy
    // launch 出去的 campaign,跟整个产品线 wa_phone_number_id 反推的 dashboard
    // 口径不同。dashboard 会把用户在 Meta Ads Manager 手工建的广告也算进来,
    // 这里只算 Ogilvy 真创编的活动。
    const adsQs = new URLSearchParams();
    if (range.dateFrom) adsQs.set('from', range.dateFrom);
    if (range.dateTo) adsQs.set('to', range.dateTo);
    const adsPromise = fetch(`/api/product-lines/${productLineId}/ogilvy-ad-spend?${adsQs}`)
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
      if (adsRes.status === 'fulfilled' && adsRes.value) {
        const v = adsRes.value;
        // 新 endpoint 返回 {spend, wa_conversations, cpa, campaign_count, ad_count, source}
        // 对齐旧 dashboard summary shape 让下游代码不用再改一遍
        setAdSummary({
          spend: v.spend,
          waConversations: v.wa_conversations,
          cpa: v.cpa,
          campaignCount: v.campaign_count,
          adCount: v.ad_count,
          source: v.source,
        });
      } else if (adsRes.status === 'rejected') {
        setAdError(adsRes.reason?.message || '广告数据加载失败');
      }
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [productLineId, preset, range.dateFrom, range.dateTo]);

  if (loading && !stats) {
    return <div className={s.loading}><span className={s.spinner} />加载成本数据…</div>;
  }
  if (error) return <div className={s.errorBox}>加载失败: {error}</div>;
  if (!stats) return (
    <div className={s.root}>
      <RangeBar
        preset={preset} setPreset={setPreset}
        customFrom={customFrom} setCustomFrom={setCustomFrom}
        customTo={customTo} setCustomTo={setCustomTo}
        view={view} setView={setView}
      />
      <div className={s.emptyBox}>请选择自定义日期范围</div>
    </div>
  );

  // ── 数据切片:view 决定显示 Medici-only 还是全成本 ──
  const mediciCost = Number(stats.medici.totals.cost_usd) || 0;
  const ogilvyReasoningCost = Number(stats.ogilvy.reasoning_usd) || 0;
  const ogilvyImageCost = Number(stats.ogilvy.image_usd) || 0;
  const ogilvyCost = ogilvyReasoningCost + ogilvyImageCost;
  const adSpend = Number(adSummary?.spend) || 0;

  const showOgilvy = view === 'all';
  const showAds = view === 'all';
  const totalCost = mediciCost + (showOgilvy ? ogilvyCost : 0) + (showAds ? adSpend : 0);

  const mediciPrev = Number(stats.medici_prev?.cost_usd) || 0;
  const ogilvyPrev = Number(stats.ogilvy_prev?.cost_usd) || 0;
  const totalPrev = mediciPrev + (showOgilvy ? ogilvyPrev : 0);  // 广告上期对比走 ads/dashboard 自身,不在这里加
  const totalDelta = computeDelta(totalCost - (showAds ? adSpend : 0), totalPrev);

  // 合并 medici + ogilvy 的子表/趋势(仅 view=all 时)
  const combinedByCallSite = showOgilvy
    ? mergeBuckets(stats.medici.by_call_site, stats.ogilvy.by_call_site)
    : stats.medici.by_call_site;
  const combinedByModel = showOgilvy
    ? mergeBuckets(stats.medici.by_model, stats.ogilvy.by_model)
    : stats.medici.by_model;
  const combinedByDay = showOgilvy
    ? mergeDays(stats.medici.by_day, stats.ogilvy.by_day)
    : stats.medici.by_day;
  const grandTotal = mediciCost + (showOgilvy ? ogilvyCost : 0);

  return (
    <div className={`${s.root} ${loading ? s.refreshing : ''}`}>
      <RangeBar
        preset={preset} setPreset={setPreset}
        customFrom={customFrom} setCustomFrom={setCustomFrom}
        customTo={customTo} setCustomTo={setCustomTo}
        view={view} setView={setView}
      />

      {/* ── KPI strip ──────────────────────────────────────────────── */}
      <div className={s.kpiGrid}>
        <KpiCard
          label="本期总成本"
          value={fmtUsd(totalCost)}
          sub={showAds && showOgilvy
            ? '= Medici + Ogilvy + 广告'
            : showOgilvy ? '= Medici + Ogilvy' : '= 仅 Medici'}
        />
        <KpiCard
          label="Medici"
          value={fmtUsd(mediciCost)}
          sub={<>{stats.medici.totals.count} 次调用 · {renderDelta(computeDelta(mediciCost, mediciPrev))}</>}
        />
        {showOgilvy && (
          <KpiCard
            label="Ogilvy"
            value={fmtUsd(ogilvyCost)}
            sub={`推理 ${fmtUsd(ogilvyReasoningCost)} · 图 ${stats.ogilvy.image_count}张 ${fmtUsd(ogilvyImageCost)}`}
          />
        )}
        {showAds && (
          <KpiCard
            label="广告消耗"
            value={adError ? '—' : fmtUsd(adSpend)}
            sub={adError
              ? '数据不可用'
              : adSummary?.source === 'no_campaigns'
                ? '本产品线暂无 Ogilvy 投放活动'
                : adSummary?.source === 'meta_not_connected'
                  ? 'Meta 未连接,无法拉取花费'
                  : `${adSummary?.campaignCount || 0} 个活动 · ${adSummary?.waConversations || 0} 个 WA 对话 · CPA ${fmtUsd(adSummary?.cpa || 0)}`}
          />
        )}
        {totalDelta && totalDelta.pct != null && (
          <KpiCard
            label="vs 上期 (LLM)"
            value={renderDelta(totalDelta)}
            sub={`Medici ${fmtUsd(mediciPrev)}${showOgilvy ? ` · Ogilvy ${fmtUsd(ogilvyPrev)}` : ''}`}
          />
        )}
      </div>

      {/* ── Daily trend ────────────────────────────────────────────── */}
      <DailyTrend days={combinedByDay} rangeDays={stats.range.days} preset={preset} />

      {/* ── AI by call_site ────────────────────────────────────────── */}
      <CallSiteTable bySite={combinedByCallSite} grandTotal={grandTotal} />

      {/* ── AI by model ────────────────────────────────────────────── */}
      <ModelTable byModel={combinedByModel} grandTotal={grandTotal} />

      {/* ── Volume + derived ───────────────────────────────────────── */}
      <VolumeSection
        volume={stats.volume}
        llmCost={grandTotal}
        adSpend={showAds ? adSpend : 0}
      />

      <p className={s.notice}>
        {view === 'all' ? (
          <>
            说明: <b>Medici 类</b>包含 medici 应答、KB 搜索/上传/视觉理解、知识教学、画像总结、单产品线日报;
            <b>Ogilvy 类</b>包含本产品线所有 Ogilvy 项目的会话推理、网页搜索、图片生成;
            <b>广告花费</b>严格按"本产品线下从 Ogilvy launch 出去的活动"统计 ——
            通过 <code>autopilot_sessions.meta_campaign_ids</code> 反查 Meta /insights,
            手工在 Meta Ads Manager 建的广告不计入。
          </>
        ) : (
          <>说明: 当前视角仅显示运营产品线本身的 LLM Medici 类成本(应答 / KB / 画像 / 日报),不含 Ogilvy 工作台和广告花费。切到「全成本」可看全部。</>
        )}
      </p>
    </div>
  );
}

// ── Range selector + view toggle ─────────────────────────────────────
function RangeBar({ preset, setPreset, customFrom, setCustomFrom, customTo, setCustomTo, view, setView }) {
  return (
    <>
      <div className={s.rangeBar}>
        <div className={s.rangePills}>
          {DATE_PRESETS.map(opt => (
            <button
              key={opt.key}
              className={`${s.rangePill} ${preset === opt.key ? s.rangePillActive : ''}`}
              onClick={() => {
                setPreset(opt.key);
                if (opt.key !== 'custom') { setCustomFrom(''); setCustomTo(''); }
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className={s.customRange}>
            <input type="date" value={customFrom} max={customTo || undefined}
              onChange={e => setCustomFrom(e.target.value)} />
            <span className={s.rangeSep}>→</span>
            <input type="date" value={customTo} min={customFrom || undefined}
              onChange={e => setCustomTo(e.target.value)} />
          </div>
        )}
        <div className={s.viewPills}>
          {VIEW_OPTIONS.map(opt => (
            <button
              key={opt.key}
              className={`${s.viewPill} ${view === opt.key ? s.viewPillActive : ''}`}
              onClick={() => setView(opt.key)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <p className={s.floorHint}>
        统计自 <b>{COST_STATS_FLOOR_LABEL} 00:00 (Asia/Shanghai)</b> 起 ——
        更早的 LLM 调用与广告花费属早期联调脏数据,已在服务端硬剔除,不受上方时间窗影响。
      </p>
    </>
  );
}

// ── KPI card ─────────────────────────────────────────────────────────
function KpiCard({ label, value, sub }) {
  return (
    <div className={s.kpiCard}>
      <div className={s.kpiLabel}>{label}</div>
      <div className={s.kpiValue}>{value}</div>
      {sub ? <div className={s.kpiSub}>{sub}</div> : null}
    </div>
  );
}

// ── Daily trend ──────────────────────────────────────────────────────
function DailyTrend({ days, rangeDays, preset }) {
  // custom / all 下没有固定 rangeDays,直接按返回的 days 长度展示
  const fullDays = useMemo(() => {
    if (preset === 'custom' || preset === 'all' || !rangeDays) return days;
    return fillMissingDays(days, rangeDays);
  }, [days, rangeDays, preset]);
  const maxCost = Math.max(0.0001, ...fullDays.map(d => d.cost_usd));

  if (fullDays.every(d => d.cost_usd === 0)) {
    return (
      <div className={s.section}>
        <h3 className={s.sectionTitle}>LLM 每日成本</h3>
        <div className={s.emptyBox}>本期无可归属调用</div>
      </div>
    );
  }
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
  const rows = useMemo(
    () => Object.entries(bySite).map(([cs, v]) => ({ cs, ...v })).sort((a, b) => b.cost_usd - a.cost_usd),
    [bySite],
  );
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
  const rows = useMemo(
    () => Object.entries(byModel).map(([m, v]) => ({ m, ...v })).sort((a, b) => b.cost_usd - a.cost_usd),
    [byModel],
  );
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
        <Cell
          label="本期新开对话"
          value={volume.conversations}
          hint="按对话开启时间（started_at）统计。与 LeadHub「时间」筛选不同——后者按最近消息时间，所以同一天数字可能略低。"
        />
        <Cell label="本期入站消息" value={volume.msgs_in} />
        <Cell label="本期出站消息" value={volume.msgs_out} />
        <Cell label="本期合格线索 GOOD+" value={volume.leads_qualified} />
        <Cell label="本期 KB 新增文档" value={volume.kb_docs} />
        <Cell
          label="单新开对话成本"
          value={fmtUsd(costPerConv)}
          hint="分母为本期新开对话数（按 started_at）。"
        />
        <Cell label="单合格线索成本" value={fmtUsd(costPerLead)} />
        <Cell label="单入站消息 LLM 成本" value={fmtUsd(llmPerInbound)} />
      </div>
    </div>
  );
}

function Cell({ label, value, hint }) {
  return (
    <div className={s.volumeCell} title={hint || undefined}>
      <div className={s.volumeLabel}>
        {label}
        {hint ? <span className={s.volumeHint} aria-hidden="true"> ⓘ</span> : null}
      </div>
      <div className={s.volumeValue}>{value}</div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────
function mergeBuckets(a, b) {
  const out = {};
  for (const [k, v] of Object.entries(a || {})) out[k] = { ...v };
  for (const [k, v] of Object.entries(b || {})) {
    if (!out[k]) out[k] = { prompt: 0, completion: 0, cache_read: 0, cache_create: 0, cost_usd: 0, count: 0 };
    out[k].prompt += v.prompt || 0;
    out[k].completion += v.completion || 0;
    out[k].cache_read += v.cache_read || 0;
    out[k].cache_create += v.cache_create || 0;
    out[k].cost_usd += v.cost_usd || 0;
    out[k].count += v.count || 0;
  }
  return out;
}

function mergeDays(a, b) {
  const m = new Map();
  for (const d of a || []) m.set(d.day, { day: d.day, cost_usd: d.cost_usd, count: d.count });
  for (const d of b || []) {
    const existing = m.get(d.day);
    if (existing) {
      existing.cost_usd += d.cost_usd;
      existing.count += d.count;
    } else {
      m.set(d.day, { day: d.day, cost_usd: d.cost_usd, count: d.count });
    }
  }
  return Array.from(m.values()).sort((a, b) => a.day.localeCompare(b.day));
}

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
  if (!prev || prev === 0) return { kind: curr > 0 ? 'up' : 'flat', pct: null };
  const diff = curr - prev;
  const pct = (diff / prev) * 100;
  return { kind: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat', pct };
}

function renderDelta(d) {
  if (!d || d.pct == null) return <span className={s.deltaFlat}>无上期数据</span>;
  const cls = d.kind === 'up' ? s.deltaUp : d.kind === 'down' ? s.deltaDown : s.deltaFlat;
  const sign = d.kind === 'up' ? '↑' : d.kind === 'down' ? '↓' : '—';
  return <span className={cls}>{sign} {Math.abs(d.pct).toFixed(1)}%</span>;
}

function fillMissingDays(days, rangeDays) {
  const map = new Map(days.map(d => [d.day, d]));
  const out = [];
  // yesterday-aligned 跟 lib/date-range-presets.js 一致:UI 显示的 N 天柱图
  // = 昨天 → 昨天-(N-1),不含今天。今天 LLM 数据通常还没归集完。
  // 必须按 Asia/Shanghai 算 yesterday + 补零 key,否则跟服务端 dayBucket(也按
  // 北京日历日)对不上 —— map.get 全 miss,补出来全是空格。
  const TZ = 'Asia/Shanghai';
  const todayBjStr = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const yesterday = new Date(`${todayBjStr}T00:00:00+08:00`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date(yesterday.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toLocaleDateString('en-CA', { timeZone: TZ });
    out.push(map.get(key) || { day: key, cost_usd: 0, count: 0 });
  }
  return out;
}

function pickLabelIndices(len) {
  if (len <= 7) return new Set(Array.from({ length: len }, (_, i) => i));
  const idxs = new Set([0, len - 1]);
  for (let k = 1; k <= 3; k++) idxs.add(Math.round((k / 4) * (len - 1)));
  return idxs;
}
