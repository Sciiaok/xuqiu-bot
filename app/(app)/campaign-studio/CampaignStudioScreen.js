'use client';

import { useState, useEffect } from 'react';
import s from './page.module.css';
import MetricCard from '../../components/MetricCard/MetricCard';
import TabBar from '../../components/TabBar/TabBar';
import PillBar from '../../components/PillBar/PillBar';
import {
  formatCurrency,
  formatCount,
  formatRangeLabel,
  buildRangeRequest,
} from './helpers';
import Skeleton, { SkeletonRow, SkeletonStack } from '../../components/Skeleton/Skeleton';
import EmptyState from '../../components/EmptyState/EmptyState';
import AdStatusGroup, { ImageLightbox } from './AdRow';
import AttributionTab from './AttributionTab';

// ─── Tab definitions ──────────────────────────────────────────────
// The legacy `ai` tab (campaign orchestrator chat) was replaced by the
// standalone /ogilvy route in PR 4. Campaign Studio is now strictly
// data/analytics — list + attribution.
const MAIN_TABS = [
  { key: 'list', label: '📊 广告列表' },
  { key: 'attribution', label: '🎯 深度归因分析' },
];

const TIME_FILTER_ITEMS = [
  { key: '1d', label: '昨天' },
  { key: '7d', label: '前一周' },
  { key: '30d', label: '前一个月' },
  { key: '365d', label: '前一年' },
  { key: 'custom', label: '自定义' },
];

// ImageLightbox / SparkBars / ScoreRing / AdRow / AdStatusGroup moved to
// ./AdRow.js; AttributionTab moved to ./AttributionTab.js.

// ─── (removed — see ./AdRow.js) ──────────────────────────────────
// ─── List Tab ────────────────────────────────────────────────────
function ListTab({ dashboard, loading, rangeLabel, isSingleDay, onPreview }) {
  if (loading) {
    return (
      <SkeletonStack className={s.listSkeleton}>
        <Skeleton variant="card" height={48} />
        <Skeleton variant="card" height={48} />
        <Skeleton variant="card" height={48} />
        <Skeleton variant="card" height={48} />
        <Skeleton variant="card" height={48} />
      </SkeletonStack>
    );
  }

  const ads = dashboard?.ads || [];
  if (ads.length === 0) {
    return (
      <EmptyState
        icon="📊"
        title="暂无广告数据"
        body="当前筛选条件下没有匹配的广告。换个时间段或检查 Meta 账户的投放状态。"
      />
    );
  }

  const activeAds = ads.filter((ad) => ad.status === 'active');
  const endedAds = ads.filter((ad) => ad.status !== 'active');

  return (
    <div className={s.dayList}>
      {activeAds.length > 0 && (
        <AdStatusGroup
          title="投放中"
          ads={activeAds}
          defaultExpanded
          rangeLabel={rangeLabel}
          isSingleDay={isSingleDay}
          onPreview={onPreview}
        />
      )}
      {endedAds.length > 0 && (
        <AdStatusGroup
          title="已结束"
          ads={endedAds}
          defaultExpanded={activeAds.length === 0}
          rangeLabel={rangeLabel}
          isSingleDay={isSingleDay}
          onPreview={onPreview}
        />
      )}
    </div>
  );
}


// ─── Main Page ───────────────────────────────────────────────────
export function CampaignStudioScreen({
  title = 'Campaign Studio',
  subtitle = 'AI 自动化投放 · 广告管理 · 深度效果分析 · 近 {days} 天',
  visibleTabKeys = ['list', 'ai', 'attribution'],
  defaultTab = 'list',
  showMetrics = true,
  workspaceMode = false,
}) {
  const tabs = MAIN_TABS.filter(item => visibleTabKeys.includes(item.key));
  const initialTab = tabs.find(item => item.key === defaultTab)?.key || tabs[0]?.key || 'list';
  const requiresAdsData = showMetrics || visibleTabKeys.includes('list') || visibleTabKeys.includes('attribution');
  const [tab, setTab] = useState(initialTab);
  const shouldFetchAttribution = visibleTabKeys.includes('attribution') && tab === 'attribution';
  const [adsData, setAdsData] = useState(null);
  const [dashboardData, setDashboardData] = useState(null);
  const [quickTotals, setQuickTotals] = useState(null);
  const [loadingAds, setLoadingAds] = useState(requiresAdsData);
  const [timeFilter, setTimeFilter] = useState('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [metricsMap, setMetricsMap] = useState(new Map());
  const [preview, setPreview] = useState(null); // { url, adId }
  const rangeRequest = buildRangeRequest(timeFilter, customFrom, customTo);
  const rangeQuery = rangeRequest.params;
  const daysFilter = rangeRequest.days;
  const subtitleLabel = rangeRequest.label;

  useEffect(() => {
    if (!tabs.some(item => item.key === tab)) {
      setTab(initialTab);
    }
  }, [initialTab, tab, tabs]);

  useEffect(() => {
    if (!requiresAdsData) {
      setLoadingAds(false);
      return;
    }

    // Quick KPI: fire a lightweight Meta insights call that returns in ~3-5s.
    // This populates the top metric strip immediately while the heavy dashboard
    // call (creatives, images, videos) loads in the background.
    setQuickTotals(null);
    fetch(`/api/ads/metrics?${rangeQuery}&totalsOnly=true`)
      .then((r) => r.ok ? r.json() : null)
      .then((json) => { if (json?.totals) setQuickTotals(json.totals); })
      .catch(() => {});

    async function fetchAds() {
      setLoadingAds(true);
      try {
        const dashboardRes = await fetch(`/api/ads/dashboard?${rangeQuery}`);
        if (!dashboardRes.ok) throw new Error('Failed to fetch ad dashboard');
        const dashboard = await dashboardRes.json();
        setDashboardData(dashboard);

        if (shouldFetchAttribution) {
          const [adsRes, metricsRes] = await Promise.all([
            fetch(`/api/ads?${rangeQuery}`),
            fetch(`/api/ads/metrics?${rangeQuery}`),
          ]);

          if (adsRes.ok) {
            const data = await adsRes.json();
            setAdsData(data);
          } else {
            console.warn('Failed to fetch attribution ads payload');
          }

          if (metricsRes.ok) {
            const metricsData = await metricsRes.json();
            const map = new Map();
            for (const item of metricsData.metrics || []) {
              map.set(item.adId, item);
            }
            setMetricsMap(map);
          } else {
            console.warn('Failed to fetch attribution metrics payload');
          }
        }
      } catch (err) {
        console.error('Error fetching ads:', err);
      } finally {
        setLoadingAds(false);
      }
    }
    fetchAds();
  }, [rangeQuery, requiresAdsData, shouldFetchAttribution]);

  // KPI metrics: prefer full dashboard totals, fall back to the quick
  // totals-only call that returns before the heavy dashboard finishes.
  const dashboardTotals = dashboardData?.summary;
  const totals = dashboardTotals || quickTotals;
  const dashboardRange = dashboardData?.range;
  const rangeLabel = formatRangeLabel(dashboardRange);
  const campaignSubtitle = timeFilter === 'custom' && customFrom && customTo
    ? subtitle.replace(/近 \{days\} 天/, '自定义范围')
    : subtitle.replace('{days}', String(daysFilter));

  return (
    <div className={`${s.root} ${workspaceMode ? s.rootWorkspace : ''}`}>
      {/* Page header */}
      <div className={`${s.header} ${workspaceMode ? s.headerWorkspace : ''}`}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>{title}</h1>
          <span className={s.subtitle}>{campaignSubtitle}</span>
        </div>
      </div>

      {showMetrics && (
        <div className={s.filterRow}>
          <PillBar items={TIME_FILTER_ITEMS} active={timeFilter} onChange={setTimeFilter} variant="tr" />
          {timeFilter === 'custom' && (
            <>
              <input
                type="date"
                className={s.dateInput}
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
              <span style={{ color: 'var(--text3)', fontSize: 12 }}>~</span>
              <input
                type="date"
                className={s.dateInput}
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </>
          )}
        </div>
      )}

      {/* Metric strip */}
      {showMetrics && (
        <div className={s.metrics}>
          <MetricCard
            label="总花费"
            value={
              totals?.spend != null
                ? formatCurrency(totals.spend)
                : loadingAds ? '…' : '—'
            }
            delta={totals?.spend != null ? `${subtitleLabel} CTR ${totals.ctr ?? 0}%` : ''}
            trend="neutral"
          />
          <MetricCard
            label="展示"
            value={totals?.impressions != null ? totals.impressions.toLocaleString() : loadingAds ? '…' : '—'}
            delta={totals ? `点击 ${totals.clicks?.toLocaleString() ?? 0}` : ''}
            trend="up"
            color="green"
          />
          <MetricCard
            label="广告数"
            value={totals?.totalAds != null ? totals.totalAds.toLocaleString() : loadingAds ? '…' : '—'}
            delta={totals ? `投放中 ${totals.activeAds ?? 0} · 已结束 ${totals.endedAds ?? 0}` : ''}
            trend="neutral"
            color="teal"
          />
          <MetricCard
            label="WA 对话"
            value={totals?.waConversations != null ? totals.waConversations.toLocaleString() : loadingAds ? '…' : '—'}
            delta={totals ? `中质量率 ${totals.qualifyRate ?? 0}%` : ''}
            trend="neutral"
            color="purple"
          />
          <MetricCard
            label="高质量对话"
            value={totals?.proofConversations != null ? totals.proofConversations.toLocaleString() : loadingAds ? '…' : '—'}
            delta={totals ? `${totals.proofRate ?? 0}% 率 · CPA ${formatCurrency(totals.cpa || 0)}` : ''}
            trend="up"
            color="amber"
          />
        </div>
      )}

      {/* Tab bar */}
      {tabs.length > 1 && <TabBar tabs={tabs} active={tab} onChange={setTab} />}

      {/* Tab content */}
      <div className={`${s.tabContent} ${workspaceMode ? s.tabContentWorkspace : ''}`}>
        {tab === 'list' && (
          <ListTab
            dashboard={dashboardData}
            loading={loadingAds}
            rangeLabel={rangeLabel}
            isSingleDay={Boolean(dashboardRange?.isSingleDay)}
            onPreview={setPreview}
          />
        )}
        {tab === 'attribution' && (
          <AttributionTab
            adsData={adsData}
            loading={loadingAds}
            daysFilter={daysFilter}
            metricsMap={metricsMap}
            range={dashboardRange}
            selectedLine="all"
          />
        )}
      </div>

      <ImageLightbox url={preview?.url} adId={preview?.adId} onClose={() => setPreview(null)} />
    </div>
  );
}

export default CampaignStudioScreen;
