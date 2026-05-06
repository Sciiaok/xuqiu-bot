'use client';

import { useEffect, useMemo, useState } from 'react';
import s from './page.module.css';

const PRESETS = [
  { key: 'today',  label: '今日',     days: 1 },
  { key: 'week',   label: '近 7 天',  days: 7 },
  { key: 'month',  label: '近 30 天', days: 30 },
];

function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function fmtUsd(n) {
  if (n == null) return '$0';
  if (n < 0.01) return `$${Number(n).toFixed(6)}`;
  if (n < 1)    return `$${Number(n).toFixed(4)}`;
  return `$${Number(n).toFixed(2)}`;
}

function fmtInt(n) {
  return Number(n || 0).toLocaleString();
}

export default function AdminLlmUsagePage() {
  const [preset, setPreset] = useState('week');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const range = useMemo(() => {
    const p = PRESETS.find(x => x.key === preset) || PRESETS[1];
    return { from: isoDaysAgo(p.days), to: new Date().toISOString() };
  }, [preset]);

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
          系统所有 LLM 调用的 token 用量与成本统计。按租户 / 调用部位 / 模型分别聚合（仅 founder 可见）。
          {' '}成本根据 <code>src/llm-pricing.js</code> 的静态价表估算，仅供参考。
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
      ) : (
        <>
          <div className={s.statRow}>
            <Stat label="总成本 (USD)" value={fmtUsd(data.totals.cost_usd)} />
            <Stat label="调用次数"     value={fmtInt(data.totals.calls)} />
            <Stat label="Prompt tokens"     value={fmtInt(data.totals.prompt_tokens)} />
            <Stat label="Completion tokens" value={fmtInt(data.totals.completion_tokens)} />
          </div>

          <Section title="按租户" empty="范围内没有调用">
            <table className={s.table}>
              <thead>
                <tr><th>租户</th><th className={s.numCol}>调用</th><th className={s.numCol}>Prompt</th><th className={s.numCol}>Completion</th><th className={s.numCol}>成本</th></tr>
              </thead>
              <tbody>
                {data.byTenant.map(r => (
                  <tr key={r.tenant_id || '__null__'}>
                    <td>
                      <div className={s.cellMain}>{r.tenant_name}</div>
                      <div className={s.muted}>{r.tenant_id || '—'}</div>
                    </td>
                    <td className={s.numCol}>{fmtInt(r.calls)}</td>
                    <td className={s.numCol}>{fmtInt(r.prompt_tokens)}</td>
                    <td className={s.numCol}>{fmtInt(r.completion_tokens)}</td>
                    <td className={`${s.numCol} ${s.cost}`}>{fmtUsd(r.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="按调用部位 (call_site)" empty="范围内没有调用">
            <table className={s.table}>
              <thead>
                <tr><th>Call site</th><th className={s.numCol}>调用</th><th className={s.numCol}>Prompt</th><th className={s.numCol}>Completion</th><th className={s.numCol}>成本</th></tr>
              </thead>
              <tbody>
                {data.byCallSite.map(r => (
                  <tr key={r.call_site}>
                    <td><code>{r.call_site}</code></td>
                    <td className={s.numCol}>{fmtInt(r.calls)}</td>
                    <td className={s.numCol}>{fmtInt(r.prompt_tokens)}</td>
                    <td className={s.numCol}>{fmtInt(r.completion_tokens)}</td>
                    <td className={`${s.numCol} ${s.cost}`}>{fmtUsd(r.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <Section title="按模型" empty="范围内没有调用">
            <table className={s.table}>
              <thead>
                <tr><th>Model</th><th className={s.numCol}>调用</th><th className={s.numCol}>Prompt</th><th className={s.numCol}>Completion</th><th className={s.numCol}>成本</th></tr>
              </thead>
              <tbody>
                {data.byModel.map(r => (
                  <tr key={r.model}>
                    <td><code>{r.model}</code></td>
                    <td className={s.numCol}>{fmtInt(r.calls)}</td>
                    <td className={s.numCol}>{fmtInt(r.prompt_tokens)}</td>
                    <td className={s.numCol}>{fmtInt(r.completion_tokens)}</td>
                    <td className={`${s.numCol} ${s.cost}`}>{fmtUsd(r.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>

          <div className={s.footnote}>
            采样 {fmtInt(data.sampleSize)} 行（上限 50000）。
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className={s.stat}>
      <div className={s.statLabel}>{label}</div>
      <div className={s.statValue}>{value}</div>
    </div>
  );
}

function Section({ title, children, empty }) {
  return (
    <section className={s.section}>
      <h2 className={s.sectionTitle}>{title}</h2>
      <div className={s.tableWrap}>
        {children}
      </div>
    </section>
  );
}
