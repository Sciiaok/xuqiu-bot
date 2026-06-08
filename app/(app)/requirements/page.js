'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import s from './page.module.css';

const STATUSES = [
  ['all', '全部状态'],
  ['needs_pm', '待 PM 界定'],
  ['needs_info', '需补充信息'],
  ['ready_for_dev', '待开发'],
  ['in_dev', '开发中'],
  ['ready_for_test', '待测试'],
  ['in_test', '测试中'],
  ['ready_for_acceptance', '待产品验收'],
  ['closed', '已关闭'],
  ['rejected', '不处理'],
];

const PRIORITIES = [
  ['all', '全部优先级'],
  ['P0', 'P0'],
  ['P1', 'P1'],
  ['P2', 'P2'],
  ['P3', 'P3'],
];

const TYPES = [
  ['all', '全部类型'],
  ['incident', '线上问题'],
  ['improvement', '小优化'],
  ['feature', '新功能'],
  ['data_report', '数据/报表'],
  ['other', '其他'],
];

function formatDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function activeDueAt(row) {
  if (row.status === 'needs_pm' || row.status === 'needs_info') return row.pm_due_at;
  if (row.status === 'ready_for_dev' || row.status === 'in_dev') return row.dev_due_at;
  if (row.status === 'ready_for_test' || row.status === 'in_test') return row.test_due_at;
  if (row.status === 'ready_for_acceptance') return row.acceptance_due_at;
  return null;
}

function isOverdue(row) {
  const due = activeDueAt(row);
  return Boolean(due && new Date(due) < new Date() && !['closed', 'rejected'].includes(row.status));
}

function statusLabel(value) {
  return STATUSES.find(([key]) => key === value)?.[1] || value;
}

function typeLabel(value) {
  return TYPES.find(([key]) => key === value)?.[1] || value;
}

export default function RequirementsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState({
    status: 'all',
    priority: 'all',
    requirement_type: 'all',
    current_owner: '',
  });

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (filters.status !== 'all') params.set('status', filters.status);
      if (filters.priority !== 'all') params.set('priority', filters.priority);
      if (filters.requirement_type !== 'all') params.set('requirement_type', filters.requirement_type);
      if (filters.current_owner.trim()) params.set('current_owner', filters.current_owner.trim());
      const res = await fetch(`/api/requirements?${params}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || '加载失败');
      setRows(data.data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const metrics = useMemo(() => {
    const openRows = rows.filter(row => !['closed', 'rejected'].includes(row.status));
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    return {
      open: openRows.length,
      overdue: openRows.filter(isOverdue).length,
      high: openRows.filter(row => row.priority === 'P0' || row.priority === 'P1').length,
      closedWeek: rows.filter(row => row.closed_at && new Date(row.closed_at) >= weekAgo).length,
    };
  }, [rows]);

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <h1 className={s.title}>需求工作台</h1>
          <p className={s.subtitle}>飞书卡片推进，后台查看全局、延期和归档。</p>
        </div>
        <button className={s.refreshBtn} onClick={load} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {error && <div className={s.error}>{error}</div>}

      <div className={s.metrics}>
        <Metric label="未关闭" value={metrics.open} />
        <Metric label="延期" value={metrics.overdue} tone={metrics.overdue ? 'bad' : ''} />
        <Metric label="P0/P1" value={metrics.high} />
        <Metric label="本周关闭" value={metrics.closedWeek} />
      </div>

      <div className={s.filters}>
        <Select value={filters.status} options={STATUSES} onChange={value => setFilters(prev => ({ ...prev, status: value }))} />
        <Select value={filters.priority} options={PRIORITIES} onChange={value => setFilters(prev => ({ ...prev, priority: value }))} />
        <Select value={filters.requirement_type} options={TYPES} onChange={value => setFilters(prev => ({ ...prev, requirement_type: value }))} />
        <input
          className={s.ownerInput}
          value={filters.current_owner}
          onChange={e => setFilters(prev => ({ ...prev, current_owner: e.target.value }))}
          placeholder="负责人飞书 ID"
        />
        <button className={s.applyBtn} onClick={load}>筛选</button>
      </div>

      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th>编号</th>
              <th>标题</th>
              <th>状态</th>
              <th>优先级</th>
              <th>负责人</th>
              <th>下一截止</th>
              <th>同步</th>
              <th>飞书</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="8" className={s.empty}>加载中…</td></tr>
            ) : rows.length ? rows.map(row => (
              <tr key={row.id} className={isOverdue(row) ? s.overdueRow : ''}>
                <td><Link href={`/requirements/${row.id}`} className={s.reqLink}>{row.req_no}</Link></td>
                <td>
                  <div className={s.titleCell}>{row.title}</div>
                  <div className={s.typeCell}>{typeLabel(row.requirement_type)}</div>
                </td>
                <td><span className={s.statusBadge}>{statusLabel(row.status)}</span></td>
                <td><span className={`${s.priority} ${s[row.priority] || ''}`}>{row.priority}</span></td>
                <td className={s.mono}>{row.current_owner_feishu_user_id || '-'}</td>
                <td className={isOverdue(row) ? s.dueBad : ''}>{formatDate(activeDueAt(row))}</td>
                <td>{row.bitable_sync_status}</td>
                <td>{row.feishu_card_url ? <a href={row.feishu_card_url} target="_blank" rel="noreferrer">打开</a> : '-'}</td>
              </tr>
            )) : (
              <tr><td colSpan="8" className={s.empty}>暂无需求</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Metric({ label, value, tone = '' }) {
  return (
    <div className={`${s.metric} ${tone ? s[tone] : ''}`}>
      <div className={s.metricValue}>{value}</div>
      <div className={s.metricLabel}>{label}</div>
    </div>
  );
}

function Select({ value, options, onChange }) {
  return (
    <select className={s.select} value={value} onChange={e => onChange(e.target.value)}>
      {options.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select>
  );
}
