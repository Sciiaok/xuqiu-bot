'use client';

import { useState, useEffect, Suspense } from 'react';
import s from './page.module.css';
import MetricCard from '../../components/MetricCard/MetricCard';
import Card from '../../components/Card/Card';
import TabBar from '../../components/TabBar/TabBar';
import Tag from '../../components/Tag/Tag';
import PillBar from '../../components/PillBar/PillBar';
import { createClient } from '../../../lib/supabase-browser';
import {
  getAssessmentDetails,
  formatCurrency,
  formatCount,
  formatRangeLabel,
  getStatusLabel,
  buildRangeRequest,
} from './helpers';
import { ChatTab } from './ChatTab';
import Markdown from '../../components/Markdown/Markdown';

// ─── Tab definitions ──────────────────────────────────────────────
const MAIN_TABS = [
  { key: 'list', label: '📊 广告列表' },
  { key: 'ai', label: '✦ AI 自动化投放' },
  { key: 'attribution', label: '🎯 深度归因分析' },
];

const TIME_FILTER_ITEMS = [
  { key: '1d', label: '最近1天' },
  { key: '7d', label: '最近7天' },
  { key: '30d', label: '最近30天' },
  { key: 'all', label: '所有时间' },
  { key: 'custom', label: '自定义' },
];

const CLASSIFICATION_SOURCE_LABELS = {
  attribution: '归因业务线',
  attribution_conflict: '归因冲突',
  naming: '名称推断',
  unclassified: '未分类',
};

function ImageLightbox({ url, adId, onClose }) {
  const [hdUrl, setHdUrl] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!adId) return;
    setHdUrl(null);
    setLoading(true);
    fetch(`/api/ads/creative-image?adId=${encodeURIComponent(adId)}`)
      .then(res => res.ok ? res.json() : null)
      .then(data => { if (data?.imageUrl) setHdUrl(data.imageUrl); })
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


// ─── Spark Bars ──────────────────────────────────────────────────
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

// ─── Score Ring ──────────────────────────────────────────────────
function ScoreRing({ score, color }) {
  const r = 22;
  const circ = 2 * Math.PI * r;
  const dash = (score / 100) * circ;
  const colorMap = {
    green: 'var(--green)',
    amber: 'var(--amber)',
    accent: 'var(--accent)',
    red: 'var(--red)',
    teal: 'var(--teal)',
  };
  const strokeColor = colorMap[color] || 'var(--accent)';
  return (
    <svg className={s.scoreRing} width="56" height="56" viewBox="0 0 56 56">
      <circle cx="28" cy="28" r={r} fill="none" stroke="var(--border)" strokeWidth="4" />
      <circle
        cx="28" cy="28" r={r} fill="none"
        stroke={strokeColor} strokeWidth="4"
        strokeDasharray={`${dash} ${circ}`}
        strokeLinecap="round"
        transform="rotate(-90 28 28)"
      />
      <text x="28" y="33" textAnchor="middle" fontSize="13" fontWeight="700" fill={strokeColor} fontFamily="var(--font-mono)">
        {score}
      </text>
    </svg>
  );
}

// ─── Ad Row (aligned data) ──────────────────────────────────────
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
            <Tag variant={"low"}>{ad.businessLineLabel}</Tag>
            <span className={s.classificationTag}>{CLASSIFICATION_SOURCE_LABELS[ad.classificationSource] || '未分类'}</span>
          </div>
        </td>
        <td className={s.adNum}>{formatCurrency(period.spend)}</td>
        <td className={s.adNum}>{formatCount(period.impressions)}</td>
        <td className={s.adNum}>{period.ctr || 0}%</td>
        <td className={s.adNum}>{formatCount(period.waConversations)}</td>
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
                      <Tag variant={"low"}>{ad.businessLineLabel}</Tag>
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

                <div className={s.detailAI}>
                  <div className={s.aiEvalHead}>
                    <ScoreRing score={assessment.score} color={assessment.verdictColor} />
                    <div className={s.aiEvalText}>
                      <div className={s.aiEvalTitle}>AI 评估</div>
                      <div className={s.aiEvalBody}>
                        <strong>{assessment.verdict}</strong>
                        {`。全生命周期高质量率 ${lifetime.proofRate || 0}% ，${assessment.recentLabel}高质量率 ${assessment.recentProofRate}% 。`}
                        {assessment.recentCpa > 0 ? `近期 CPA 为 ${formatCurrency(assessment.recentCpa)}。` : ''}
                      </div>
                    </div>
                  </div>
                  <div className={s.assessmentGrid}>
                    <div className={s.assessmentBlock}>
                      <div className={s.assessmentTitle}>优点</div>
                      {(assessment.positives.length > 0 ? assessment.positives : ['当前广告暂未出现明显强项，建议继续观察近期转化质量。']).map((item) => (
                        <div key={item} className={s.assessmentItem}>{item}</div>
                      ))}
                    </div>
                    <div className={s.assessmentBlock}>
                      <div className={s.assessmentTitle}>问题</div>
                      {(assessment.risks.length > 0 ? assessment.risks : ['最近几天没有发现明显异常，广告表现与历史水平基本一致。']).map((item) => (
                        <div key={item} className={s.assessmentItem}>{item}</div>
                      ))}
                    </div>
                  </div>
                  <div className={s.assessmentActions}>
                    {assessment.suggestions.map((item) => (
                      <div key={item} className={s.assessmentAction}>{item}</div>
                    ))}
                  </div>
                </div>
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

function AdStatusGroup({ title, ads, defaultExpanded, rangeLabel, isSingleDay, onPreview }) {
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

// ─── List Tab ────────────────────────────────────────────────────
function ListTab({ dashboard, loading, rangeLabel, isSingleDay, onPreview }) {
  if (loading) {
    return (
      <div className={s.dayList} style={{ padding: '40px', textAlign: 'center', color: 'var(--text3)' }}>
        加载广告数据中…
      </div>
    );
  }

  const ads = dashboard?.ads || [];
  if (ads.length === 0) {
    return (
      <div className={s.dayList} style={{ padding: '40px', textAlign: 'center', color: 'var(--text3)' }}>
        当前筛选条件下暂无广告数据
      </div>
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

// ─── Attribution Tab ─────────────────────────────────────────────
function AttributionTab({ adsData, loading, daysFilter, metricsMap, range, selectedLine = 'all' }) {
  // Compute per-country conversation counts from joined conversation data
  const [countryData, setCountryData] = useState([]);
  const [productLineData, setProductLineData] = useState([]);
  const [loadingAttr, setLoadingAttr] = useState(true);
  const [attrReport, setAttrReport] = useState(() => {
    try { return sessionStorage.getItem('attrReport') || null; } catch { return null; }
  });
  const [attrLoading, setAttrLoading] = useState(false);

  const fetchAIInsights = async () => {
    setAttrLoading(true);
    try {
      const res = await fetch('/api/ai/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'attribution', days: daysFilter || 30 }),
      });
      if (!res.ok) throw new Error('Failed to fetch AI insights');
      const data = await res.json();
      const report = data.report || null;
      setAttrReport(report);
      try { if (report) sessionStorage.setItem('attrReport', report); else sessionStorage.removeItem('attrReport'); } catch {}
    } catch (err) {
      console.error('Error fetching AI insights:', err);
      setAttrReport(null);
    } finally {
      setAttrLoading(false);
    }
  };

  useEffect(() => {
    async function fetchAttributionData() {
      try {
        const supabase = createClient();
        setLoadingAttr(true);

        const toDate = range?.to ? new Date(range.to) : new Date();
        const fromDate = range?.from ? new Date(range.from) : new Date();
        if (!range?.from) {
          fromDate.setDate(fromDate.getDate() - (daysFilter || 30) + 1);
          fromDate.setHours(0, 0, 0, 0);
        }
        const prevTo = new Date(fromDate.getTime() - 1);
        const prevFrom = new Date(prevTo);
        prevFrom.setDate(prevFrom.getDate() - (daysFilter || 30) + 1);
        prevFrom.setHours(0, 0, 0, 0);

        const [currentRes, prevRes] = await Promise.all([
          supabase
            .from('conversations')
            .select('meta_ad_id, agent_id, created_at, agents(product_line), leads(inquiry_quality, destination_country)')
            .not('meta_ad_id', 'is', null)
            .gte('created_at', fromDate.toISOString())
            .lte('created_at', toDate.toISOString()),
          supabase
            .from('conversations')
            .select('meta_ad_id, agent_id, created_at, agents(product_line), leads(inquiry_quality, destination_country)')
            .not('meta_ad_id', 'is', null)
            .gte('created_at', prevFrom.toISOString())
            .lte('created_at', prevTo.toISOString()),
        ]);

        if (currentRes.error) throw currentRes.error;
        if (prevRes.error) throw prevRes.error;

        const currentConvs = selectedLine === 'all'
          ? (currentRes.data || [])
          : (currentRes.data || []).filter((conv) => conv.agents?.product_line === selectedLine);
        const prevConvs = selectedLine === 'all'
          ? (prevRes.data || [])
          : (prevRes.data || []).filter((conv) => conv.agents?.product_line === selectedLine);

        function aggregateConversations(convs) {
          const countryMap = new Map();
          const lineMap = new Map();

          for (const conv of convs || []) {
            const leadsArr = Array.isArray(conv.leads) ? conv.leads : (conv.leads ? [conv.leads] : []);
            const agentLine = conv.agents?.product_line || '其他';

            if (!lineMap.has(agentLine)) {
              lineMap.set(agentLine, { line: agentLine, conversations: 0, qualifyCount: 0, proofCount: 0, adIds: new Set() });
            }
            const lineBucket = lineMap.get(agentLine);
            lineBucket.conversations += 1;
            if (conv.meta_ad_id) lineBucket.adIds.add(String(conv.meta_ad_id));

            for (const lead of leadsArr) {
              const country = lead.destination_country || '未知';
              if (!countryMap.has(country)) {
                countryMap.set(country, { country, conversationCount: 0, qualifyCount: 0, proofCount: 0 });
              }
              const bucket = countryMap.get(country);
              bucket.conversationCount += 1;

              const quality = String(lead.inquiry_quality || '').toUpperCase();
              if (quality === 'QUALIFY') {
                bucket.qualifyCount += 1;
                lineBucket.qualifyCount += 1;
              }
              if (quality === 'PROOF') {
                bucket.proofCount += 1;
                lineBucket.proofCount += 1;
              }
            }
          }
          return { countryMap, lineMap };
        }

        const currentAgg = aggregateConversations(currentConvs);
        const prevAgg = aggregateConversations(prevConvs);

        // Build previous period proofRate lookup by product line
        const prevProofRateByLine = {};
        for (const [line, bucket] of prevAgg.lineMap) {
          prevProofRateByLine[line] = bucket.conversations > 0
            ? Math.round((bucket.proofCount / bucket.conversations) * 100)
            : 0;
        }

        // Sort countries by conversation count desc
        const sortedCountries = Array.from(currentAgg.countryMap.values())
          .sort((a, b) => b.conversationCount - a.conversationCount)
          .slice(0, 10);

        const maxConv = sortedCountries[0]?.conversationCount || 1;
        const withPct = sortedCountries.map(c => {
          const pct = Math.round((c.conversationCount / maxConv) * 100);
          const proofRate = c.conversationCount > 0
            ? Math.round((c.proofCount / c.conversationCount) * 100)
            : 0;
          let color = 'var(--red)';
          if (proofRate >= 60) color = 'var(--green)';
          else if (proofRate >= 30) color = 'var(--teal)';
          else if (proofRate >= 10) color = 'var(--amber)';
          return { ...c, pct, proofRate, color };
        });

        setCountryData(withPct);

        const sortedLines = Array.from(currentAgg.lineMap.values())
          .map(line => {
            let spend = null;
            if (metricsMap && metricsMap.size > 0) {
              spend = 0;
              for (const adId of line.adIds) {
                const m = metricsMap.get(adId);
                if (m) spend += m.spend;
              }
            }
            // Attach previous period proofRate for trend comparison
            const prevProofRate = prevProofRateByLine[line.line] ?? null;
            return { ...line, adIds: undefined, spend, prevProofRate };
          })
          .sort((a, b) => b.conversations - a.conversations);
        setProductLineData(sortedLines);
      } catch (err) {
        console.error('Error fetching attribution data:', err);
      } finally {
        setLoadingAttr(false);
      }
    }
    fetchAttributionData();
  }, [daysFilter, metricsMap, range, selectedLine]);

  return (
    <div className={s.attrRoot}>
      {/* AI strategic insights — manual trigger */}
      <section className={s.section}>
        <div className={s.sectionTitle}>核心战略洞察 · 执行建议</div>
        {attrLoading ? (
          <div className={s.aiPlaceholder}>
            <span className={s.aiSpinner} />
            AI 正在分析广告归因数据…
          </div>
        ) : attrReport ? (
          <div className={s.aiReportBody}>
            <Markdown>{attrReport}</Markdown>
            <button
              className={s.aiRegenBtn}
              onClick={fetchAIInsights}
            >
              ✦ 重新生成
            </button>
          </div>
        ) : (
          <div className={s.aiPlaceholder}>
            <span
              role="button"
              tabIndex={0}
              className={s.aiTriggerLink}
              onClick={fetchAIInsights}
            >
              点击生成 AI 分析 →
            </span>
          </div>
        )}
      </section>

      {/* Product line comparison */}
      <section className={s.section}>
        <div className={s.sectionTitle}>业务线对比</div>
        {loadingAttr ? (
          <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>加载中…</div>
        ) : productLineData.length === 0 ? (
          <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>暂无业务线数据</div>
        ) : (
          <>
            <div className={s.bizTableWrap}>
              <table className={s.bizTable}>
                <thead>
                  <tr>
                    <th>业务线</th>
                    <th>花费</th>
                    <th>WA 对话</th>
                    <th>中质量率</th>
                    <th>高质量率</th>
                    <th>趋势</th>
                  </tr>
                </thead>
                <tbody>
                  {productLineData.map(row => {
                    const qualifyRate = row.conversations > 0
                      ? Math.round((row.qualifyCount / row.conversations) * 100)
                      : 0;
                    const proofRate = row.conversations > 0
                      ? Math.round((row.proofCount / row.conversations) * 100)
                      : 0;
                    // Fix #8: Compare current proofRate with previous period
                    const prevRate = row.prevProofRate;
                    let trendEl;
                    if (prevRate == null) {
                      trendEl = <span className={s.trendNeutral}>—</span>;
                    } else if (proofRate > prevRate) {
                      trendEl = <span className={s.trendUp}>↑ +{proofRate - prevRate}%</span>;
                    } else if (proofRate < prevRate) {
                      trendEl = <span className={s.trendDown}>↓ {proofRate - prevRate}%</span>;
                    } else {
                      trendEl = <span className={s.trendNeutral}>→ 持平</span>;
                    }
                    return (
                      <tr key={row.line}>
                        <td className={s.bizLineName}>{row.line || '其他'}</td>
                        <td>{row.spend != null ? `$${row.spend.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}</td>
                        <td>{row.conversations.toLocaleString()}</td>
                        <td><span className={s.roasVal}>{qualifyRate}%</span></td>
                        <td><span className={s.roasVal}>{proofRate}%</span></td>
                        <td>{trendEl}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {productLineData.length > 0 && (() => {
              const bestProofLine = productLineData.reduce((best, row) => {
                const rate = row.conversations > 0 ? row.proofCount / row.conversations : 0;
                const bestRate = best.conversations > 0 ? best.proofCount / best.conversations : 0;
                return rate > bestRate ? row : best;
              }, productLineData[0]);
              const bestConvLine = productLineData.reduce((best, row) =>
                row.conversations > best.conversations ? row : best, productLineData[0]);
              const bestQualLine = productLineData.reduce((best, row) => {
                const rate = row.conversations > 0 ? row.qualifyCount / row.conversations : 0;
                const bestRate = best.conversations > 0 ? best.qualifyCount / best.conversations : 0;
                return rate > bestRate ? row : best;
              }, productLineData[0]);

              return (
                <div className={s.bizCompGrid}>
                  <div className={s.bizCompCell}>
                    <div className={s.bizCompLabel}>最高高质量率</div>
                    <div className={s.bizCompValue} style={{ color: 'var(--green)' }}>
                      {bestProofLine.line} {bestProofLine.conversations > 0
                        ? Math.round((bestProofLine.proofCount / bestProofLine.conversations) * 100)
                        : 0}%
                    </div>
                  </div>
                  <div className={s.bizCompCell}>
                    <div className={s.bizCompLabel}>最多对话</div>
                    <div className={s.bizCompValue} style={{ color: 'var(--accent)' }}>
                      {bestConvLine.line} {bestConvLine.conversations.toLocaleString()}
                    </div>
                  </div>
                  <div className={s.bizCompCell}>
                    <div className={s.bizCompLabel}>最高中质量率</div>
                    <div className={s.bizCompValue} style={{ color: 'var(--purple)' }}>
                      {bestQualLine.line} {bestQualLine.conversations > 0
                        ? Math.round((bestQualLine.qualifyCount / bestQualLine.conversations) * 100)
                        : 0}%
                    </div>
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </section>

      {/* Country conversation ranking */}
      <section className={s.section}>
        <div className={s.sectionTitle}>国家对话排行</div>
        {loadingAttr ? (
          <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>加载中…</div>
        ) : countryData.length === 0 ? (
          <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>暂无国家数据</div>
        ) : (
          <div className={s.cpaList}>
            {countryData.map((row, i) => (
              <div key={i} className={s.cpaRow}>
                <div className={s.cpaCountry}>{row.country}</div>
                <div className={s.cpaTrack}>
                  <div
                    className={s.cpaFill}
                    style={{ width: `${row.pct}%`, background: row.color }}
                  />
                </div>
                <div className={s.cpaValue}>
                  {row.conversationCount.toLocaleString()} 对话 · PROOF {row.proofRate}%
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

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
        {tab === 'ai' && <Suspense><ChatTab workspaceMode={workspaceMode} /></Suspense>}
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
