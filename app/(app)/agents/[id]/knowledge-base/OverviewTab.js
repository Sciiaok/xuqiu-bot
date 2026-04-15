'use client';

import { useEffect, useState } from 'react';
import s from './page.module.css';
import { getHealth, listGaps, updateGap } from '../../../../../lib/api/knowledge.js';
import { LAYERS, LAYER_LABELS } from './constants.js';

const GAP_LIST_LIMIT = 20;

export default function OverviewTab({ agentId }) {
  const [health, setHealth] = useState(null);
  const [gaps, setGaps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!agentId) return;
    setLoading(true);
    setError('');
    Promise.all([
      getHealth(agentId),
      listGaps(agentId),
    ])
      .then(([healthData, gapsData]) => {
        setHealth(healthData);
        setGaps(gapsData);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) {
    return <div className={s.loadingWrap}><span className={s.spinner} /></div>;
  }

  if (error) {
    return <div className={s.emptyState}>加载失败：{error}</div>;
  }

  if (!health) {
    return <div className={s.emptyState}>暂无数据</div>;
  }

  const statusClass = (st) => st === 'good' ? s.layerGood : st === 'warn' ? s.layerWarn : s.layerError;
  const barClass = (st) => st === 'good' ? s.layerBarGood : st === 'warn' ? s.layerBarWarn : s.layerBarError;

  return (
    <>
      {/* Metrics Row */}
      <div className={s.metricsRow}>
        <div className={s.metricCard}>
          <div className={s.metricLabel}>总覆盖率</div>
          <div className={s.metricValue}>{health.overall_coverage}%</div>
        </div>
        <div className={`${s.metricCard} ${s.metricGreen}`}>
          <div className={s.metricLabel}>知识点</div>
          <div className={s.metricValue}>{health.total_knowledge_points}</div>
        </div>
        <div className={`${s.metricCard} ${s.metricAmber}`}>
          <div className={s.metricLabel}>文档数</div>
          <div className={s.metricValue}>{health.total_documents}</div>
        </div>
        <div className={`${s.metricCard} ${s.metricPurple}`}>
          <div className={s.metricLabel}>产品</div>
          <div className={s.metricValue}>{health.total_products}</div>
        </div>
        <div className={s.metricCard}>
          <div className={s.metricLabel}>定价规则</div>
          <div className={s.metricValue}>{health.total_pricing_rules}</div>
        </div>
        <div className={`${s.metricCard} ${s.metricRed}`}>
          <div className={s.metricLabel}>待审核草稿</div>
          <div className={s.metricValue}>{health.pending_drafts}</div>
        </div>
      </div>

      {/* Layer Cards */}
      <div className={s.sectionTitle}>六层知识覆盖</div>
      <div className={s.layerGrid}>
        {LAYERS.map(layer => {
          const data = health.layers?.[layer];
          if (!data) return null;
          return (
            <div key={layer} className={s.layerCard}>
              <div className={s.layerHead}>
                <span className={s.layerName}>{data.label}</span>
                <span className={`${s.layerStatus} ${statusClass(data.status)}`}>
                  {data.status === 'good' ? '良好' : data.status === 'warn' ? '不足' : '缺失'}
                </span>
              </div>
              <div className={s.layerBar}>
                <div
                  className={`${s.layerBarFill} ${barClass(data.status)}`}
                  style={{ width: `${data.coverage}%` }}
                />
              </div>
              <div className={s.layerMeta}>
                <span>{data.docs} 文档</span>
                <span>{data.points} 知识点</span>
                <span>{data.coverage}% 覆盖</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* AI Recommendations */}
      {health.ai_recommendations?.length > 0 && (
        <>
          <div className={s.sectionTitle}>AI 建议</div>
          <div className={s.recList}>
            {health.ai_recommendations.map((rec, i) => (
              <div key={i} className={s.recItem}>
                <span className={`${s.recPriority} ${rec.priority === 'high' ? s.recHigh : rec.priority === 'medium' ? s.recMedium : s.recLow}`}>
                  {rec.priority === 'high' ? '高' : rec.priority === 'medium' ? '中' : '低'}
                </span>
                <div className={s.recBody}>
                  <div className={s.recAction}>{rec.action}</div>
                  <div className={s.recImpact}>{rec.impact}</div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Knowledge Gaps */}
      {gaps.length > 0 && (
        <>
          <div className={s.sectionTitle}>知识盲区 ({gaps.length})</div>
          <GapList
            gaps={gaps}
            onUpdate={(id) => setGaps(prev => prev.filter(g => g.id !== id))}
          />
        </>
      )}

      {/* Outdated Docs */}
      {health.outdated_docs?.length > 0 && (
        <>
          <div className={s.sectionTitle}>过期文档</div>
          <div className={s.docList}>
            {health.outdated_docs.map(doc => (
              <div key={doc.doc_id} className={s.docItem}>
                <span className={s.docName}>{doc.filename}</span>
                <span className={s.docLayer}>{LAYER_LABELS[doc.layer] || doc.layer}</span>
                <span className={s.docPoints}>{doc.days_since_update} 天未更新</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function GapList({ gaps, onUpdate }) {
  const handleAction = async (gapId, status) => {
    try {
      await updateGap(gapId, status);
      onUpdate(gapId);
    } catch (err) {
      console.error('[gap] update failed', err);
    }
  };

  return (
    <div className={s.gapList}>
      {gaps.slice(0, GAP_LIST_LIMIT).map(gap => (
        <div key={gap.id} className={s.gapItem}>
          <span className={s.gapQuery}>{gap.query}</span>
          <span className={s.gapType}>{gap.gap_type}</span>
          <span className={s.gapCount}>{gap.occurrence_count}x</span>
          <div className={s.gapActions}>
            <button className={s.gapBtn} onClick={() => handleAction(gap.id, 'ignored')}>忽略</button>
          </div>
        </div>
      ))}
    </div>
  );
}
