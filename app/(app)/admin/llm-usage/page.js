'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import s from './page.module.css';

const PRESETS = [
  { key: 'today',  label: '今日',     days: 1 },
  { key: 'week',   label: '近 7 天',  days: 7 },
  { key: 'month',  label: '近 30 天', days: 30 },
  { key: 'q',      label: '近 90 天', days: 90 },
];

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function fmtUsd(n, { compact = false } = {}) {
  const v = Number(n) || 0;
  if (compact && v >= 1000) return `$${(v / 1000).toFixed(2)}K`;
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(6)}`;
  if (v < 1)    return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString();
}

function fmtCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

function fmtMs(n) {
  if (n == null) return '—';
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}s`;
  if (n >= 1000)   return `${(n / 1000).toFixed(2)}s`;
  return `${n} ms`;
}

function fmtPct(x) {
  const v = (Number(x) || 0) * 100;
  if (v === 0) return '0%';
  if (v < 0.1) return '<0.1%';
  if (v < 10)  return `${v.toFixed(1)}%`;
  return `${Math.round(v)}%`;
}

function fmtDayShort(iso) {
  // 'YYYY-MM-DD' → 'MM/DD'
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${m}/${d}`;
}

function fmtHourShort(key, { withDate = true } = {}) {
  // 'YYYY-MM-DD HH:00' → 'MM/DD HH:00' 或 'HH:00'
  if (!key) return '';
  const [day, hm] = key.split(' ');
  if (!withDate) return hm || '';
  const [, m, d] = day.split('-');
  return `${m}/${d} ${hm || ''}`;
}

export default function AdminLlmUsagePage() {
  const [preset, setPreset] = useState('week');
  const [granularity, setGranularity] = useState('day'); // 'hour' | 'day'
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const range = useMemo(() => {
    const p = PRESETS.find(x => x.key === preset) || PRESETS[1];
    return { from: isoDaysAgo(p.days), to: new Date().toISOString(), days: p.days };
  }, [preset]);

  // 切换 preset 时给个合理默认：今日→小时，其它→天
  useEffect(() => {
    setGranularity(range.days <= 1 ? 'hour' : 'day');
  }, [range.days]);

  useEffect(() => {
    let aborted = false;
    setLoading(true);
    setError('');
    fetch(`/api/admin/llm-usage?from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`)
      .then(async (res) => {
        const body = await res.json();
        if (aborted) return;
        if (!res.ok) throw new Error(body?.error || '加载失败');
        setData(body);
      })
      .catch(err => { if (!aborted) setError(err.message); })
      .finally(() => { if (!aborted) setLoading(false); });
    return () => { aborted = true; };
  }, [range.from, range.to]);

  return (
    <div className={s.page}>
      <div className={s.header}>
        <h1 className={s.title}>大模型成本</h1>
        <p className={s.subtitle}>
          按租户 / 调用部位 / 模型 / Provider 聚合的 token 用量、成本与延迟（仅 founder 可见）。
          时间桶按 <code>Asia/Shanghai</code>。成本读自 <code>llm_usage_logs.cost_usd</code>，
          由 <code>src/llm-pricing.js</code> 静态价表在写入时估算，<b>仅供参考</b>。
          <br />
          覆盖范围：chat completions / embeddings / Whisper / 图片生成
          （embeddings + Whisper 自 2026-05-18 起埋点；之前的历史调用不在表里）。
          延迟均值 / 百分位 / 单次成本均剔除失败调用（<code>finish_reason</code> 以 <code>error:</code> 开头）。
        </p>
      </div>

      <div className={s.toolbar}>
        <div className={s.presetGroup}>
          {PRESETS.map(p => (
            <button
              key={p.key}
              className={preset === p.key ? `${s.presetBtn} ${s.presetActive}` : s.presetBtn}
              onClick={() => setPreset(p.key)}
            >{p.label}</button>
          ))}
        </div>
        <div className={s.rangeNote}>
          {new Date(range.from).toLocaleString()} → {new Date(range.to).toLocaleString()}
        </div>
      </div>

      {error && <div className={s.error}>{error}</div>}

      {loading || !data ? (
        <div className={s.muted}>加载中…</div>
      ) : data.totals.calls === 0 ? (
        <div className={s.empty}>该时间范围内没有 LLM 调用记录。</div>
      ) : (
        <>
          <DataHealthBanner totals={data.totals} notes={data.notes} />

          <div className={s.statRow}>
            <Stat
              label="总成本 (USD)"
              value={fmtUsd(data.totals.cost_usd)}
              sub={
                data.totals.successful_calls > 0
                  ? `${fmtUsd(data.totals.cost_per_day)} / 天 · ${fmtUsd(data.totals.avg_cost_per_call)} / 成功调用`
                  : `${fmtUsd(data.totals.cost_per_day)} / 天 · 无成功调用`
              }
            />
            <Stat
              label="调用次数"
              value={fmtInt(data.totals.calls)}
              sub={data.totals.errors > 0
                ? `${data.totals.calls_per_day.toLocaleString()} / 天 · 失败 ${fmtInt(data.totals.errors)}`
                : `${data.totals.calls_per_day.toLocaleString()} / 天 · ${data.range.days} 天窗口`}
            />
            <Stat
              label="Token 总量"
              value={fmtCompact(data.totals.total_tokens)}
              sub={`${fmtCompact(data.totals.prompt_tokens)} in · ${fmtCompact(data.totals.completion_tokens)} out`}
            />
            <Stat
              label="平均延迟"
              value={fmtMs(data.totals.avg_duration_ms)}
              sub={data.totals.sampled_for_latency
                ? `p50 ${fmtMs(data.totals.p50_duration_ms)} · p95 ${fmtMs(data.totals.p95_duration_ms)}（仅成功）`
                : '无延迟数据'}
            />
            {data.hasCacheCols && (() => {
              const read  = data.totals.cache_read_input_tokens || 0;
              const write = data.totals.cache_creation_input_tokens || 0;
              const totalInput = (data.totals.prompt_tokens || 0) + read + write;
              return (
                <Stat
                  label="Prompt cache"
                  value={`${fmtCompact(read)} 命中`}
                  sub={`${fmtCompact(write)} 写入 · 输入命中率 ${fmtPct(totalInput ? read / totalInput : 0)}`}
                />
              );
            })()}
          </div>

          <TrendChart
            granularity={granularity}
            onGranularityChange={setGranularity}
            byDay={data.byDay}
            byHour={data.byHour}
            rangeDays={data.range.days}
          />

          <BreakdownTable
            title="按租户"
            rows={data.byTenant}
            firstHeader="租户"
            renderFirst={r => (
              <>
                <div className={s.cellMain}>{r.tenant_name}</div>
                <div className={s.muted}>{r.tenant_id || '—'}</div>
              </>
            )}
            rowKey={r => r.tenant_id || '__null__'}
            showCache={data.hasCacheCols}
            showErrors={data.totals.errors > 0}
          />

          <BreakdownTable
            title="按调用部位 (call_site)"
            rows={data.byCallSite}
            firstHeader="Call site"
            renderFirst={r => <code>{r.call_site}</code>}
            rowKey={r => r.call_site}
            showCache={data.hasCacheCols}
            showErrors={data.totals.errors > 0}
          />

          <BreakdownTable
            title="按模型"
            rows={data.byModel}
            firstHeader="Model"
            renderFirst={r => <code>{r.model}</code>}
            rowKey={r => r.model}
            showCache={data.hasCacheCols}
            showErrors={data.totals.errors > 0}
          />

          <BreakdownTable
            title="按 Provider"
            rows={data.byProvider}
            firstHeader="Provider"
            renderFirst={r => <code>{r.provider}</code>}
            rowKey={r => r.provider}
            showCache={data.hasCacheCols}
            showErrors={data.totals.errors > 0}
          />

          <div className={s.footnote}>
            采样 {fmtInt(data.sampleSize)} 行
            {data.capped && <span className={s.warn}>（已达 50000 行上限，结果可能不完整）</span>}
            · 延迟样本 {fmtInt(data.totals.sampled_for_latency)} 行
            {data.totals.errors > 0 && <> · 失败 {fmtInt(data.totals.errors)} 行（不参与延迟/单次成本均值）</>}
          </div>
        </>
      )}
    </div>
  );
}

// 数据健康提示：把 API notes 里能提示用户「数据不完整」的信息显式展示，
// 避免用户把这个看板当作权威账单。
function DataHealthBanner({ totals, notes }) {
  if (!notes) return null;
  const issues = [];
  if (totals.errors > 0) {
    issues.push(
      <li key="err">
        {fmtInt(totals.errors)} 条失败调用（占 {fmtPct(totals.calls ? totals.errors / totals.calls : 0)}）。
        延迟均值 / p50 / p95 / 单次成本 已自动剔除。
      </li>
    );
  }
  if (notes.untagged_call_site_rows > 0 || notes.untagged_tenant_rows > 0) {
    issues.push(
      <li key="untagged">
        未埋点：{fmtInt(notes.untagged_call_site_rows)} 行无 <code>call_site</code>，
        {fmtInt(notes.untagged_tenant_rows)} 行无 <code>tenant_id</code>
        （在「按租户」「按调用部位」表中分别落到 <code>(未埋点 / tenant 已删除)</code> 和 <code>unknown</code> 行）。
      </li>
    );
  }
  if (Array.isArray(notes.untracked_paths) && notes.untracked_paths.length > 0) {
    issues.push(
      <li key="untracked">
        未追踪路径：{notes.untracked_paths.map(p => <code key={p} style={{ marginRight: 6 }}>{p}</code>)}
        — 这部分成本不计入本看板。
      </li>
    );
  }
  if (issues.length === 0) return null;
  return (
    <div className={s.healthBanner}>
      <div className={s.healthTitle}>数据完整性提示</div>
      <ul className={s.healthList}>{issues}</ul>
    </div>
  );
}

function BreakdownTable({ title, rows, firstHeader, renderFirst, rowKey, showCache = false, showErrors = false }) {
  if (!rows || rows.length === 0) {
    return (
      <Section title={title}>
        <div className={s.emptyInline}>无数据</div>
      </Section>
    );
  }
  return (
    <Section title={title}>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>{firstHeader}</th>
              <th className={s.numCol}>调用</th>
              {showErrors && <th className={s.numCol} title="finish_reason 以 error: 开头">失败</th>}
              <th className={s.numCol}>Prompt</th>
              <th className={s.numCol}>Completion</th>
              {showCache && <th className={s.numCol} title="cache_read / cache_creation tokens">Cache R/W</th>}
              <th className={s.numCol} title="仅含成功调用（剔除 error 行）">平均延迟</th>
              <th className={s.numCol}>成本</th>
              <th className={s.numCol} title="本行成本 / 总成本">成本占比</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={rowKey(r)}>
                <td>{renderFirst(r)}</td>
                <td className={s.numCol}>{fmtInt(r.calls)}</td>
                {showErrors && (
                  <td className={`${s.numCol} ${r.errors > 0 ? s.errCell : ''}`}>
                    {r.errors > 0 ? fmtInt(r.errors) : '—'}
                  </td>
                )}
                <td className={s.numCol}>{fmtInt(r.prompt_tokens)}</td>
                <td className={s.numCol}>{fmtInt(r.completion_tokens)}</td>
                {showCache && (
                  <td className={s.numCol}>
                    {fmtCompact(r.cache_read_input_tokens)} / {fmtCompact(r.cache_creation_input_tokens)}
                  </td>
                )}
                <td className={s.numCol}>{fmtMs(r.avg_duration_ms)}</td>
                <td className={`${s.numCol} ${s.cost}`}>{fmtUsd(r.cost_usd)}</td>
                <td className={s.numCol}>
                  <ShareBar value={r.share} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function ShareBar({ value }) {
  const pct = Math.min(100, Math.max(0, (Number(value) || 0) * 100));
  return (
    <div className={s.shareCell}>
      <div className={s.shareBar}>
        <div className={s.shareBarFill} style={{ width: `${pct}%` }} />
      </div>
      <span className={s.shareText}>{fmtPct(value)}</span>
    </div>
  );
}

function TrendTooltip({ active, payload }) {
  if (!active || !payload || !payload[0]) return null;
  const p = payload[0].payload;
  // 桶 key 由后端按 Asia/Shanghai 切出，直接以字面值展示（不要再 toLocaleString，
  // 否则浏览器时区不为 +08:00 时会二次偏移，标签和 X 轴对不上）。
  const label = p.hour ? `${p.hour} (CN)` : p.day;
  return (
    <div className={s.tooltip}>
      <div className={s.tooltipDay}>{label}</div>
      <div className={s.tooltipRow}><span>成本</span><b>{fmtUsd(p.cost_usd)}</b></div>
      <div className={s.tooltipRow}><span>调用</span><b>{fmtInt(p.calls)}</b></div>
      {p.errors > 0 && (
        <div className={s.tooltipRow}><span>失败</span><b>{fmtInt(p.errors)}</b></div>
      )}
      <div className={s.tooltipRow}><span>Tokens</span><b>{fmtCompact((p.prompt_tokens || 0) + (p.completion_tokens || 0))}</b></div>
    </div>
  );
}

function TrendChart({ granularity, onGranularityChange, byDay, byHour, rangeDays }) {
  const isHour = granularity === 'hour';
  const series = isHour ? (byHour || []) : (byDay || []);
  if (series.length <= 1) return null;
  const dataKey = isHour ? 'hour' : 'day';
  const tickFormatter = isHour
    ? (v) => fmtHourShort(v, { withDate: rangeDays > 1 })
    : fmtDayShort;
  // 小时维度下，长范围里 tick 太密，让 recharts 自动间隔
  const xAxisInterval = isHour && series.length > 48 ? 'preserveStartEnd' : 0;
  return (
    <Section
      title="成本走势"
      action={
        <div className={s.granGroup}>
          <button
            className={!isHour ? `${s.granBtn} ${s.granActive}` : s.granBtn}
            onClick={() => onGranularityChange('day')}
          >天</button>
          <button
            className={isHour ? `${s.granBtn} ${s.granActive}` : s.granBtn}
            onClick={() => onGranularityChange('hour')}
          >小时</button>
        </div>
      }
    >
      <div className={s.chartWrap}>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={series} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
            <defs>
              <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor="#4C7FF0" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#4C7FF0" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey={dataKey}
              tickFormatter={tickFormatter}
              interval={xAxisInterval}
              minTickGap={isHour ? 24 : 4}
              tick={{ fontSize: 11, fill: 'var(--text3)' }}
              tickLine={false}
              axisLine={{ stroke: 'var(--border)' }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: 'var(--text3)' }}
              tickLine={false}
              axisLine={false}
              width={48}
              tickFormatter={(v) => fmtUsd(v, { compact: true })}
            />
            <Tooltip content={<TrendTooltip />} />
            <Area
              type="monotone"
              dataKey="cost_usd"
              stroke="#4C7FF0"
              strokeWidth={1.75}
              fill="url(#costFill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Section>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className={s.stat}>
      <div className={s.statLabel}>{label}</div>
      <div className={s.statValue}>{value}</div>
      {sub && <div className={s.statSub}>{sub}</div>}
    </div>
  );
}

function Section({ title, action, children }) {
  return (
    <section className={s.section}>
      <div className={s.sectionHeader}>
        <h2 className={s.sectionTitle}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
