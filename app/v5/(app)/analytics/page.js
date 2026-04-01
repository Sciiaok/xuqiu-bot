'use client';

import { useState, useEffect, useRef } from 'react';
import s from './page.module.css';
import MetricCard from '../../components/MetricCard/MetricCard';
import AIPanel from '../../components/AIPanel/AIPanel';
import Card from '../../components/Card/Card';
import DataTable from '../../components/DataTable/DataTable';
import TabBar from '../../components/TabBar/TabBar';
import Tag from '../../components/Tag/Tag';
import Button from '../../components/Button/Button';
import Markdown from '../../components/Markdown/Markdown';

const SUPPLY_CHAINS = ['全部供应链', '农机', '汽车整车', '零配件'];

const DATE_TABS = [
  { key: '7d', label: '7D' },
  { key: '14d', label: '14D' },
  { key: '30d', label: '30D' },
  { key: 'custom', label: 'Custom' },
];

const HUMAN_NOW_TABS = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' },
];

const DATE_TAB_TO_DAYS = { '7d': 7, '14d': 14, '30d': 30 };
const HUMAN_NOW_TAB_TO_DAYS = { today: 1, '7d': 7, '30d': 30 };

const SUPPLY_CHAIN_COLORS = [
  'var(--accent)',
  'var(--teal)',
  'var(--purple)',
  'var(--amber)',
  'var(--green)',
];

function businessValueVariant(val) {
  if (!val) return 'low';
  const lower = String(val).toLowerCase();
  if (lower === 'high') return 'high';
  if (lower === 'medium' || lower === 'mid' || lower === 'avg') return 'avg';
  if (lower === 'good') return 'good';
  return 'low';
}

function calcDelta(today, yesterday) {
  if (yesterday == null || yesterday === 0) return null;
  const pct = Math.round(((today - yesterday) / yesterday) * 100);
  if (pct > 0) return `↑ +${pct}%`;
  if (pct < 0) return `↓ ${pct}%`;
  return null;
}

function calcTrend(today, yesterday) {
  if (yesterday == null || yesterday === 0) return 'neutral';
  return today >= yesterday ? 'up' : 'down';
}

// Country/supply chain distributions now come from API response (all leads in date range)

export default function AnalyticsPage() {
  const [supplyChain, setSupplyChain] = useState('全部供应链');
  const [dateRange, setDateRange] = useState('7d');
  const [humanNowTab, setHumanNowTab] = useState('today');
  const [selectedRow, setSelectedRow] = useState(null);
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [humanPage, setHumanPage] = useState(1);
  const HUMAN_PAGE_SIZE = 10;

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [humanNowLoading, setHumanNowLoading] = useState(false);
  const [error, setError] = useState(null);

  const [aiInsight, setAiInsight] = useState(null);
  const [aiInsightLoading, setAiInsightLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState(null);

  const fetchAiInsight = async (days) => {
    const aiCacheKey = `ai_report:market_insight:${days}`;
    setAiInsightLoading(true);
    setAiInsight(null);
    setAiStatus(null);
    let accumulated = '';
    try {
      const res = await fetch(`/api/ai/report/stream?type=market_insight&days=${days}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === 'chunk') {
                accumulated += data.text;
                setAiInsight(accumulated);
              } else if (eventType === 'status') {
                setAiStatus(data.message);
              } else if (eventType === 'done') {
                setAiInsight(data.text);
                sessionStorage.setItem(aiCacheKey, data.text);
              } else if (eventType === 'error') {
                console.error('AI report stream error:', data.message);
              }
            } catch {}
            eventType = null;
          }
        }
      }
    } catch (err) {
      console.error('fetchAiInsight error:', err);
    } finally {
      setAiInsightLoading(false);
      setAiStatus(null);
    }
  };

  const prevMainDepsRef = useRef(null);

  useEffect(() => {
    let days;
    if (dateRange === 'custom') {
      if (!customFrom || !customTo) return;
      const msPerDay = 86400000;
      days = Math.max(1, Math.round((new Date(customTo) - new Date(customFrom)) / msPerDay) + 1);
    } else {
      days = DATE_TAB_TO_DAYS[dateRange] ?? 7;
    }

    const humanNowDays = HUMAN_NOW_TAB_TO_DAYS[humanNowTab] ?? 1;
    const country = supplyChain !== '全部供应链' ? supplyChain : undefined;

    // Determine if only humanNowTab changed (not a full page reload)
    const mainKey = `${dateRange}|${supplyChain}|${customFrom}|${customTo}`;
    const isHumanNowOnly = prevMainDepsRef.current !== null && prevMainDepsRef.current === mainKey;
    prevMainDepsRef.current = mainKey;

    if (isHumanNowOnly) {
      setHumanNowLoading(true);
    } else {
      setLoading(true);
    }
    setError(null);

    const params = new URLSearchParams({ days, humanNowDays });
    if (country) params.set('country', country);

    fetch(`/api/analytics?${params}`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(json => {
        setData(json);
        setLoading(false);
        setHumanNowLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
        setHumanNowLoading(false);
      });

    // Restore AI insight from sessionStorage cache; skip fetch if cached
    // Only reload AI insight when main filters change, not humanNowTab
    if (!isHumanNowOnly) {
      const aiCacheKey = `ai_report:market_insight:${days}`;
      const cached = sessionStorage.getItem(aiCacheKey);
      if (cached) {
        setAiInsight(cached);
      } else {
        fetchAiInsight(days);
      }
    }
  }, [dateRange, supplyChain, humanNowTab, customFrom, customTo]);

  // Derived values from API data
  const kpi = data?.kpi ?? {};
  const humanNowList = data?.humanNowList ?? [];

  const newConvToday = kpi.newConversations?.today ?? 0;
  const newConvYesterday = kpi.newConversations?.yesterday ?? null;
  const qualifyToday = kpi.qualifyRate?.today ?? 0;
  const qualifyYesterday = kpi.qualifyRate?.yesterday ?? null;
  const newLeadsToday = kpi.newLeads?.today ?? 0;
  const newLeadsYesterday = kpi.newLeads?.yesterday ?? null;
  const humanNowCount = kpi.humanNowCount ?? 0;

  // Reset page when tab/data changes
  useEffect(() => { setHumanPage(1); }, [humanNowTab, dateRange]);

  const humanTotalPages = Math.max(1, Math.ceil(humanNowList.length / HUMAN_PAGE_SIZE));
  const humanPagedList = humanNowList.slice((humanPage - 1) * HUMAN_PAGE_SIZE, humanPage * HUMAN_PAGE_SIZE);

  const humanNowRows = humanPagedList.map(item => [
    item.contactName || item.companyName || '—',
    item.country || '—',
    item.carModel || '—',
    item.qty || '—',
    <Tag key={item.id} variant={businessValueVariant(item.businessValue)}>
      {item.businessValue ?? '—'}
    </Tag>,
  ]);

  // Use API-returned distributions (all leads in date range), not humanNowList
  const topMarkets = data?.countryDistribution ?? [];
  const chainDistRaw = data?.supplyChainDistribution ?? [];
  const chainTotal = chainDistRaw.reduce((s, d) => s + d.value, 0) || 1;
  const chainBars = chainDistRaw.slice(0, 5).map((d, i) => ({
    label: d.name,
    pct: Math.round((d.value / chainTotal) * 100),
    color: SUPPLY_CHAIN_COLORS[i % SUPPLY_CHAIN_COLORS.length],
  }));

  return (
    <div className={s.root}>
      {/* Header */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>Analytics</h1>
          <span className={s.subtitle}>实时业务概览 · 数据截至今日 08:00</span>
        </div>
        <div className={s.headerRight}>
          <select
            className={s.supplySelect}
            value={supplyChain}
            onChange={e => setSupplyChain(e.target.value)}
          >
            {SUPPLY_CHAINS.map(sc => (
              <option key={sc} value={sc}>{sc}</option>
            ))}
          </select>
          <TabBar
            tabs={DATE_TABS}
            active={dateRange}
            onChange={setDateRange}
            style={{ flexShrink: 0 }}
          />
          {dateRange === 'custom' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="date"
                value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
                style={{
                  background: 'var(--bg2)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r, 6px)',
                  color: 'var(--text)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  padding: '6px 10px',
                }}
              />
              <span style={{ color: 'var(--text3)', fontFamily: 'var(--font-sans)', fontSize: 13 }}>—</span>
              <input
                type="date"
                value={customTo}
                onChange={e => setCustomTo(e.target.value)}
                style={{
                  background: 'var(--bg2)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r, 6px)',
                  color: 'var(--text)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  padding: '6px 10px',
                }}
              />
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Loading overlay */}
      {loading && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '48px 0',
          gap: 10,
          color: 'var(--text3)',
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
        }}>
          <div style={{
            width: 18,
            height: 18,
            border: '2px solid var(--border)',
            borderTopColor: 'var(--accent)',
            borderRadius: '50%',
            animation: 'spin 0.7s linear infinite',
          }} />
          Loading…
        </div>
      )}

      {/* Error state */}
      {!loading && error && (
        <div style={{
          padding: '16px',
          background: 'var(--red-dim)',
          border: '1px solid var(--red)',
          borderRadius: 'var(--r)',
          color: 'var(--red)',
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
        }}>
          Failed to load analytics: {error}
        </div>
      )}

      {/* Metric Cards */}
      {!loading && !error && (
        <>
          <div className={s.metrics}>
            <MetricCard
              label="新增对话"
              value={String(newConvToday)}
              delta={calcDelta(newConvToday, newConvYesterday)}
              trend={calcTrend(newConvToday, newConvYesterday)}
            />
            <MetricCard
              label="Qualify Rate"
              value={`${qualifyToday}%`}
              delta={calcDelta(qualifyToday, qualifyYesterday)}
              trend={calcTrend(qualifyToday, qualifyYesterday)}
            />
            <MetricCard
              label="新增线索"
              value={String(newLeadsToday)}
              delta={calcDelta(newLeadsToday, newLeadsYesterday)}
              trend={calcTrend(newLeadsToday, newLeadsYesterday)}
              color="amber"
            />
            <MetricCard
              label="Human Now 队列"
              value={String(humanNowCount)}
              trend="neutral"
              color="purple"
            />
          </div>

          {/* AI Panel */}
          <AIPanel
            title="今日市场洞察"
            tag={aiInsightLoading ? (aiStatus || '正在生成…') : aiInsight ? '自动生成' : '自动生成'}
            onRefresh={() => {
              const d = dateRange === 'custom' && customFrom && customTo
                ? Math.max(1, Math.round((new Date(customTo) - new Date(customFrom)) / 86400000) + 1)
                : DATE_TAB_TO_DAYS[dateRange] ?? 7;
              return fetchAiInsight(d);
            }}
            refreshLabel="↺ 刷新"
          >
            {aiInsight ? (
              <Markdown>{aiInsight}</Markdown>
            ) : aiInsightLoading ? (
              <div style={{ color: 'var(--text3)', fontSize: 13 }}>
                {aiStatus || '✦ 正在生成市场洞察…'}
              </div>
            ) : null}
          </AIPanel>

          {/* Bottom Two-Column Grid */}
          <div className={s.bottomGrid}>
            {/* Left: Human Now Leads Table */}
            <Card
              title={`Human Now Leads (${humanNowCount})`}
              actions={
                <TabBar
                  tabs={HUMAN_NOW_TABS}
                  active={humanNowTab}
                  onChange={setHumanNowTab}
                  style={{ marginLeft: 'auto' }}
                />
              }
            >
              {humanNowLoading ? (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '32px 0', gap: 8, color: 'var(--text3)', fontSize: 13,
                  fontFamily: 'var(--font-sans)',
                }}>
                  <div style={{
                    width: 16, height: 16,
                    border: '2px solid var(--border)', borderTopColor: 'var(--accent)',
                    borderRadius: '50%', animation: 'spin 0.7s linear infinite',
                  }} />
                  加载中…
                </div>
              ) : (
              <DataTable
                columns={['Contact', 'Country', 'Model', 'Qty', 'Value']}
                rows={humanNowRows}
                selectedIndex={selectedRow}
                onRowClick={setSelectedRow}
              />
              )}
              {!humanNowLoading && humanTotalPages > 1 && (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  gap: 6, padding: '10px 0 4px', borderTop: '1px solid var(--border)',
                  marginTop: 4,
                }}>
                  <button
                    onClick={() => setHumanPage(p => Math.max(1, p - 1))}
                    disabled={humanPage <= 1}
                    style={{
                      background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--r, 6px)',
                      padding: '3px 10px', fontSize: 11, color: humanPage <= 1 ? 'var(--text3)' : 'var(--text2)',
                      cursor: humanPage <= 1 ? 'default' : 'pointer', fontFamily: 'var(--font-sans)',
                    }}
                  >
                    ‹ 上一页
                  </button>
                  <span style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
                    {humanPage} / {humanTotalPages}
                  </span>
                  <button
                    onClick={() => setHumanPage(p => Math.min(humanTotalPages, p + 1))}
                    disabled={humanPage >= humanTotalPages}
                    style={{
                      background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--r, 6px)',
                      padding: '3px 10px', fontSize: 11, color: humanPage >= humanTotalPages ? 'var(--text3)' : 'var(--text2)',
                      cursor: humanPage >= humanTotalPages ? 'default' : 'pointer', fontFamily: 'var(--font-sans)',
                    }}
                  >
                    下一页 ›
                  </button>
                </div>
              )}
            </Card>

            {/* Right: Two stacked cards */}
            <div className={s.rightCol}>
              {/* Supply Chain Distribution */}
              <Card title="供应链线索分布">
                <div className={s.barList}>
                  {chainBars.length > 0 ? chainBars.map(bar => (
                    <div key={bar.label} className={s.barRow}>
                      <span className={s.barLabel}>{bar.label}</span>
                      <div className={s.barTrack}>
                        <div
                          className={s.barFill}
                          style={{ width: `${bar.pct}%`, background: bar.color }}
                        />
                      </div>
                      <span className={s.barPct}>{bar.pct}%</span>
                    </div>
                  )) : (
                    <span style={{ fontSize: 13, color: 'var(--text3)', fontFamily: 'var(--font-sans)' }}>
                      No data
                    </span>
                  )}
                </div>
              </Card>

              {/* Top Markets */}
              <Card title="Top 市场">
                <div className={s.marketList}>
                  {topMarkets.length > 0 ? topMarkets.slice(0, 8).map((m, i) => (
                    <div key={m.name} className={s.marketRow}>
                      <span className={s.marketRank}>{i + 1}</span>
                      <span className={s.marketName}>{m.name}</span>
                      <span className={s.marketValue}>{m.value}</span>
                    </div>
                  )) : (
                    <span style={{ fontSize: 13, color: 'var(--text3)', fontFamily: 'var(--font-sans)', padding: '8px 0', display: 'block' }}>
                      No data
                    </span>
                  )}
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
