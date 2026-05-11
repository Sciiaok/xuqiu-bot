'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import s from './page.module.css';
import Card from '../../components/Card/Card';
import MetricCard from '../../components/MetricCard/MetricCard';
import PillBar from '../../components/PillBar/PillBar';
import Button from '../../components/Button/Button';
import Tag from '../../components/Tag/Tag';
import Skeleton, { SkeletonStack } from '../../components/Skeleton/Skeleton';
import EmptyState from '../../components/EmptyState/EmptyState';

// ─── Constants ───────────────────────────────────────────────────────────────

const TYPE_ITEMS = [
  { key: 'all', label: '全部' },
  { key: 'daily', label: '日报' },
  { key: 'weekly', label: '周报' },
  { key: 'monthly', label: '月报' },
  { key: 'manual', label: '手动' },
];

const TIME_ITEMS = [
  { key: '7d', label: '近7天' },
  { key: '30d', label: '近30天' },
  { key: 'custom', label: '自定义' },
];

const TYPE_LABELS = { daily: '日报', weekly: '周报', monthly: '月报', manual: '手动' };
const TYPE_TAG_VARIANT = { daily: 'good', weekly: 'qualify', monthly: 'proof', manual: 'new' };

function formatPeriod(start, end) {
  const s = start?.slice(5).replace('-', '.'); // "03.24"
  const e = end?.slice(5).replace('-', '.');
  if (s === e) return s;
  return `${s} ~ ${e}`;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

function deltaLabel(delta) {
  if (delta == null) return null;
  if (delta > 0) return `+${delta}%`;
  if (delta < 0) return `${delta}%`;
  return '持平';
}

function deltaTrend(delta) {
  if (delta == null) return 'neutral';
  if (delta > 0) return 'up';
  if (delta < 0) return 'down';
  return 'neutral';
}

// ─── Generate Report Modal ───────────────────────────────────────────────────

function GenerateModal({ onClose, onGenerate }) {
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    if (!startDate || !endDate) return;
    setGenerating(true);
    try {
      await onGenerate({ periodStart: startDate, periodEnd: endDate });
      onClose();
    } catch (err) {
      console.error('Generate error:', err);
      setGenerating(false);
    }
  };

  return (
    <div className={s.modalOverlay} onClick={onClose}>
      <div className={s.modal} onClick={e => e.stopPropagation()}>
        <div className={s.modalTitle}>生成报告</div>
        <div className={s.modalField}>
          <label className={s.modalLabel}>时间范围</label>
          <div className={s.modalDateRow}>
            <input
              type="date"
              className={s.dateInput}
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
            />
            <span className={s.modalDateSep}>~</span>
            <input
              type="date"
              className={s.dateInput}
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
            />
          </div>
        </div>
        <div className={s.modalActions}>
          <Button variant="ghost" size="sm" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleGenerate}
            disabled={!startDate || !endDate || generating}
          >
            {generating ? '生成中...' : '确认生成'}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Report Card ─────────────────────────────────────────────────────────────

function ReportCard({ report, onClick }) {
  const kpi = report.kpi_snapshot;
  const isGenerating = report.status === 'generating';
  const isFailed = report.status === 'failed';

  return (
    <div className={s.reportCard} onClick={onClick}>
      <div className={s.cardTop}>
        <div className={s.cardMeta}>
          <Tag variant={TYPE_TAG_VARIANT[report.type] || 'good'}>
            {TYPE_LABELS[report.type] || report.type}
          </Tag>
          <span className={s.cardPeriod}>{formatPeriod(report.period_start, report.period_end)}</span>
          <span className={s.cardTime}>{formatDate(report.created_at)}</span>
        </div>
        {isFailed && <span className={s.failedBadge}>生成失败</span>}
        {isGenerating && <span className={s.generatingBadge}>生成中...</span>}
      </div>

      {/* KPI row */}
      {kpi && (
        <div className={s.cardKpi}>
          <span className={s.kpiItem}>
            询盘 <strong>{kpi.totalInquiries?.value ?? '—'}</strong>
            {kpi.totalInquiries?.delta != null && (
              <span className={kpi.totalInquiries.delta >= 0 ? s.kpiUp : s.kpiDown}>
                {deltaLabel(kpi.totalInquiries.delta)}
              </span>
            )}
          </span>
          <span className={s.kpiSep} />
          <span className={s.kpiItem}>
            高质量率 <strong>{kpi.proofRate?.value ?? '—'}%</strong>
            {kpi.proofRate?.delta != null && (
              <span className={kpi.proofRate.delta >= 0 ? s.kpiUp : s.kpiDown}>
                {deltaLabel(kpi.proofRate.delta)}
              </span>
            )}
          </span>
          <span className={s.kpiSep} />
          <span className={s.kpiItem}>
            高质量询盘 <strong>{kpi.proofCount?.value ?? '—'}</strong>
          </span>
        </div>
      )}

      {/* Summary line */}
      {report.summary_line && (
        <div className={s.cardSummary}>{report.summary_line}</div>
      )}
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const router = useRouter();
  const [typeFilter, setTypeFilter] = useState('all');
  const [timeFilter, setTimeFilter] = useState('30d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [reports, setReports] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [offset, setOffset] = useState(0);
  const PAGE_SIZE = 20;

  const fetchReports = useCallback(async (reset = false) => {
    const newOffset = reset ? 0 : offset;
    if (reset) setOffset(0);
    setLoading(true);

    try {
      const params = new URLSearchParams({ limit: PAGE_SIZE, offset: newOffset });
      if (typeFilter !== 'all') params.set('type', typeFilter);

      // Date filter
      if (timeFilter === 'custom' && customFrom) {
        params.set('from', customFrom);
        if (customTo) params.set('to', customTo);
      } else if (timeFilter === '7d') {
        const d = new Date();
        d.setDate(d.getDate() - 7);
        params.set('from', d.toISOString().split('T')[0]);
      } else if (timeFilter === '30d') {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        params.set('from', d.toISOString().split('T')[0]);
      }

      const res = await fetch(`/api/reports?${params}`);
      if (!res.ok) throw new Error('Failed to fetch reports');
      const data = await res.json();

      if (reset || newOffset === 0) {
        setReports(data.reports || []);
      } else {
        setReports(prev => [...prev, ...(data.reports || [])]);
      }
      setTotal(data.total || 0);
    } catch (err) {
      console.error('fetchReports error:', err);
    } finally {
      setLoading(false);
    }
  }, [typeFilter, timeFilter, customFrom, customTo, offset]);

  // Re-fetch on filter change
  useEffect(() => {
    fetchReports(true);
  }, [typeFilter, timeFilter, customFrom, customTo]);

  const handleLoadMore = () => {
    const nextOffset = offset + PAGE_SIZE;
    setOffset(nextOffset);
  };

  // Load more when offset changes (but not on initial mount)
  useEffect(() => {
    if (offset > 0) fetchReports(false);
  }, [offset]);

  const handleGenerate = async ({ periodStart, periodEnd }) => {
    const res = await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ periodStart, periodEnd }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed');
    }
    // Refresh list
    fetchReports(true);
  };

  const handleRetry = async (e, reportId) => {
    e.stopPropagation();
    try {
      await fetch(`/api/reports/${reportId}`, { method: 'POST' });
      fetchReports(true);
    } catch (err) {
      console.error('Retry error:', err);
    }
  };

  const hasMore = reports.length < total;

  return (
    <div className={s.page}>
      {/* Header */}
      <div className={s.header}>
        <div className={s.headerLeft}>
          <h1 className={s.title}>AI 报告</h1>
          <p className={s.subtitle}>AI 智能分析报告 · 自动生成日报 / 周报 / 月报</p>
        </div>
        <div className={s.headerActions}>
          <Button variant="primary" size="sm" onClick={() => setShowModal(true)}>+ 生成报告</Button>
        </div>
      </div>

      {/* Filters */}
      <div className={s.filterRow}>
        <PillBar items={TYPE_ITEMS} active={typeFilter} onChange={setTypeFilter} variant="tr" />
        <div className={s.divider} />
        <PillBar items={TIME_ITEMS} active={timeFilter} onChange={setTimeFilter} variant="tr" />
        {timeFilter === 'custom' && (
          <>
            <input
              type="date"
              className={s.dateInput}
              value={customFrom}
              onChange={e => setCustomFrom(e.target.value)}
            />
            <span style={{ color: 'var(--text3)', fontSize: 12 }}>~</span>
            <input
              type="date"
              className={s.dateInput}
              value={customTo}
              onChange={e => setCustomTo(e.target.value)}
            />
          </>
        )}
      </div>

      {/* Report list */}
      <div className={s.reportList}>
        {loading && reports.length === 0 ? (
          <SkeletonStack>
            <Skeleton variant="card" height={110} />
            <Skeleton variant="card" height={110} />
            <Skeleton variant="card" height={110} />
            <Skeleton variant="card" height={110} />
          </SkeletonStack>
        ) : reports.length === 0 ? (
          <EmptyState
            icon="📰"
            title="还没有报告"
            body="当前筛选条件下没有报告。AI 会按日/周/月自动生成，也可以手动触发生成。"
          />
        ) : (
          reports.map(report => (
            <ReportCard
              key={report.id}
              report={report}
              onClick={() => {
                if (report.status === 'completed') {
                  router.push(`/reports/${report.id}`);
                }
              }}
            />
          ))
        )}

        {hasMore && !loading && (
          <div className={s.loadMore}>
            <Button variant="ghost" size="sm" onClick={handleLoadMore}>加载更多</Button>
          </div>
        )}
      </div>

      {/* Generate modal */}
      {showModal && (
        <GenerateModal
          onClose={() => setShowModal(false)}
          onGenerate={handleGenerate}
        />
      )}
    </div>
  );
}
