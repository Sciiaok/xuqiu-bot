'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

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

function useAnalytics() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetch_ = useCallback(async (params = {}) => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (params.days) qs.set('days', params.days);
      if (params.country) qs.set('country', params.country);
      if (params.startDate) qs.set('startDate', params.startDate);
      if (params.endDate) qs.set('endDate', params.endDate);
      if (params.humanNowDays) qs.set('humanNowDays', params.humanNowDays);
      const res = await fetch(`/api/analytics?${qs}`);
      if (!res.ok) throw new Error('Failed to fetch analytics');
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  return { data, loading, error, fetch: fetch_ };
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function KpiCard({ label, value, prevValue, suffix = '', icon, vsText }) {
  const diff = prevValue != null && prevValue !== 0
    ? Math.round(((value - prevValue) / prevValue) * 100)
    : null;

  return (
    <div className="card p-5 flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-text-tertiary uppercase tracking-wider">{label}</span>
        <span className="text-text-muted">{icon}</span>
      </div>
      <div className="flex items-end gap-2 mt-1">
        <span className="text-3xl font-bold text-text-primary tabular-nums">{value}{suffix}</span>
        {diff !== null && (
          <span className={`text-xs font-medium pb-1 ${diff > 0 ? 'text-accent-green' : diff < 0 ? 'text-accent-red' : 'text-text-muted'}`}>
            {vsText}
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

function DonutChart({ data, title, noDataLabel, moreLabel }) {
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
        {data.slice(0, 6).map((item, i) => (
          <div key={item.name} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: PIE_PALETTE[i % PIE_PALETTE.length] }} />
            <span className="text-text-secondary truncate">{item.name}</span>
            <span className="text-text-primary font-medium ml-auto tabular-nums">{item.value}</span>
          </div>
        ))}
        {data.length > 6 && (
          <p className="text-text-muted pl-4.5">{moreLabel}</p>
        )}
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const router = useRouter();
  const { data, loading, error, fetch: fetchData } = useAnalytics();
  const [days, setDays] = useState(30);
  const [country, setCountry] = useState('');
  const [customRange, setCustomRange] = useState({ start: '', end: '' });
  const [isCustom, setIsCustom] = useState(false);
  const [humanNowDays, setHumanNowDays] = useState(1);
  const t = useTranslations('analytics');
  const tc = useTranslations('common');
  const tt = useTranslations('time');

  useEffect(() => {
    if (isCustom && customRange.start && customRange.end) {
      fetchData({ startDate: customRange.start, endDate: customRange.end, country, humanNowDays });
    } else if (!isCustom) {
      fetchData({ days, country, humanNowDays });
    }
  }, [days, country, isCustom, customRange.start, customRange.end, humanNowDays, fetchData]);

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
            <span className="text-text-secondary text-sm">{t('loadingAnalytics')}</span>
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
          <button onClick={() => {
            if (isCustom && customRange.start && customRange.end) {
              fetchData({ startDate: customRange.start, endDate: customRange.end, country });
            } else {
              fetchData({ days, country });
            }
          }} className="btn btn-primary mt-4 text-sm">{tc('retry')}</button>
        </div>
      </div>
    );
  }

  const { kpi, dailyConversations, qualifyRate, dailyLeads, dailyTakeover, businessValueDist, intentDistribution, approvalRate, avgResponseTime, humanNowList, countries } = data || {};

  const getVsText = (todayVal, yesterdayVal) => {
    if (yesterdayVal == null || yesterdayVal === 0) return null;
    const diff = Math.round(((todayVal - yesterdayVal) / yesterdayVal) * 100);
    return t('vsYesterday', { diff: `${diff > 0 ? '+' : ''}${diff}` });
  };

  return (
    <div className="p-6 space-y-5 max-w-[1400px] mx-auto">
      {/* Header & Filters */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text-primary">{t('title')}</h1>
        <div className="flex items-center gap-2 flex-wrap">
          {[7, 14, 30].map(d => (
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
                onChange={e => setCustomRange(r => ({ ...r, start: e.target.value }))}
                className="input text-xs !w-auto !py-1.5 !px-2"
              />
              <span className="text-text-muted text-xs">{tc('to')}</span>
              <input
                type="date"
                value={customRange.end}
                onChange={e => setCustomRange(r => ({ ...r, end: e.target.value }))}
                className="input text-xs !w-auto !py-1.5 !px-2"
              />
            </>
          )}
          <select
            value={country}
            onChange={e => setCountry(e.target.value)}
            className="input text-xs !w-auto !py-1.5 !px-2 !pr-7"
          >
            <option value="">{tc('allCountries')}</option>
            {countries?.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          {loading && (
            <div className="animate-spin rounded-full h-4 w-4 border-2 border-accent-blue border-t-transparent" />
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          label={t('newConversations')}
          value={kpi?.newConversations?.today ?? 0}
          prevValue={kpi?.newConversations?.yesterday}
          vsText={getVsText(kpi?.newConversations?.today, kpi?.newConversations?.yesterday)}
          icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" /></svg>}
        />
        <KpiCard
          label={t('qualifyRate')}
          value={kpi?.qualifyRate?.today ?? 0}
          prevValue={kpi?.qualifyRate?.yesterday}
          vsText={getVsText(kpi?.qualifyRate?.today, kpi?.qualifyRate?.yesterday)}
          suffix="%"
          icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
        />
        <KpiCard
          label={t('newLeads')}
          value={kpi?.newLeads?.today ?? 0}
          prevValue={kpi?.newLeads?.yesterday}
          vsText={getVsText(kpi?.newLeads?.today, kpi?.newLeads?.yesterday)}
          icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>}
        />
        <KpiCard
          label={t('humanNowQueue')}
          value={kpi?.humanNowCount ?? 0}
          icon={<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" /></svg>}
        />
      </div>

      {/* HUMAN_NOW Leads Table */}
      <div className="card p-5 overflow-hidden">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-text-secondary">{t('humanNowLeads', { count: humanNowList?.length || 0 })}</h3>
          <div className="flex items-center gap-1">
            {[{ label: tt('today'), value: 1 }, { label: tt('7d'), value: 7 }, { label: tt('30d'), value: 30 }].map(opt => (
              <button
                key={opt.value}
                onClick={() => setHumanNowDays(opt.value)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  humanNowDays === opt.value
                    ? 'bg-accent-blue text-white'
                    : 'bg-surface-hover text-text-secondary hover:text-text-primary'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        {humanNowList?.length > 0 ? (
          <div className="overflow-x-auto -mx-5 -mb-5 mt-[-4px]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-background-secondary">
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">{t('contact')}</th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">{t('company')}</th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">{t('country')}</th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">{t('model')}</th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">{t('qty')}</th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">{t('quality')}</th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">{t('value')}</th>
                  <th className="text-left px-3 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">{t('summary')}</th>
                  <th className="text-left px-5 py-2.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">{t('updated')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {humanNowList.map(lead => (
                  <tr
                    key={lead.id}
                    onClick={() => router.push(`/dashboard/inbox?conversation_id=${lead.conversationId}`)}
                    className="hover:bg-surface-hover cursor-pointer transition-colors"
                  >
                    <td className="px-5 py-3 text-text-primary font-medium whitespace-nowrap">{lead.contactName}</td>
                    <td className="px-3 py-3 text-text-secondary whitespace-nowrap">{lead.companyName}</td>
                    <td className="px-3 py-3 text-text-secondary whitespace-nowrap">{lead.country}</td>
                    <td className="px-3 py-3 text-text-secondary whitespace-nowrap">{lead.carModel}</td>
                    <td className="px-3 py-3 text-text-secondary whitespace-nowrap">{lead.qty}</td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <span className={`badge ${
                        lead.inquiryQuality === 'PROOF' ? 'badge-green' :
                        lead.inquiryQuality === 'QUALIFY' ? 'badge-blue' :
                        lead.inquiryQuality === 'GOOD' ? 'badge-amber' : 'badge-red'
                      }`}>{lead.inquiryQuality}</span>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <span className={`badge ${
                        lead.businessValue === 'HIGH' ? 'badge-green' :
                        lead.businessValue === 'MEDIUM' ? 'badge-amber' : 'badge-purple'
                      }`}>{lead.businessValue}</span>
                    </td>
                    <td className="px-3 py-3 text-text-secondary max-w-xs truncate">{lead.handoffSummary}</td>
                    <td className="px-5 py-3 text-text-muted whitespace-nowrap text-xs">
                      {new Date(lead.updatedAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-text-muted text-sm text-center py-6">{t('noHumanNowLeads')}</p>
        )}
      </div>

      {/* Row 1: Conversations + Qualify Rate */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title={t('dailyConversations')}>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={dailyConversations?.map(d => ({ ...d, date: formatDate(d.date) }))}>
              <defs>
                <linearGradient id="convGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART_COLORS.blue} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={CHART_COLORS.blue} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={chartAxisStyle} tickLine={false} axisLine={false} />
              <YAxis tick={chartAxisStyle} tickLine={false} axisLine={false} width={35} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="count" stroke={CHART_COLORS.blue} fill="url(#convGrad)" strokeWidth={2} name={t('conversations')} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('qualifyConversionRate')}>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={qualifyRate?.map(d => ({ ...d, date: formatDate(d.date) }))}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={chartAxisStyle} tickLine={false} axisLine={false} />
              <YAxis tick={chartAxisStyle} tickLine={false} axisLine={false} width={35} unit="%" />
              <Tooltip content={<CustomTooltip formatter={v => `${v}%`} />} />
              <Line type="monotone" dataKey="rate" stroke={CHART_COLORS.green} strokeWidth={2} dot={false} name={t('rate')} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>

      {/* Row 2: Daily Leads by Quality */}
      <ChartCard title={t('dailyLeadsByQuality')}>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={dailyLeads?.map(d => ({ ...d, date: formatDate(d.date) }))}>
            <defs>
              {Object.entries(QUALITY_COLORS).map(([key, color]) => (
                <linearGradient key={key} id={`grad-${key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid {...gridStyle} />
            <XAxis dataKey="date" tick={chartAxisStyle} tickLine={false} axisLine={false} />
            <YAxis tick={chartAxisStyle} tickLine={false} axisLine={false} width={35} />
            <Tooltip content={<CustomTooltip />} />
            <Area type="monotone" dataKey="PROOF" stackId="1" stroke={QUALITY_COLORS.PROOF} fill={`url(#grad-PROOF)`} strokeWidth={1.5} name="PROOF" />
            <Area type="monotone" dataKey="QUALIFY" stackId="1" stroke={QUALITY_COLORS.QUALIFY} fill={`url(#grad-QUALIFY)`} strokeWidth={1.5} name="QUALIFY" />
            <Area type="monotone" dataKey="GOOD" stackId="1" stroke={QUALITY_COLORS.GOOD} fill={`url(#grad-GOOD)`} strokeWidth={1.5} name="GOOD" />
            <Area type="monotone" dataKey="BAD" stackId="1" stroke={QUALITY_COLORS.BAD} fill={`url(#grad-BAD)`} strokeWidth={1.5} name="BAD" />
            <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
          </AreaChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* Row 3: Takeover + Business Value */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title={t('humanTakeoverTrend')}>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={dailyTakeover?.map(d => ({ ...d, date: formatDate(d.date) }))}>
              <defs>
                <linearGradient id="takeoverGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART_COLORS.amber} stopOpacity={0.2} />
                  <stop offset="100%" stopColor={CHART_COLORS.amber} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={chartAxisStyle} tickLine={false} axisLine={false} />
              <YAxis tick={chartAxisStyle} tickLine={false} axisLine={false} width={30} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="count" stroke={CHART_COLORS.amber} fill="url(#takeoverGrad)" strokeWidth={2} name={t('takeovers')} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('businessValue')}>
          <DonutChart data={businessValueDist} noDataLabel={tc('noData')} moreLabel={t('more', { count: (businessValueDist?.length || 0) - 6 })} />
        </ChartCard>
      </div>

      {/* Row 4: Response Time + Approval Rate + Intent */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartCard title={t('avgResponseTime')}>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={avgResponseTime?.map(d => ({ ...d, date: formatDate(d.date) }))}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={chartAxisStyle} tickLine={false} axisLine={false} />
              <YAxis tick={chartAxisStyle} tickLine={false} axisLine={false} width={30} unit="s" />
              <Tooltip content={<CustomTooltip formatter={v => `${v}s`} />} />
              <Line type="monotone" dataKey="avgSeconds" stroke={CHART_COLORS.cyan} strokeWidth={2} dot={false} name={t('avgTime')} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('leadApprovalRate')}>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={approvalRate?.map(d => ({ ...d, date: formatDate(d.date) }))}>
              <CartesianGrid {...gridStyle} />
              <XAxis dataKey="date" tick={chartAxisStyle} tickLine={false} axisLine={false} />
              <YAxis tick={chartAxisStyle} tickLine={false} axisLine={false} width={30} unit="%" />
              <Tooltip content={<CustomTooltip formatter={v => `${v}%`} />} />
              <Line type="monotone" dataKey="rate" stroke={CHART_COLORS.purple} strokeWidth={2} dot={false} name={t('approvalRate')} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title={t('conversationIntent')}>
          <DonutChart data={intentDistribution} noDataLabel={tc('noData')} moreLabel={t('more', { count: (intentDistribution?.length || 0) - 6 })} />
        </ChartCard>
      </div>

    </div>
  );
}
