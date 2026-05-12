'use client';

import { useEffect, useState } from 'react';
import Tag from '../../components/Tag/Tag';
import Markdown from '../../components/Markdown/Markdown';
import { formatCount, formatCurrency, getAssessmentDetails, getStatusLabel } from './helpers';
import s from './page.module.css';

// LLM cost is real — we only call the model when the user clicks a button
// inside an ad card. Results are cached in sessionStorage by adId so toggling
// the card open/closed doesn't re-spend.
function readAdReportCache(adId) {
  try { return sessionStorage.getItem(`adReport:${adId}`) || null; } catch { return null; }
}
function writeAdReportCache(adId, report) {
  try {
    if (report) sessionStorage.setItem(`adReport:${adId}`, report);
    else sessionStorage.removeItem(`adReport:${adId}`);
  } catch {}
}

function AiAssessmentPanel({ ad, assessment }) {
  const [report, setReport] = useState(() => readAdReportCache(ad.adId));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function generate() {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/ai/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'campaign_analysis',
          days: 30,
          context: {
            focusAdId: ad.adId,
            adName: ad.adName,
            adsetName: ad.adsetName,
            campaignName: ad.campaignName,
            businessLine: ad.businessLine,
            status: ad.status,
            lifetime: ad.lifetime,
            period: ad.period,
            ruleBasedAssessment: {
              verdict: assessment.verdict,
              positives: assessment.positives,
              risks: assessment.risks,
              suggestions: assessment.suggestions,
            },
          },
        }),
      });
      if (!res.ok) throw new Error('生成失败');
      const data = await res.json();
      const text = data.report || '';
      setReport(text);
      writeAdReportCache(ad.adId, text);
    } catch (err) {
      setError(err.message || '生成失败');
    } finally {
      setLoading(false);
    }
  }

  if (report) {
    return (
      <div className={s.detailAI}>
        <div className={s.aiEvalHead}>
          <div className={s.aiEvalText}>
            <div className={s.aiEvalTitle}>AI 深度分析</div>
          </div>
          <button type="button" className={s.aiRegenBtn} onClick={generate} disabled={loading}>
            ✦ 重新生成
          </button>
        </div>
        <div className={s.aiReportBody}>
          <Markdown>{report}</Markdown>
        </div>
      </div>
    );
  }

  return (
    <div className={s.detailAI}>
      <div className={s.aiEvalHead}>
        <div className={s.aiEvalText}>
          <div className={s.aiEvalTitle}>AI 深度分析</div>
          <div className={s.aiEvalBody}>
            点击下方按钮，由 AI 基于这条广告的投放数据 + 转化质量生成针对性分析与建议。
            不会自动调用，避免不必要的开销。
          </div>
        </div>
      </div>
      <div className={s.aiTriggerWrap} onClick={(e) => e.stopPropagation()}>
        <button type="button" className={s.aiTriggerBtn} onClick={generate} disabled={loading}>
          {loading ? <><span className={s.aiSpinner} /> AI 正在分析…</> : '✦ 生成 AI 分析'}
        </button>
        {error && <span className={s.aiTriggerError}>{error}</span>}
      </div>
    </div>
  );
}

const CLASSIFICATION_SOURCE_LABELS = {
  attribution: '归因业务线',
  attribution_conflict: '归因冲突',
  naming: '名称推断',
  unclassified: '未分类',
};

// ── Small visual atoms used only inside the AdRow tree ────────────────

export function ImageLightbox({ url, adId, onClose }) {
  const [hdUrl, setHdUrl] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!adId) return;
    setHdUrl(null);
    setLoading(true);
    fetch(`/api/ads/creative-image?adId=${encodeURIComponent(adId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { if (data?.imageUrl) setHdUrl(data.imageUrl); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [adId]);

  if (!url) return null;
  const displayUrl = hdUrl || url;

  return (
    <div className={s.lightboxOverlay} onClick={onClose}>
      {loading && <div className={s.lightboxLoading}>加载高清图…</div>}
      <img src={displayUrl} alt="" className={s.lightboxImage} onClick={(event) => event.stopPropagation()} />
    </div>
  );
}

function SparkBars({ data, color = 'var(--accent)' }) {
  const max = Math.max(...data, 1);
  return (
    <div className={s.spark}>
      {data.map((v, i) => (
        <div
          key={i}
          className={s.sparkBar}
          style={{ height: `${Math.round((v / max) * 20)}px`, background: color }}
        />
      ))}
    </div>
  );
}


// ── AdRow + AdStatusGroup ─────────────────────────────────────────────

function AdRow({ ad, isExpanded, onToggle, rangeLabel, isSingleDay, onPreview }) {
  const period = ad.period || {};
  const lifetime = ad.lifetime || {};
  const trendData = (period.daily || []).slice(-7).map((item) => item.waConversations || 0);
  const hasTrendData = trendData.some((value) => value > 0);
  const assessment = getAssessmentDetails(ad);
  const previewUrl = ad.creativePreviewUrl || ad.creativeThumbnailUrl || '';
  const previewLightboxUrl = ad.creativePreviewPermalinkUrl || previewUrl;
  const previewSizeLabel = ad.creativePreviewWidth && ad.creativePreviewHeight
    ? `${ad.creativePreviewWidth} × ${ad.creativePreviewHeight}`
    : null;
  const originalSizeLabel = ad.creativeOriginalWidth && ad.creativeOriginalHeight
    ? `${ad.creativeOriginalWidth} × ${ad.creativeOriginalHeight}`
    : null;
  const verdictClass = {
    green: s.verdictGreen,
    amber: s.verdictAmber,
    accent: s.verdictAccent,
    teal: s.verdictTeal,
    red: s.verdictRed,
  }[assessment.verdictColor] || '';

  return (
    <>
      <tr className={`${s.adRow} ${isExpanded ? s.adRowExpanded : ''}`} onClick={onToggle}>
        <td className={s.adThumb}>
          <span className={`${s.stateDot} ${ad.status === 'active' ? s.stateDotActive : s.stateDotEnded}`} />
        </td>
        <td className={s.adName}>
          <div className={s.adNameMain}>{ad.adName || '未命名广告'}</div>
          <div className={s.adMeta}>
            <span>{ad.adId}</span>
            <span>·</span>
            <span>{ad.adsetName || '未命名广告组'}</span>
          </div>
          <div className={s.adTagRow}>
            <Tag variant={'low'}>{ad.businessLineLabel}</Tag>
            <span className={s.classificationTag}>{CLASSIFICATION_SOURCE_LABELS[ad.classificationSource] || '未分类'}</span>
          </div>
        </td>
        <td className={s.adNum}>{formatCurrency(period.spend)}</td>
        <td className={s.adNum}>{formatCount(period.impressions)}</td>
        <td className={s.adNum}>{period.ctr || 0}%</td>
        <td className={s.adNum}>
          {period.waConversations > 0 && ad.adId ? (
            <a
              href={`/leadhub?metaAdId=${encodeURIComponent(ad.adId)}`}
              className={s.adConvLink}
              onClick={(e) => e.stopPropagation()}
              title="查看该广告带来的对话"
            >
              {formatCount(period.waConversations)}
            </a>
          ) : (
            formatCount(period.waConversations)
          )}
        </td>
        <td className={s.adNum}>{formatCurrency(period.cpa)}</td>
        <td className={s.adNum}>
          <span className={s.proofBadge}>{period.proofRate || 0}%</span>
        </td>
        <td className={s.adSparkCell}>
          {hasTrendData
            ? <SparkBars data={trendData} color="var(--accent)" />
            : <span style={{ color: 'var(--text3)', fontSize: '11px' }}>—</span>}
        </td>
        <td className={s.adArrowCell}>
          <span className={`${s.arrow} ${isExpanded ? s.arrowOpen : ''}`}>›</span>
        </td>
      </tr>

      {isExpanded && (
        <tr className={s.adDetailRow}>
          <td colSpan={10}>
            <div className={s.adDetail}>
              <div className={s.detailHero}>
                <div className={s.detailCreative}>
                  <div className={s.detailIdentity}>
                    <div className={s.detailTitleRow}>
                      <strong>{ad.adName || ad.adId}</strong>
                      <Tag variant={ad.status === 'active' ? 'qualify' : 'low'}>{getStatusLabel(ad.status)}</Tag>
                      <Tag variant={'low'}>{ad.businessLineLabel}</Tag>
                    </div>
                    <div className={s.detailMetaList}>
                      <span>广告 ID：{ad.adId}</span>
                      <span>广告组：{ad.adsetName || '未命名'}</span>
                      <span>广告系列：{ad.campaignName || '未命名'}</span>
                      <span>分类来源：{CLASSIFICATION_SOURCE_LABELS[ad.classificationSource] || '未分类'}</span>
                    </div>
                  </div>
                  <div className={s.creativePreviewCard}>
                    <div className={s.creativePreviewHead}>
                      <div className={s.detailPanelTitle}>素材预览</div>
                      <span className={`${s.verdictBadge} ${verdictClass}`}>{assessment.verdict}</span>
                    </div>
                    {previewUrl ? (
                      <button
                        type="button"
                        className={s.creativePreviewButton}
                        onClick={(event) => {
                          event.stopPropagation();
                          onPreview?.({ url: previewLightboxUrl, adId: ad.adId });
                        }}
                      >
                        <img src={previewUrl} alt={ad.adName || ad.adId} className={s.creativePreviewImage} />
                        <div className={s.creativePreviewMeta}>
                          <span>{previewSizeLabel ? `预览图 ${previewSizeLabel}` : '广告素材图'}</span>
                          {originalSizeLabel && <span>原图 {originalSizeLabel}</span>}
                        </div>
                      </button>
                    ) : (
                      <div className={s.creativePlaceholder}>
                        <span className={s.creativeEmoji}>🖼</span>
                        <span className={s.creativeLabel}>暂无素材图</span>
                      </div>
                    )}
                  </div>
                </div>

                <AiAssessmentPanel ad={ad} assessment={assessment} />
              </div>

              <div className={s.detailStatsGrid}>
                <div className={s.detailPanel}>
                  <div className={s.detailPanelTitle}>生命周期累计</div>
                  <div className={s.metricsGrid}>
                    {[
                      ['总花费', formatCurrency(lifetime.spend)],
                      ['总展现', formatCount(lifetime.impressions)],
                      ['总 CTR', `${lifetime.ctr || 0}%`],
                      ['WA 对话', formatCount(lifetime.waConversations)],
                      ['中质量对话', formatCount(lifetime.qualifyConversations)],
                      ['高质量对话', formatCount(lifetime.proofConversations)],
                      ['中质量率', `${lifetime.qualifyRate || 0}%`],
                      ['高质量率', `${lifetime.proofRate || 0}%`],
                      ['总 CPA', formatCurrency(lifetime.cpa)],
                      ['最近对话', lifetime.lastConversationAt ? lifetime.lastConversationAt.slice(0, 10) : '—'],
                    ].map(([label, val]) => (
                      <div key={label} className={s.metricBox}>
                        <div className={s.metricBoxLabel}>{label}</div>
                        <div className={s.metricBoxValue}>{val}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className={s.detailPanel}>
                  <div className={s.detailPanelTitle}>{rangeLabel} 数据</div>
                  <div className={s.metricsGrid}>
                    {[
                      ['范围花费', formatCurrency(period.spend)],
                      ['范围展现', formatCount(period.impressions)],
                      ['范围 CTR', `${period.ctr || 0}%`],
                      ['范围 WA 对话', formatCount(period.waConversations)],
                      ['范围中质量', formatCount(period.qualifyConversations)],
                      ['范围高质量', formatCount(period.proofConversations)],
                      ['范围中质量率', `${period.qualifyRate || 0}%`],
                      ['范围高质量率', `${period.proofRate || 0}%`],
                      ['范围 CPA', formatCurrency(period.cpa)],
                      ['状态', getStatusLabel(ad.status)],
                    ].map(([label, val]) => (
                      <div key={label} className={s.metricBox}>
                        <div className={s.metricBoxLabel}>{label}</div>
                        <div className={s.metricBoxValue}>{val}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {!isSingleDay && (
                <div className={s.detailTrend}>
                  <div className={s.detailPanelTitle}>{rangeLabel} 趋势</div>
                  <div className={s.dailyTableWrap}>
                    <table className={s.dailyTable}>
                      <thead>
                        <tr>
                          <th>日期</th>
                          <th>花费</th>
                          <th>展现</th>
                          <th>对话</th>
                          <th>中质量</th>
                          <th>高质量</th>
                          <th>CPA</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(period.daily || []).map((item) => (
                          <tr key={item.date}>
                            <td>{item.date}</td>
                            <td>{formatCurrency(item.spend)}</td>
                            <td>{formatCount(item.impressions)}</td>
                            <td>{formatCount(item.waConversations)}</td>
                            <td>{formatCount(item.qualifyConversations)}</td>
                            <td>{formatCount(item.proofConversations)}</td>
                            <td>{formatCurrency(item.cpa)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function AdStatusGroup({ title, ads, defaultExpanded, rangeLabel, isSingleDay, onPreview }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [expandedAd, setExpandedAd] = useState(ads[0]?.adId || null);

  useEffect(() => {
    if (defaultExpanded && ads.length > 0 && !expandedAd) {
      setExpandedAd(ads[0].adId);
    }
  }, [ads, defaultExpanded, expandedAd]);

  const summary = ads.reduce((acc, ad) => {
    acc.count += 1;
    acc.spend += ad.period?.spend || 0;
    acc.wa += ad.period?.waConversations || 0;
    acc.proof += ad.period?.proofConversations || 0;
    return acc;
  }, { count: 0, spend: 0, wa: 0, proof: 0 });

  return (
    <div className={`${s.groupCard} ${expanded ? s.groupCardOpen : ''}`}>
      <div className={s.groupHeader} onClick={() => setExpanded((value) => !value)}>
        <div className={s.groupLeft}>
          <span className={`${s.arrow} ${expanded ? s.arrowOpen : ''}`}>›</span>
          <span className={s.groupTitle}>{title}</span>
          <span className={s.groupCount}>{summary.count} 个广告</span>
        </div>
        <div className={s.groupMetrics}>
          <span className={s.dayMetric}><span className={s.dayMetricLabel}>{rangeLabel} 花费</span>{formatCurrency(summary.spend)}</span>
          <span className={s.dayMetric}><span className={s.dayMetricLabel}>{rangeLabel} 对话</span>{formatCount(summary.wa)}</span>
          <span className={s.dayMetric}><span className={s.dayMetricLabel}>{rangeLabel} 高质量</span>{formatCount(summary.proof)}</span>
        </div>
      </div>

      {expanded && (
        <div className={s.dayBody}>
          <div className={s.adTableWrap}>
            <table className={s.adTable}>
              <thead>
                <tr>
                  <th></th>
                  <th className={s.thName}>广告信息</th>
                  <th className={s.thNum}>花费</th>
                  <th className={s.thNum}>展示</th>
                  <th className={s.thNum}>CTR</th>
                  <th className={s.thNum}>对话</th>
                  <th className={s.thNum}>CPA</th>
                  <th className={s.thNum}>高质量率</th>
                  <th className={s.thNum}>趋势</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {ads.map((ad) => (
                  <AdRow
                    key={ad.adId}
                    ad={ad}
                    isExpanded={expandedAd === ad.adId}
                    onToggle={() => setExpandedAd((current) => current === ad.adId ? null : ad.adId)}
                    rangeLabel={rangeLabel}
                    isSingleDay={isSingleDay}
                    onPreview={onPreview}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
