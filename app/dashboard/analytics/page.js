'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useLocale } from 'next-intl';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

// ──────────── CONSTANTS ────────────

const CHART_COLORS = {
  blue: '#3B82F6',
  purple: '#8B5CF6',
  green: '#22C55E',
  amber: '#F59E0B',
  red: '#EF4444',
  cyan: '#06B6D4',
  pink: '#EC4899',
  indigo: '#6366F1',
};

const PIE_PALETTE = ['#3B82F6', '#8B5CF6', '#22C55E', '#F59E0B', '#EF4444', '#06B6D4', '#EC4899', '#6366F1', '#14B8A6', '#F97316'];

const QUALITY_COLORS = {
  PROOF: CHART_COLORS.green,
  QUALIFY: CHART_COLORS.blue,
  GOOD: CHART_COLORS.amber,
  BAD: CHART_COLORS.red,
};

const PRODUCT_LINE_COLORS = {
  vehicle: 'badge-blue',
  auto_parts: 'badge-amber',
  agri_machinery: 'badge-green',
};

const ALL_PRODUCT_LINES = ['vehicle', 'auto_parts', 'agri_machinery'];

// ──────────── HELPER COMPONENTS ────────────

function KpiCard({ label, current, previous, suffix = '' }) {
  const change = previous != null && previous !== 0
    ? Math.round(((current - previous) / previous) * 100)
    : null;

  return (
    <div className="card p-5 flex flex-col gap-1">
      <span className="text-xs font-medium text-text-tertiary uppercase tracking-wider">{label}</span>
      <div className="flex items-end gap-2 mt-1">
        <span className="text-3xl font-bold text-text-primary tabular-nums">{current}{suffix}</span>
        {change !== null && (
          <span className={`text-xs font-medium pb-1 ${change > 0 ? 'text-accent-green' : change < 0 ? 'text-accent-red' : 'text-text-muted'}`}>
            {change > 0 ? '+' : ''}{change}%
          </span>
        )}
      </div>
    </div>
  );
}

function ChartCard({ title, children, className = '' }) {
  return (
    <div className={`card p-5 ${className}`}>
      <h3 className="text-sm font-semibold text-text-secondary mb-4">{title}</h3>
      {children}
    </div>
  );
}

function CustomTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-surface border border-border rounded-lg shadow-lg p-3 text-xs">
      <p className="font-medium text-text-primary mb-1">{label}</p>
      {payload.map((entry, i) => (
        <p key={i} className="text-text-secondary">
          <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ backgroundColor: entry.color }} />
          {entry.name}: <span className="font-medium text-text-primary">{formatter ? formatter(entry.value) : entry.value}</span>
        </p>
      ))}
    </div>
  );
}

function DonutChart({ data, noDataLabel }) {
  if (!data?.length) return <div className="text-text-muted text-sm text-center py-8">{noDataLabel}</div>;

  return (
    <div className="flex items-center gap-4">
      <ResponsiveContainer width="50%" height={180}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={45}
            outerRadius={70}
            paddingAngle={2}
            dataKey="value"
          >
            {data.map((_, i) => (
              <Cell key={i} fill={PIE_PALETTE[i % PIE_PALETTE.length]} />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="flex-1 space-y-1.5 text-xs min-w-0">
        {data.map((item, i) => (
          <div key={item.name} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: PIE_PALETTE[i % PIE_PALETTE.length] }} />
            <span className="text-text-secondary truncate">{item.name}</span>
            <span className="text-text-primary font-medium ml-auto tabular-nums">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function QualityDonutChart({ data, noDataLabel }) {
  if (!data?.length) return <div className="text-text-muted text-sm text-center py-8">{noDataLabel}</div>;

  return (
    <div className="flex items-center gap-4">
      <ResponsiveContainer width="50%" height={180}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={45}
            outerRadius={70}
            paddingAngle={2}
            dataKey="value"
          >
            {data.map((item) => (
              <Cell key={item.name} fill={QUALITY_COLORS[item.name] || '#6B7280'} />
            ))}
          </Pie>
          <Tooltip content={<CustomTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="flex-1 space-y-1.5 text-xs min-w-0">
        {data.map((item) => (
          <div key={item.name} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: QUALITY_COLORS[item.name] || '#6B7280' }} />
            <span className="text-text-secondary truncate">{item.name}</span>
            <span className="text-text-primary font-medium ml-auto tabular-nums">{item.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function AiSummaryCard({ productLines, days, startDate, endDate, isCustom, t, locale }) {
  const [summary, setSummary] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [cached, setCached] = useState(false);
  const abortRef = useRef(null);

  const fetchSummary = useCallback((forceRefresh = false) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setSummary('');
    setStatus('');
    setLoading(true);
    setCached(false);

    const qs = new URLSearchParams();
    if (isCustom && startDate && endDate) {
      qs.set('startDate', startDate);
      qs.set('endDate', endDate);
    } else {
      qs.set('days', String(days));
    }
    qs.set('productLines', productLines.join(','));
    qs.set('lang', locale);

    const method = forceRefresh ? 'POST' : 'GET';
    const url = `/api/inquiry-dashboard/summary?${qs}`;

    fetch(url, { method, signal: controller.signal })
      .then(async (res) => {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              const event = line.slice(7);
              // Next line should be data
              continue;
            }
            if (line.startsWith('data: ')) {
              const raw = line.slice(6);
              if (raw === ':heartbeat') continue;
              try {
                const parsed = JSON.parse(raw);
                // Determine event type from the data
                if (parsed.cached !== undefined && parsed.text === undefined) {
                  setCached(true);
                } else if (parsed.message) {
                  setStatus(parsed.message);
                } else if (parsed.text && parsed.cached !== undefined) {
                  // done event
                  setSummary(parsed.text);
                  setCached(parsed.cached);
                  setLoading(false);
                } else if (parsed.text) {
                  // chunk event
                  accumulated += parsed.text;
                  setSummary(accumulated);
                }
              } catch {}
            }
          }
        }
        setLoading(false);
      })
      .catch((err) => {
        if (err.name !== 'AbortError') {
          setLoading(false);
          setStatus(t('summaryError'));
        }
      });
  }, [productLines, days, startDate, endDate, isCustom, locale, t]);

  useEffect(() => {
    fetchSummary();
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, [fetchSummary]);

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-text-secondary">{t('aiSummary')}</h3>
        <button
          onClick={() => fetchSummary(true)}
          disabled={loading}
          className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors disabled:opacity-50"
          title={t('refreshSummary')}
        >
          <svg className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>

      {loading && !summary && (
        <div className="space-y-2">
          <div className="h-4 bg-surface-hover rounded animate-pulse w-full" />
          <div className="h-4 bg-surface-hover rounded animate-pulse w-5/6" />
          <div className="h-4 bg-surface-hover rounded animate-pulse w-4/6" />
          {status && <p className="text-xs text-text-muted mt-2">{status}</p>}
        </div>
      )}

      {summary && (
        <div className="text-sm text-text-secondary leading-relaxed prose prose-sm max-w-none dark:prose-invert"
          dangerouslySetInnerHTML={{ __html: simpleMarkdown(summary) }}
        />
      )}

      {!loading && !summary && !status && (
        <p className="text-sm text-text-muted">{t('noSummary')}</p>
      )}
    </div>
  );
}

function simpleMarkdown(md) {
  return md
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>');
}

// ──────────── MAIN PAGE ────────────

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function AnalyticsPage() {
  const t = useTranslations('inquiryDashboard');
  const tc = useTranslations('common');
  const locale = useLocale();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [days, setDays] = useState(7);
  const [isCustom, setIsCustom] = useState(false);
  const [customRange, setCustomRange] = useState({ start: '', end: '' });
  const [selectedLines, setSelectedLines] = useState([...ALL_PRODUCT_LINES]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (isCustom && customRange.start && customRange.end) {
        qs.set('startDate', customRange.start);
        qs.set('endDate', customRange.end);
      } else {
        qs.set('days', String(days));
      }
      qs.set('productLines', selectedLines.join(','));
      const res = await fetch(`/api/inquiry-dashboard?${qs}`);
      if (!res.ok) throw new Error('Failed to fetch');
      setData(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [days, isCustom, customRange.start, customRange.end, selectedLines]);

  useEffect(() => {
    if (isCustom && (!customRange.start || !customRange.end)) return;
    fetchData();
  }, [fetchData]);

  const toggleLine = (line) => {
    setSelectedLines((prev) => {
      if (prev.includes(line)) {
        if (prev.length === 1) return prev; // prevent empty
        return prev.filter((l) => l !== line);
      }
      return [...prev, line];
    });
  };

  const handleDays = (d) => {
    setIsCustom(false);
    setDays(d);
  };

  const chartAxisStyle = { fontSize: 11, fill: '#6B7280' };
  const gridStyle = { strokeDasharray: '3 3', stroke: '#E5E7EB', strokeOpacity: 0.5 };

  if (loading && !data) {
    return (
      <div className="p-6">
        <div className="card p-12">
          <div className="flex items-center justify-center gap-3">
            <div className="animate-spin rounded-full h-6 w-6 border-2 border-accent-blue border-t-transparent" />
            <span className="text-text-secondary text-sm">{t('loading')}</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="card border-accent-red/30 bg-accent-red/5 p-8 text-center">
          <p className="text-accent-red font-medium">{t('failedToLoad')}</p>
          <p className="text-text-secondary text-sm mt-1">{error}</p>
          <button onClick={fetchData} className="btn btn-primary mt-4 text-sm">{tc('retry')}</button>
        </div>
      </div>
    );
  }

  const { kpi, dailyTrend, agentDistribution, countryDistribution, qualityDistribution, buyerTypeDistribution, intentDistribution, topProducts } = data || {};

  // Map intent keys to i18n labels
  const intentData = intentDistribution?.map((item) => ({
    ...item,
    name: t(`intent_${item.name}`, { defaultMessage: item.name }),
  }));

  return (
    <div className="p-6 space-y-5 max-w-[1400px] mx-auto">
      {/* Header & Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text-primary">{t('title')}</h1>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Product Line Toggles */}
          {ALL_PRODUCT_LINES.map((line) => (
            <button
              key={line}
              onClick={() => toggleLine(line)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                selectedLines.includes(line)
                  ? 'bg-accent-blue text-white'
                  : 'bg-surface-hover text-text-secondary hover:text-text-primary'
              }`}
            >
              {t(`line_${line}`)}
            </button>
          ))}

          <span className="w-px h-5 bg-border mx-1" />

          {/* Time Period */}
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              onClick={() => handleDays(d)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                !isCustom && days === d
                  ? 'bg-accent-blue text-white'
                  : 'bg-surface-hover text-text-secondary hover:text-text-primary'
              }`}
            >
              {d}D
            </button>
          ))}
          <button
            onClick={() => setIsCustom(true)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              isCustom
                ? 'bg-accent-blue text-white'
                : 'bg-surface-hover text-text-secondary hover:text-text-primary'
            }`}
          >
            {tc('custom')}
          </button>
          {isCustom && (
            <>
              <input
                type="date"
                value={customRange.start}
                onChange={(e) => setCustomRange((r) => ({ ...r, start: e.target.value }))}
                className="input text-xs !w-auto !py-1.5 !px-2"
              />
              <span className="text-text-muted text-xs">{tc('to')}</span>
              <input
                type="date"
                value={customRange.end}
                onChange={(e) => setCustomRange((r) => ({ ...r, end: e.target.value }))}
                className="input text-xs !w-auto !py-1.5 !px-2"
              />
            </>
          )}
          {loading && (
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-accent-blue border-t-transparent" />
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label={t('totalInquiries')}
          current={kpi?.totalInquiries?.current ?? 0}
          previous={kpi?.totalInquiries?.previous}
        />
        <KpiCard
          label={t('proofInquiries')}
          current={kpi?.proofInquiries?.current ?? 0}
          previous={kpi?.proofInquiries?.previous}
        />
        <KpiCard
          label={t('proofRate')}
          current={kpi?.proofRate?.current ?? 0}
          previous={kpi?.proofRate?.previous}
          suffix="%"
        />
        <KpiCard
          label={t('highValueRate')}
          current={kpi?.highValueRate?.current ?? 0}
          previous={kpi?.highValueRate?.previous}
          suffix="%"
        />
      </div>

      {/* Daily Trend Chart */}
      <ChartCard title={t('dailyTrend')}>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={dailyTrend?.map((d) => ({ ...d, date: formatDate(d.date) }))}>
            <defs>
              <linearGradient id="totalGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.blue} stopOpacity={0.15} />
                <stop offset="100%" stopColor={CHART_COLORS.blue} stopOpacity={0} />
              </linearGradient>
              <linearGradient id="proofGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={CHART_COLORS.green} stopOpacity={0.3} />
                <stop offset="100%" stopColor={CHART_COLORS.green} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...gridStyle} />
            <XAxis dataKey="date" tick={chartAxisStyle} tickLine={false} axisLine={false} />
            <YAxis tick={chartAxisStyle} tickLine={false} axisLine={false} width={35} />
            <Tooltip content={<CustomTooltip />} />
            <Area type="monotone" dataKey="total" stroke={CHART_COLORS.blue} fill="url(#totalGrad)" strokeWidth={2} name={t('totalInquiries')} />
            <Area type="monotone" dataKey="proof" stroke={CHART_COLORS.green} fill="url(#proofGrad)" strokeWidth={2} name={t('proofInquiries')} />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Agent Distribution + Country Distribution */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Agent Distribution */}
        <ChartCard title={t('agentDistribution')}>
          {agentDistribution?.length > 0 ? (
            <div className="space-y-3">
              {agentDistribution.map((agent) => {
                const total = Object.values(agent.quality).reduce((s, v) => s + v, 0);
                return (
                  <div key={agent.agentName} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text-primary">{agent.agentName}</span>
                        <span className={`badge ${PRODUCT_LINE_COLORS[agent.productLine] || 'badge-purple'} text-[10px]`}>
                          {t(`line_${agent.productLine}`, { defaultMessage: agent.productLine })}
                        </span>
                      </div>
                      <span className="text-text-muted tabular-nums">
                        {agent.inquiryCount} / {agent.proofCount} ({agent.proofRate}%)
                      </span>
                    </div>
                    {/* Stacked quality bar */}
                    <div className="flex h-2 rounded-full overflow-hidden bg-surface-hover">
                      {Object.entries(QUALITY_COLORS).map(([key, color]) => {
                        const pct = total > 0 ? (agent.quality[key] / total) * 100 : 0;
                        if (pct === 0) return null;
                        return (
                          <div
                            key={key}
                            className="h-full"
                            style={{ width: `${pct}%`, backgroundColor: color }}
                            title={`${key}: ${agent.quality[key]}`}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {/* Quality legend */}
              <div className="flex items-center gap-3 pt-1 text-[10px] text-text-muted">
                {Object.entries(QUALITY_COLORS).map(([key, color]) => (
                  <div key={key} className="flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                    {key}
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-text-muted text-sm text-center py-8">{tc('noData')}</div>
          )}
        </ChartCard>

        {/* Country Distribution */}
        <ChartCard title={t('countryDistribution')}>
          {countryDistribution?.length > 0 ? (
            <ResponsiveContainer width="100%" height={Math.max(200, countryDistribution.length * 32)}>
              <BarChart data={countryDistribution} layout="vertical" margin={{ left: 0, right: 20 }}>
                <CartesianGrid {...gridStyle} horizontal={false} />
                <XAxis type="number" tick={chartAxisStyle} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="country" tick={chartAxisStyle} tickLine={false} axisLine={false} width={80} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="inquiryCount" fill={CHART_COLORS.blue} radius={[0, 4, 4, 0]} name={t('totalInquiries')} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-text-muted text-sm text-center py-8">{tc('noData')}</div>
          )}
        </ChartCard>
      </div>

      {/* Three Donut Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartCard title={t('qualityDistribution')}>
          <QualityDonutChart data={qualityDistribution} noDataLabel={tc('noData')} />
        </ChartCard>

        <ChartCard title={t('buyerTypeDistribution')}>
          <DonutChart data={buyerTypeDistribution} noDataLabel={tc('noData')} />
        </ChartCard>

        <ChartCard title={t('intentDistribution')}>
          <DonutChart data={intentData} noDataLabel={tc('noData')} />
        </ChartCard>
      </div>

      {/* Top Products */}
      <ChartCard title={t('topProducts')}>
        {topProducts?.length > 0 ? (
          <div className="overflow-x-auto -mx-5 -mb-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">#</th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">{t('product')}</th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">{t('businessLine')}</th>
                  <th className="text-right px-3 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">{t('inquiryCount')}</th>
                  <th className="text-right px-5 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">{t('proofRate')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {topProducts.map((p, i) => (
                  <tr key={`${p.productName}-${p.productLine}`} className="hover:bg-surface-hover transition-colors">
                    <td className="px-5 py-2.5 text-text-muted tabular-nums">{i + 1}</td>
                    <td className="px-3 py-2.5 font-medium text-text-primary">{p.productName}</td>
                    <td className="px-3 py-2.5">
                      <span className={`badge ${PRODUCT_LINE_COLORS[p.productLine] || 'badge-purple'} text-[10px]`}>
                        {t(`line_${p.productLine}`, { defaultMessage: p.productLine })}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">{p.inquiryCount}</td>
                    <td className="px-5 py-2.5 text-right tabular-nums text-text-secondary">{p.proofRate}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-text-muted text-sm text-center py-8">{tc('noData')}</div>
        )}
      </ChartCard>

      {/* AI Summary */}
      <AiSummaryCard
        productLines={selectedLines}
        days={days}
        startDate={customRange.start}
        endDate={customRange.end}
        isCustom={isCustom}
        t={t}
        locale={locale}
      />

      <div className="h-8" />
    </div>
  );
}
