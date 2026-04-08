'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import s from './page.module.css';
import Card from '../../../components/Card/Card';
import MetricCard from '../../../components/MetricCard/MetricCard';
import Button from '../../../components/Button/Button';
import Tag from '../../../components/Tag/Tag';

const TYPE_LABELS = { daily: '日报', weekly: '周报', monthly: '月报', manual: '手动报告' };

function formatPeriod(start, end) {
  if (start === end) return start;
  return `${start} ~ ${end}`;
}

function deltaLabel(d) {
  if (d == null) return null;
  if (d > 0) return `↑ +${d}%`;
  if (d < 0) return `↓ ${d}%`;
  return '持平';
}

function deltaTrend(d) {
  if (d > 0) return 'up';
  if (d < 0) return 'down';
  return 'neutral';
}

// ─── Section renderers ───────────────────────────────────────────────────────

function BulletList({ items, className }) {
  if (!items || items.length === 0) return <p className={s.emptyNote}>暂无数据</p>;
  return (
    <ul className={`${s.bulletList} ${className || ''}`}>
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ul>
  );
}

function ActionSuggestions({ data }) {
  if (!data) return <p className={s.emptyNote}>暂无建议</p>;
  const layers = [
    { key: 'operations', label: '运营层', icon: '📊' },
    { key: 'communication', label: '话术层', icon: '💬' },
    { key: 'product', label: '产品层', icon: '📦' },
  ];
  return (
    <div className={s.suggestionsGrid}>
      {layers.map(({ key, label, icon }) => (
        <div key={key} className={s.suggestionCol}>
          <div className={s.suggestionLabel}>{icon} {label}</div>
          <BulletList items={data[key]} />
        </div>
      ))}
    </div>
  );
}

function AppendixTable({ title, data, columns }) {
  if (!data || data.length === 0) return null;
  return (
    <div className={s.appendixBlock}>
      <div className={s.appendixTitle}>{title}</div>
      <div className={s.appendixTable}>
        <div className={s.appendixHeader}>
          {columns.map(c => <span key={c.key}>{c.label}</span>)}
        </div>
        {data.map((row, i) => (
          <div key={i} className={s.appendixRow}>
            {columns.map(c => (
              <span key={c.key} className={s.appendixCell}>{c.render ? c.render(row) : row[c.key]}</span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────────────────────

export default function ReportDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const res = await fetch(`/api/reports/${id}`);
        if (!res.ok) throw new Error('Failed to load');
        const data = await res.json();
        setReport(data.report);
      } catch (err) {
        console.error('Load report error:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  const handleRetry = async () => {
    setRetrying(true);
    try {
      const res = await fetch(`/api/reports/${id}`, { method: 'POST' });
      if (!res.ok) throw new Error('Retry failed');
      const data = await res.json();
      setReport(data.report);
    } catch (err) {
      console.error('Retry error:', err);
    } finally {
      setRetrying(false);
    }
  };

  if (loading) {
    return (
      <div className={s.page}>
        <div className={s.loading}>加载中...</div>
      </div>
    );
  }

  if (!report) {
    return (
      <div className={s.page}>
        <div className={s.loading}>报告不存在</div>
      </div>
    );
  }

  const content = report.content || {};
  const kpi = report.kpi_snapshot;
  const isDaily = report.type === 'daily';
  const isFull = !isDaily;

  return (
    <div className={s.page}>
      {/* Top bar */}
      <div className={s.topBar}>
        <button className={s.backBtn} onClick={() => router.push('/reports')}>
          ← 返回列表
        </button>
        <div className={s.topActions}>
          {report.status === 'failed' && (
            <Button variant="danger" size="sm" onClick={handleRetry} disabled={retrying}>
              {retrying ? '重试中...' : '重试'}
            </Button>
          )}
        </div>
      </div>

      {/* Title */}
      <div className={s.reportHeader}>
        <Tag variant={report.type === 'daily' ? 'good' : report.type === 'weekly' ? 'qualify' : report.type === 'monthly' ? 'proof' : 'new'}>
          {TYPE_LABELS[report.type]}
        </Tag>
        <h1 className={s.reportTitle}>
          {TYPE_LABELS[report.type]} · {formatPeriod(report.period_start, report.period_end)}
        </h1>
        <div className={s.reportMeta}>
          {report.generated_at && <span>生成于 {new Date(report.generated_at).toLocaleString('zh-CN')}</span>}
          {report.status === 'failed' && <span className={s.failedText}>生成失败: {report.error_message}</span>}
        </div>
      </div>

      {report.status !== 'completed' ? (
        <div className={s.statusMessage}>
          {report.status === 'generating' ? '报告正在生成中，请稍候刷新...' : '报告生成失败，请点击重试。'}
        </div>
      ) : (
        <>
          {/* Section 1: KPI Overview */}
          {kpi && (
            <section className={s.section}>
              <h2 className={s.sectionTitle}>一、数据概览</h2>
              <div className={s.kpiGrid}>
                <MetricCard
                  label="总询盘数"
                  value={kpi.totalInquiries?.value ?? '—'}
                  delta={deltaLabel(kpi.totalInquiries?.delta)}
                  trend={deltaTrend(kpi.totalInquiries?.delta)}
                  color="accent"
                />
                <MetricCard
                  label="高质量询盘数"
                  value={kpi.proofCount?.value ?? '—'}
                  delta={deltaLabel(kpi.proofCount?.delta)}
                  trend={deltaTrend(kpi.proofCount?.delta)}
                  color="green"
                />
                <MetricCard
                  label="高质量率"
                  value={`${kpi.proofRate?.value ?? '—'}%`}
                  delta={deltaLabel(kpi.proofRate?.delta)}
                  trend={deltaTrend(kpi.proofRate?.delta)}
                  color="amber"
                />
                <MetricCard
                  label="高商业价值占比"
                  value={`${kpi.highBVRate?.value ?? '—'}%`}
                  delta={deltaLabel(kpi.highBVRate?.delta)}
                  trend={deltaTrend(kpi.highBVRate?.delta)}
                  color="purple"
                />
              </div>
            </section>
          )}

          {/* Section 2: Highlights */}
          <section className={s.section}>
            <h2 className={s.sectionTitle}>二、业务亮点</h2>
            <Card>
              <BulletList items={content.highlights} className={s.highlightList} />
            </Card>
          </section>

          {/* Section 3: Problems */}
          <section className={s.section}>
            <h2 className={s.sectionTitle}>三、业务问题</h2>
            <Card>
              <BulletList items={content.problems} className={s.problemList} />
            </Card>
          </section>

          {/* Section 4: Customer Insights (full reports only) */}
          {isFull && content.customer_insights && (
            <section className={s.section}>
              <h2 className={s.sectionTitle}>四、客户洞察</h2>
              <Card>
                <BulletList items={content.customer_insights} />
              </Card>
            </section>
          )}

          {/* Section 5: Action Suggestions (full reports only) */}
          {isFull && content.action_suggestions && (
            <section className={s.section}>
              <h2 className={s.sectionTitle}>五、行动建议</h2>
              <ActionSuggestions data={content.action_suggestions} />
            </section>
          )}

          {/* Section 6: Appendix (full reports only) */}
          {isFull && content.appendix && (
            <section className={s.section}>
              <h2 className={s.sectionTitle}>六、附录</h2>
              <AppendixTable
                title="业务线明细"
                data={content.appendix.supplyChains}
                columns={[
                  { key: 'name', label: '业务线' },
                  { key: 'total', label: '总询盘' },
                  { key: 'PROOF', label: '高质量' },
                  { key: 'QUALIFY', label: '中质量' },
                  { key: 'GOOD', label: '低质量' },
                  { key: 'BAD', label: '无效' },
                  { key: 'rate', label: '高质量率', render: r => r.total > 0 ? `${Math.round(r.PROOF / r.total * 100)}%` : '—' },
                ]}
              />
              <AppendixTable
                title="国家分布 Top 5"
                data={content.appendix.countryDistribution}
                columns={[
                  { key: 'country', label: '国家' },
                  { key: 'total', label: '询盘数' },
                  { key: 'PROOF', label: '高质量' },
                  { key: 'rate', label: '高质量率', render: r => r.total > 0 ? `${Math.round(r.PROOF / r.total * 100)}%` : '—' },
                ]}
              />
              <AppendixTable
                title="热门产品"
                data={content.appendix.topProducts}
                columns={[
                  { key: 'name', label: '产品' },
                  { key: 'count', label: '询盘数' },
                ]}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
}
