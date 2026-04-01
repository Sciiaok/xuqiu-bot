'use client';

import { useState, useEffect, useRef } from 'react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import s from './page.module.css';
import MetricCard from '../../components/MetricCard/MetricCard';
import AIPanel from '../../components/AIPanel/AIPanel';
import Card from '../../components/Card/Card';
import DataTable from '../../components/DataTable/DataTable';
import TabBar from '../../components/TabBar/TabBar';
import Tag from '../../components/Tag/Tag';
import Markdown from '../../components/Markdown/Markdown';

// ──────────── Constants ────────────

const PRODUCT_LINES = [
  { key: 'all', label: '全部业务线' },
  { key: 'vehicle', label: '整车' },
  { key: 'auto_parts', label: '汽配' },
  { key: 'agri_machinery', label: '农机' },
];

const DATE_TABS = [
  { key: '7d', label: '7D' },
  { key: '14d', label: '14D' },
  { key: '30d', label: '30D' },
  { key: 'custom', label: 'Custom' },
];

const DATE_TAB_TO_DAYS = { '7d': 7, '14d': 14, '30d': 30 };

const INTENT_LABELS = {
  business_inquiry: '业务咨询',
  business_cooperation: '商务合作',
  personal_consumer: '个人消费',
  personal_farmer: '个体农户',
  other: '其他',
};

const AGENT_NAME_LABELS = {
  'Vehicle Export Agent': '整车出口业务',
  'Agricultural Machinery Export Agent': '农机出口业务',
  'Japanese Auto Parts Export Agent': '汽配出口业务',
};

const BUYER_TYPE_LABELS = {
  end_user: '终端用户',
  dealer: '经销商',
  contractor: '承包商',
  cooperative: '合作社',
  other: '未分类',
};

// Chart palette — distinct, modern, dashboard-friendly
const COLORS = {
  blue: '#4C7FF0',
  green: '#34B872',
  amber: '#F0A030',
  red: '#E85D4A',
  purple: '#9270DB',
  teal: '#2BBCB3',
  pink: '#E770A8',
  indigo: '#6C6CE0',
};

// Area chart uses blue (total) + green (proof)
const AREA_TOTAL = COLORS.blue;
const AREA_PROOF = COLORS.green;

const QUALITY_COLORS = {
  PROOF: '#34B872',
  QUALIFY: '#6366F1',
  GOOD: '#F59E0B',
  BAD: '#EF4444',
};

const DONUT_PALETTE = [COLORS.blue, COLORS.teal, COLORS.purple, COLORS.amber, COLORS.green, COLORS.pink, COLORS.indigo, COLORS.red];

const PL_TAG_VARIANT = {
  vehicle: 'proof',
  auto_parts: 'avg',
  agri_machinery: 'good',
};

// ──────────── Helpers ────────────

function calcDelta(current, previous) {
  if (previous == null || previous === 0) return null;
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct > 0) return `+${pct}%`;
  if (pct < 0) return `${pct}%`;
  return null;
}

function calcTrend(current, previous) {
  if (previous == null || previous === 0) return 'neutral';
  return current >= previous ? 'up' : 'down';
}

function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ──────────── Chart sub-components ────────────

function ChartTooltip({ active, payload, label, formatter, labelMap }) {
  if (!active || !payload?.length) return null;
  return (
    <div className={s.tooltip}>
      <div className={s.tooltipLabel}>{label}</div>
      {payload.map((entry, i) => (
        <div key={i} className={s.tooltipRow}>
          <span className={s.tooltipDot} style={{ background: entry.color }} />
          <span className={s.tooltipName}>{labelMap?.[entry.name] || entry.name}</span>
          <span className={s.tooltipValue}>{formatter ? formatter(entry.value) : entry.value}</span>
        </div>
      ))}
    </div>
  );
}

function DonutCard({ title, data, colorMap, labelMap }) {
  if (!data?.length) {
    return (
      <Card title={title}>
        <span className={s.noData}>No data</span>
      </Card>
    );
  }

  const total = data.reduce((sum, d) => sum + d.value, 0) || 1;

  return (
    <Card title={title}>
      <div className={s.donutWrap}>
        <ResponsiveContainer width="100%" height={160}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={42}
              outerRadius={65}
              paddingAngle={2}
              dataKey="value"
              stroke="none"
            >
              {data.map((item, i) => (
                <Cell
                  key={item.name}
                  fill={colorMap?.[item.name] || DONUT_PALETTE[i % DONUT_PALETTE.length]}
                />
              ))}
            </Pie>
            <Tooltip content={<ChartTooltip labelMap={labelMap} />} />
          </PieChart>
        </ResponsiveContainer>
        <div className={s.donutLegend}>
          {data.map((item, i) => {
            const pct = Math.round((item.value / total) * 100);
            const color = colorMap?.[item.name] || DONUT_PALETTE[i % DONUT_PALETTE.length];
            return (
              <div key={item.name} className={s.donutLegendRow}>
                <span className={s.donutDot} style={{ background: color }} />
                <span className={s.donutName}>{labelMap?.[item.name] || item.name}</span>
                <span className={s.donutPct}>{pct}%</span>
                <span className={s.donutVal}>{item.value}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

// ──────────── Main Page ────────────

export default function AnalyticsPage() {
  const [selectedLine, setSelectedLine] = useState('all');
  const [dateRange, setDateRange] = useState('7d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [aiInsight, setAiInsight] = useState(null);
  const [aiInsightLoading, setAiInsightLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState(null);

  const getProductLines = () =>
    selectedLine === 'all' ? 'vehicle,auto_parts,agri_machinery' : selectedLine;

  // ── AI Summary SSE ──
  const fetchAiInsight = async (params) => {
    setAiInsightLoading(true);
    setAiInsight(null);
    setAiStatus(null);
    let accumulated = '';

    const qs = new URLSearchParams();
    if (params.startDate && params.endDate) {
      qs.set('startDate', params.startDate);
      qs.set('endDate', params.endDate);
    } else {
      qs.set('days', String(params.days));
    }
    qs.set('productLines', params.productLines);
    qs.set('lang', 'zh');

    try {
      const res = await fetch(`/api/inquiry-dashboard/summary?${qs}`);
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
              const d = JSON.parse(line.slice(6));
              if (eventType === 'chunk') {
                accumulated += d.text;
                setAiInsight(accumulated);
              } else if (eventType === 'status') {
                setAiStatus(d.message);
              } else if (eventType === 'done') {
                setAiInsight(d.text);
              } else if (eventType === 'error') {
                console.error('AI summary error:', d.message);
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

  // ── Main data fetch ──
  useEffect(() => {
    let days;
    let startDate, endDate;
    if (dateRange === 'custom') {
      if (!customFrom || !customTo) return;
      startDate = customFrom;
      endDate = customTo;
    } else {
      days = DATE_TAB_TO_DAYS[dateRange] ?? 7;
    }

    const productLines = getProductLines();
    setLoading(true);
    setError(null);

    const qs = new URLSearchParams();
    if (startDate && endDate) {
      qs.set('startDate', startDate);
      qs.set('endDate', endDate);
    } else {
      qs.set('days', String(days));
    }
    qs.set('productLines', productLines);

    fetch(`/api/inquiry-dashboard?${qs}`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(json => { setData(json); setLoading(false); })
      .catch(err => { setError(err.message); setLoading(false); });

    fetchAiInsight({ days, startDate, endDate, productLines });
  }, [dateRange, selectedLine, customFrom, customTo]);

  // ── Derived data ──
  const kpi = data?.kpi ?? {};
  const dailyTrend = (data?.dailyTrend ?? []).map(d => ({ ...d, date: fmtDate(d.date) }));
  const agentDistribution = data?.agentDistribution ?? [];
  const countryDistribution = data?.countryDistribution ?? [];
  const qualityDistribution = data?.qualityDistribution ?? [];
  const buyerTypeDistribution = data?.buyerTypeDistribution ?? [];
  const intentDistribution = (data?.intentDistribution ?? []).map(d => ({
    ...d,
    name: INTENT_LABELS[d.name] || d.name,
  }));
  const topProducts = data?.topProducts ?? [];

  const chartAxisStyle = { fontSize: 10, fill: '#a09484', fontFamily: 'var(--font-mono)' };
  const gridStyle = { strokeDasharray: '3 3', stroke: '#e0d8cc', strokeOpacity: 0.6 };

  return (
    <div className={s.root}>
      {/* ── Header ── */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>询盘数据看板</h1>
          <span className={s.subtitle}>业务询盘质量与转化分析</span>
        </div>
        <div className={s.headerRight}>
          <select
            className={s.supplySelect}
            value={selectedLine}
            onChange={e => setSelectedLine(e.target.value)}
          >
            {PRODUCT_LINES.map(pl => (
              <option key={pl.key} value={pl.key}>{pl.label}</option>
            ))}
          </select>
          <TabBar tabs={DATE_TABS} active={dateRange} onChange={setDateRange} />
          {dateRange === 'custom' && (
            <div className={s.dateRow}>
              <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} className={s.dateInput} />
              <span className={s.dateSep}>—</span>
              <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} className={s.dateInput} />
            </div>
          )}
        </div>
      </div>

      {/* ── Loading ── */}
      {loading && (
        <div className={s.loadingWrap}>
          <div className={s.spinner} />
          Loading...
        </div>
      )}

      {/* ── Error ── */}
      {!loading && error && (
        <div className={s.errorWrap}>Failed to load: {error}</div>
      )}

      {/* ── Content ── */}
      {!loading && !error && (
        <>
          {/* KPI Cards */}
          <div className={s.metrics}>
            <MetricCard
              label="总询盘数"
              value={String(kpi.totalInquiries?.current ?? 0)}
              delta={calcDelta(kpi.totalInquiries?.current, kpi.totalInquiries?.previous)}
              trend={calcTrend(kpi.totalInquiries?.current, kpi.totalInquiries?.previous)}
            />
            <MetricCard
              label="Proof 询盘"
              value={String(kpi.proofInquiries?.current ?? 0)}
              delta={calcDelta(kpi.proofInquiries?.current, kpi.proofInquiries?.previous)}
              trend={calcTrend(kpi.proofInquiries?.current, kpi.proofInquiries?.previous)}
              color="green"
            />
            <MetricCard
              label="Proof 率"
              value={`${kpi.proofRate?.current ?? 0}%`}
              delta={calcDelta(kpi.proofRate?.current, kpi.proofRate?.previous)}
              trend={calcTrend(kpi.proofRate?.current, kpi.proofRate?.previous)}
              color="teal"
            />
            <MetricCard
              label="高价值占比"
              value={`${kpi.highValueRate?.current ?? 0}%`}
              delta={calcDelta(kpi.highValueRate?.current, kpi.highValueRate?.previous)}
              trend={calcTrend(kpi.highValueRate?.current, kpi.highValueRate?.previous)}
              color="amber"
            />
          </div>

          {/* AI Summary */}
          <AIPanel
            title="AI 询盘洞察"
            tag={aiInsightLoading ? (aiStatus || '正在生成...') : aiInsight ? '自动生成' : '自动生成'}
            onRefresh={() => {
              const productLines = getProductLines();
              if (dateRange === 'custom' && customFrom && customTo) {
                return fetchAiInsight({ startDate: customFrom, endDate: customTo, productLines });
              }
              return fetchAiInsight({ days: DATE_TAB_TO_DAYS[dateRange] ?? 7, productLines });
            }}
            refreshLabel="刷新"
          >
            {aiInsight ? (
              <Markdown>{aiInsight}</Markdown>
            ) : aiInsightLoading ? (
              <div style={{ color: 'var(--text3)', fontSize: 13 }}>
                {aiStatus || '正在生成询盘洞察...'}
              </div>
            ) : null}
          </AIPanel>

          {/* Daily Trend — AreaChart */}
          <Card title="每日询盘趋势">
            {dailyTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={dailyTrend}>
                  <defs>
                    <linearGradient id="gradTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={AREA_TOTAL} stopOpacity={0.18} />
                      <stop offset="100%" stopColor={AREA_TOTAL} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="gradProof" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={AREA_PROOF} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={AREA_PROOF} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...gridStyle} />
                  <XAxis dataKey="date" tick={chartAxisStyle} tickLine={false} axisLine={false} />
                  <YAxis tick={chartAxisStyle} tickLine={false} axisLine={false} width={32} />
                  <Tooltip content={<ChartTooltip />} />
                  <Area type="monotone" dataKey="total" stroke={AREA_TOTAL} fill="url(#gradTotal)" strokeWidth={2} name="总询盘" />
                  <Area type="monotone" dataKey="proof" stroke={AREA_PROOF} fill="url(#gradProof)" strokeWidth={2} name="Proof" />
                  <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, fontFamily: 'var(--font-sans)' }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <span className={s.noData}>No data</span>
            )}
          </Card>

          {/* Agent Distribution + Country Distribution */}
          <div className={s.twoCol}>
            {/* Agent Distribution */}
            <Card title="业务线分布">
              {agentDistribution.length > 0 ? (
                <div className={s.agentList}>
                  {agentDistribution.map(agent => {
                    const total = Object.values(agent.quality).reduce((a, b) => a + b, 0);
                    return (
                      <div key={agent.agentName} className={s.agentRow}>
                        <div className={s.agentHeader}>
                          <span className={s.agentName}>{AGENT_NAME_LABELS[agent.agentName] || agent.agentName}</span>
                          <Tag variant={PL_TAG_VARIANT[agent.productLine] || 'low'}>
                            {PRODUCT_LINES.find(p => p.key === agent.productLine)?.label || agent.productLine}
                          </Tag>
                          <span className={s.agentStats}>
                            {agent.inquiryCount} 询盘 · {agent.proofCount} Proof · {agent.proofRate}%
                          </span>
                        </div>
                        <div className={s.qualityBar}>
                          {Object.entries(QUALITY_COLORS).map(([key, color]) => {
                            const pct = total > 0 ? (agent.quality[key] / total) * 100 : 0;
                            if (pct === 0) return null;
                            return (
                              <div
                                key={key}
                                className={s.qualitySegment}
                                style={{ width: `${pct}%`, background: color }}
                                title={`${key}: ${agent.quality[key]}`}
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                  <div className={s.qualityLegend}>
                    {Object.entries(QUALITY_COLORS).map(([key, color]) => (
                      <span key={key} className={s.legendItem}>
                        <span className={s.legendDot} style={{ background: color }} />
                        {key}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <span className={s.noData}>No data</span>
              )}
            </Card>

            {/* Country Distribution — BarChart */}
            <Card title="国家分布 Top 10">
              {countryDistribution.length > 0 ? (
                <ResponsiveContainer width="100%" height={Math.max(200, countryDistribution.length * 30)}>
                  <BarChart data={countryDistribution} layout="vertical" margin={{ left: 0, right: 16 }}>
                    <CartesianGrid {...gridStyle} horizontal={false} />
                    <XAxis type="number" tick={chartAxisStyle} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="country" tick={chartAxisStyle} tickLine={false} axisLine={false} width={72} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar dataKey="inquiryCount" fill={COLORS.blue} radius={[0, 4, 4, 0]} name="询盘数" barSize={16} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <span className={s.noData}>No data</span>
              )}
            </Card>
          </div>

          {/* Three Donut Charts */}
          <div className={s.threeCol}>
            <DonutCard
              title="询盘质量分布"
              data={qualityDistribution}
              colorMap={QUALITY_COLORS}
            />
            <DonutCard
              title="买家类型分布"
              data={buyerTypeDistribution}
              labelMap={BUYER_TYPE_LABELS}
            />
            <DonutCard
              title="对话意图分布"
              data={intentDistribution}
              labelMap={INTENT_LABELS}
            />
          </div>

          {/* Top Products */}
          <Card title="热门产品 Top 10">
            {topProducts.length > 0 ? (
              <DataTable
                columns={['#', '产品', '业务线', '询盘数', 'Proof 率']}
                rows={topProducts.map((p, i) => [
                  i + 1,
                  p.productName,
                  <Tag key={p.productLine} variant={PL_TAG_VARIANT[p.productLine] || 'low'}>
                    {PRODUCT_LINES.find(pl => pl.key === p.productLine)?.label || p.productLine}
                  </Tag>,
                  p.inquiryCount,
                  `${p.proofRate}%`,
                ])}
              />
            ) : (
              <span className={s.noData}>No data</span>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
