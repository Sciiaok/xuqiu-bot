'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const CHART_COLOR = '#2563EB';

function formatChartDate(value) {
  const date = new Date(`${value}T00:00:00`);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function KpiCard({ label, value, suffix = '' }) {
  return (
    <div className="card p-5">
      <div className="text-xs font-medium uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className="mt-2 text-3xl font-bold text-text-primary tabular-nums">
        {value}
        {suffix}
      </div>
    </div>
  );
}

function EmptyState({ title, description }) {
  return (
    <div className="card p-10 text-center">
      <p className="text-base font-semibold text-text-primary">{title}</p>
      <p className="mt-2 text-sm text-text-secondary">{description}</p>
    </div>
  );
}

export default function AdsPage() {
  const t = useTranslations('ads');
  const tc = useTranslations('common');
  const [days, setDays] = useState(30);
  const [isCustom, setIsCustom] = useState(false);
  const [customRange, setCustomRange] = useState({ start: '', end: '' });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedAdId, setSelectedAdId] = useState(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function fetchAds() {
      setLoading(true);
      setError(null);

      try {
        const params = new URLSearchParams();
        if (isCustom && customRange.start && customRange.end) {
          params.set('startDate', customRange.start);
          params.set('endDate', customRange.end);
        } else {
          params.set('days', String(days));
        }

        const response = await fetch(`/api/ads?${params.toString()}`);
        const payload = await response.json();

        if (!response.ok) {
          throw new Error(payload.error || t('failedToLoad'));
        }

        if (!cancelled) {
          setData(payload);
        }
      } catch (fetchError) {
        if (!cancelled) {
          setError(fetchError.message || t('failedToLoad'));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    if (!isCustom || (customRange.start && customRange.end)) {
      fetchAds();
    }

    return () => {
      cancelled = true;
    };
  }, [days, isCustom, customRange.start, customRange.end, reloadNonce, t]);

  useEffect(() => {
    const availableIds = new Set((data?.summary || []).map((item) => item.metaAdId));
    if (!availableIds.size) {
      setSelectedAdId(null);
      return;
    }

    if (!selectedAdId || !availableIds.has(selectedAdId)) {
      setSelectedAdId(data.summary[0].metaAdId);
    }
  }, [data, selectedAdId]);

  const selectedAd = useMemo(() => (
    (data?.summary || []).find((item) => item.metaAdId === selectedAdId) || null
  ), [data, selectedAdId]);

  if (loading && !data) {
    return (
      <div className="p-6">
        <div className="card p-12">
          <div className="flex items-center justify-center gap-3">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent-blue border-t-transparent" />
            <span className="text-sm text-text-secondary">{t('loading')}</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="card border-accent-red/30 bg-accent-red/5 p-8 text-center">
          <p className="font-medium text-accent-red">{t('failedToLoad')}</p>
          <p className="mt-1 text-sm text-text-secondary">{error}</p>
          <button
            onClick={() => setReloadNonce((prev) => prev + 1)}
            className="btn btn-primary mt-4 text-sm"
          >
            {tc('retry')}
          </button>
        </div>
      </div>
    );
  }

  const totals = data?.totals || {
    adsCount: 0,
    conversationCount: 0,
    qualifyConversationCount: 0,
    proofConversationCount: 0,
    qualifyConversationRate: 0,
    proofConversationRate: 0,
  };

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">{t('title')}</h1>
          <p className="mt-1 text-sm text-text-secondary">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {[7, 14, 30].map((value) => (
            <button
              key={value}
              onClick={() => {
                setIsCustom(false);
                setDays(value);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                !isCustom && days === value
                  ? 'bg-accent-blue text-white'
                  : 'bg-surface-hover text-text-secondary hover:text-text-primary'
              }`}
            >
              {value}D
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
                onChange={(event) => setCustomRange((prev) => ({ ...prev, start: event.target.value }))}
                className="input text-xs !w-auto !py-1.5 !px-2"
              />
              <span className="text-xs text-text-muted">{tc('to')}</span>
              <input
                type="date"
                value={customRange.end}
                onChange={(event) => setCustomRange((prev) => ({ ...prev, end: event.target.value }))}
                className="input text-xs !w-auto !py-1.5 !px-2"
              />
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <KpiCard label={t('adsCount')} value={totals.adsCount} />
        <KpiCard label={t('conversationCount')} value={totals.conversationCount} />
        <KpiCard label={t('qualifyInquiryRate')} value={totals.qualifyConversationRate} suffix="%" />
        <KpiCard label={t('proofInquiryRate')} value={totals.proofConversationRate} suffix="%" />
      </div>

      {!data?.summary?.length ? (
        <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[1.25fr_0.95fr]">
          <div className="card overflow-hidden">
            <div className="border-b border-border px-5 py-4">
              <h2 className="text-sm font-semibold text-text-secondary">{t('adList')}</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-surface-hover/60 text-left text-text-tertiary">
                  <tr>
                    <th className="px-5 py-3 font-medium">{t('adId')}</th>
                    <th className="px-5 py-3 font-medium">{t('conversationCount')}</th>
                    <th className="px-5 py-3 font-medium">{t('qualifyInquiryRate')}</th>
                    <th className="px-5 py-3 font-medium">{t('proofInquiryRate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.summary.map((item) => {
                    const isSelected = item.metaAdId === selectedAdId;
                    return (
                      <tr
                        key={item.metaAdId}
                        onClick={() => setSelectedAdId(item.metaAdId)}
                        className={`cursor-pointer border-t border-border-subtle transition-colors ${
                          isSelected ? 'bg-accent-blue/5' : 'hover:bg-surface-hover/60'
                        }`}
                      >
                        <td className="px-5 py-3">
                          <div className="font-medium text-text-primary">{item.metaAdId}</div>
                        </td>
                        <td className="px-5 py-3 text-text-primary tabular-nums">{item.conversationCount}</td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <div className="h-2 w-24 overflow-hidden rounded-full bg-surface-hover">
                              <div
                                className="h-full rounded-full bg-accent-blue"
                                style={{ width: `${item.qualifyConversationRate}%` }}
                              />
                            </div>
                            <span className="tabular-nums text-text-primary">
                              {item.qualifyConversationRate}% ({item.qualifyConversationCount}/{item.conversationCount})
                            </span>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <div className="h-2 w-24 overflow-hidden rounded-full bg-surface-hover">
                              <div
                                className="h-full rounded-full bg-accent-green"
                                style={{ width: `${item.proofConversationRate}%` }}
                              />
                            </div>
                            <span className="tabular-nums text-text-primary">
                              {item.proofConversationRate}% ({item.proofConversationCount}/{item.conversationCount})
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-5">
            <div className="card p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-text-secondary">{t('selectedAd')}</h2>
                  <div className="mt-2 text-lg font-semibold text-text-primary break-all">
                    {selectedAd?.metaAdId || '-'}
                  </div>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-3">
                <div className="rounded-lg bg-surface-hover/70 p-3">
                  <div className="text-xs text-text-tertiary">{t('conversationCount')}</div>
                  <div className="mt-1 text-xl font-semibold text-text-primary tabular-nums">
                    {selectedAd?.conversationCount || 0}
                  </div>
                </div>
                <div className="rounded-lg bg-surface-hover/70 p-3">
                  <div className="text-xs text-text-tertiary">{t('qualifyInquiryRate')}</div>
                  <div className="mt-1 text-xl font-semibold text-text-primary tabular-nums">
                    {selectedAd?.qualifyConversationRate || 0}%
                  </div>
                  <div className="mt-1 text-xs text-text-secondary">
                    {selectedAd?.qualifyConversationCount || 0}/{selectedAd?.conversationCount || 0}
                  </div>
                </div>
                <div className="rounded-lg bg-surface-hover/70 p-3">
                  <div className="text-xs text-text-tertiary">{t('proofInquiryRate')}</div>
                  <div className="mt-1 text-xl font-semibold text-text-primary tabular-nums">
                    {selectedAd?.proofConversationRate || 0}%
                  </div>
                  <div className="mt-1 text-xs text-text-secondary">
                    {selectedAd?.proofConversationCount || 0}/{selectedAd?.conversationCount || 0}
                  </div>
                </div>
              </div>
            </div>

            <div className="card p-5">
              <h2 className="text-sm font-semibold text-text-secondary">{t('dailyConversationTrend')}</h2>
              <div className="mt-4 h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={selectedAd?.dailyConversations || []}>
                    <CartesianGrid stroke="#E5E7EB" strokeDasharray="3 3" strokeOpacity={0.45} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatChartDate}
                      tick={{ fontSize: 11, fill: '#6B7280' }}
                    />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#6B7280' }} />
                    <Tooltip
                      formatter={(value) => [value, t('conversationCount')]}
                      labelFormatter={(label) => formatChartDate(label)}
                    />
                    <Line
                      type="monotone"
                      dataKey="count"
                      stroke={CHART_COLOR}
                      strokeWidth={2.5}
                      dot={{ r: 3, strokeWidth: 0 }}
                      activeDot={{ r: 5 }}
                      name={t('conversationCount')}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
