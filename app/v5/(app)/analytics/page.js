'use client';

import { useState, useEffect, useRef } from 'react';
import s from './page.module.css';
import MetricCard from '../../components/MetricCard/MetricCard';
import AIPanel from '../../components/AIPanel/AIPanel';
import Card from '../../components/Card/Card';
import DataTable from '../../components/DataTable/DataTable';
import TabBar from '../../components/TabBar/TabBar';
import Tag from '../../components/Tag/Tag';
import Markdown from '../../components/Markdown/Markdown';
import ScoreBar from '../../components/ScoreBar/ScoreBar';

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
  other: '其他',
};

const QUALITY_COLORS = {
  PROOF: 'var(--green)',
  QUALIFY: 'var(--accent)',
  GOOD: 'var(--amber)',
  BAD: 'var(--red)',
};

const PRODUCT_LINE_COLORS = {
  vehicle: 'var(--accent)',
  auto_parts: 'var(--amber)',
  agri_machinery: 'var(--green)',
  unknown: 'var(--text3)',
};

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

export default function AnalyticsPage() {
  const [selectedLines, setSelectedLines] = useState('all');
  const [dateRange, setDateRange] = useState('7d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [aiInsight, setAiInsight] = useState(null);
  const [aiInsightLoading, setAiInsightLoading] = useState(false);
  const [aiStatus, setAiStatus] = useState(null);

  const prevMainDepsRef = useRef(null);

  // Fetch AI Summary via SSE
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

  // Fetch main data
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

    const productLines = selectedLines === 'all'
      ? 'vehicle,auto_parts,agri_machinery'
      : selectedLines;

    const mainKey = `${dateRange}|${selectedLines}|${customFrom}|${customTo}`;
    const isInitial = prevMainDepsRef.current === null;
    prevMainDepsRef.current = mainKey;

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
      .then(json => {
        setData(json);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message);
        setLoading(false);
      });

    // Fetch AI insight
    fetchAiInsight({ days, startDate, endDate, productLines });
  }, [dateRange, selectedLines, customFrom, customTo]);

  const kpi = data?.kpi ?? {};
  const dailyTrend = data?.dailyTrend ?? [];
  const agentDistribution = data?.agentDistribution ?? [];
  const countryDistribution = data?.countryDistribution ?? [];
  const qualityDistribution = data?.qualityDistribution ?? [];
  const buyerTypeDistribution = data?.buyerTypeDistribution ?? [];
  const intentDistribution = data?.intentDistribution ?? [];
  const topProducts = data?.topProducts ?? [];

  // Find max for scaling bars
  const maxCountryInquiry = Math.max(...countryDistribution.map(c => c.inquiryCount), 1);
  const maxProductInquiry = Math.max(...topProducts.map(p => p.inquiryCount), 1);

  return (
    <div className={s.root}>
      {/* Header */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>询盘数据看板</h1>
          <span className={s.subtitle}>业务询盘质量与转化分析</span>
        </div>
        <div className={s.headerRight}>
          <select
            className={s.supplySelect}
            value={selectedLines}
            onChange={e => setSelectedLines(e.target.value)}
          >
            {PRODUCT_LINES.map(pl => (
              <option key={pl.key} value={pl.key}>{pl.label}</option>
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
                className={s.dateInput}
              />
              <span style={{ color: 'var(--text3)', fontFamily: 'var(--font-sans)', fontSize: 13 }}>—</span>
              <input
                type="date"
                value={customTo}
                onChange={e => setCustomTo(e.target.value)}
                className={s.dateInput}
              />
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* Loading */}
      {loading && (
        <div className={s.loadingWrap}>
          <div className={s.spinner} />
          Loading...
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className={s.errorWrap}>
          Failed to load data: {error}
        </div>
      )}

      {/* Main Content */}
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

          {/* AI Summary Panel */}
          <AIPanel
            title="AI 询盘洞察"
            tag={aiInsightLoading ? (aiStatus || '正在生成...') : aiInsight ? '自动生成' : '自动生成'}
            onRefresh={() => {
              const productLines = selectedLines === 'all'
                ? 'vehicle,auto_parts,agri_machinery'
                : selectedLines;
              if (dateRange === 'custom' && customFrom && customTo) {
                return fetchAiInsight({ startDate: customFrom, endDate: customTo, productLines });
              }
              const days = DATE_TAB_TO_DAYS[dateRange] ?? 7;
              return fetchAiInsight({ days, productLines });
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

          {/* Daily Trend (simple bar visualization) */}
          <Card title="每日询盘趋势">
            {dailyTrend.length > 0 ? (
              <div className={s.trendWrap}>
                <div className={s.trendChart}>
                  {dailyTrend.map(day => {
                    const maxVal = Math.max(...dailyTrend.map(d => d.total), 1);
                    const totalPct = (day.total / maxVal) * 100;
                    const proofPct = (day.proof / maxVal) * 100;
                    const dateLabel = `${new Date(day.date + 'T00:00:00').getMonth() + 1}/${new Date(day.date + 'T00:00:00').getDate()}`;
                    return (
                      <div key={day.date} className={s.trendCol} title={`${day.date}\n总询盘: ${day.total}\nProof: ${day.proof}`}>
                        <div className={s.trendBarWrap}>
                          <div className={s.trendBarTotal} style={{ height: `${totalPct}%` }} />
                          <div className={s.trendBarProof} style={{ height: `${proofPct}%` }} />
                        </div>
                        <span className={s.trendDate}>{dateLabel}</span>
                      </div>
                    );
                  })}
                </div>
                <div className={s.trendLegend}>
                  <span className={s.legendDot} style={{ background: 'var(--accent)' }} /> 总询盘
                  <span className={s.legendDot} style={{ background: 'var(--green)', marginLeft: 12 }} /> Proof
                </div>
              </div>
            ) : (
              <span className={s.noData}>No data</span>
            )}
          </Card>

          {/* Two-Column Grid: Agent Distribution + Country */}
          <div className={s.bottomGrid}>
            {/* Agent Distribution */}
            <Card title="业务线分布">
              {agentDistribution.length > 0 ? (
                <div className={s.agentList}>
                  {agentDistribution.map(agent => {
                    const total = Object.values(agent.quality).reduce((s, v) => s + v, 0);
                    return (
                      <div key={agent.agentName} className={s.agentRow}>
                        <div className={s.agentHeader}>
                          <span className={s.agentName}>{agent.agentName}</span>
                          <Tag variant={agent.productLine === 'vehicle' ? 'proof' : agent.productLine === 'auto_parts' ? 'avg' : 'good'}>
                            {PRODUCT_LINES.find(p => p.key === agent.productLine)?.label || agent.productLine}
                          </Tag>
                          <span className={s.agentStats}>
                            {agent.inquiryCount} / {agent.proofCount} ({agent.proofRate}%)
                          </span>
                        </div>
                        {/* Stacked quality bar */}
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
                  {/* Legend */}
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

            {/* Country Distribution */}
            <Card title="国家分布 Top 10">
              {countryDistribution.length > 0 ? (
                <div className={s.barList}>
                  {countryDistribution.map((c, i) => (
                    <div key={c.country} className={s.barRow}>
                      <span className={s.barRank}>{i + 1}</span>
                      <span className={s.barLabel}>{c.country}</span>
                      <div className={s.barTrack}>
                        <div
                          className={s.barFill}
                          style={{
                            width: `${(c.inquiryCount / maxCountryInquiry) * 100}%`,
                            background: 'var(--accent)',
                          }}
                        />
                      </div>
                      <span className={s.barValue}>{c.inquiryCount}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <span className={s.noData}>No data</span>
              )}
            </Card>
          </div>

          {/* Three Distribution Cards */}
          <div className={s.threeCol}>
            {/* Quality Distribution */}
            <Card title="询盘质量分布">
              {qualityDistribution.length > 0 ? (
                <div className={s.distList}>
                  {qualityDistribution.map(item => {
                    const totalQ = qualityDistribution.reduce((s, i) => s + i.value, 0) || 1;
                    const pct = Math.round((item.value / totalQ) * 100);
                    return (
                      <div key={item.name} className={s.distRow}>
                        <span className={s.distDot} style={{ background: QUALITY_COLORS[item.name] || 'var(--text3)' }} />
                        <span className={s.distName}>{item.name}</span>
                        <span className={s.distPct}>{pct}%</span>
                        <span className={s.distValue}>{item.value}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <span className={s.noData}>No data</span>
              )}
            </Card>

            {/* Buyer Type Distribution */}
            <Card title="买家类型分布">
              {buyerTypeDistribution.length > 0 ? (
                <div className={s.distList}>
                  {buyerTypeDistribution.map((item, i) => {
                    const totalB = buyerTypeDistribution.reduce((s, i) => s + i.value, 0) || 1;
                    const pct = Math.round((item.value / totalB) * 100);
                    const colors = ['var(--accent)', 'var(--purple)', 'var(--teal)', 'var(--amber)', 'var(--green)'];
                    return (
                      <div key={item.name} className={s.distRow}>
                        <span className={s.distDot} style={{ background: colors[i % colors.length] }} />
                        <span className={s.distName}>{item.name}</span>
                        <span className={s.distPct}>{pct}%</span>
                        <span className={s.distValue}>{item.value}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <span className={s.noData}>No data</span>
              )}
            </Card>

            {/* Intent Distribution */}
            <Card title="对话意图分布">
              {intentDistribution.length > 0 ? (
                <div className={s.distList}>
                  {intentDistribution.map((item, i) => {
                    const totalI = intentDistribution.reduce((s, i) => s + i.value, 0) || 1;
                    const pct = Math.round((item.value / totalI) * 100);
                    const colors = ['var(--accent)', 'var(--teal)', 'var(--amber)', 'var(--purple)', 'var(--green)'];
                    return (
                      <div key={item.name} className={s.distRow}>
                        <span className={s.distDot} style={{ background: colors[i % colors.length] }} />
                        <span className={s.distName}>{INTENT_LABELS[item.name] || item.name}</span>
                        <span className={s.distPct}>{pct}%</span>
                        <span className={s.distValue}>{item.value}</span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <span className={s.noData}>No data</span>
              )}
            </Card>
          </div>

          {/* Top Products */}
          <Card title="热门产品 Top 10">
            {topProducts.length > 0 ? (
              <DataTable
                columns={['#', '产品', '业务线', '询盘数', 'Proof 率']}
                rows={topProducts.map((p, i) => [
                  i + 1,
                  p.productName,
                  <Tag key={p.productLine} variant={p.productLine === 'vehicle' ? 'proof' : p.productLine === 'auto_parts' ? 'avg' : 'good'}>
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
