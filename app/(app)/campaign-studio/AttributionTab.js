'use client';

import { useEffect, useState } from 'react';
import { createClient } from '../../../lib/supabase-browser';
import Markdown from '../../components/Markdown/Markdown';
import Skeleton, { SkeletonStack } from '../../components/Skeleton/Skeleton';
import s from './page.module.css';

/**
 * Attribution analysis tab — aggregates conversations per country / product
 * line for the current range, computes proof-rate trends vs. the prior period,
 * and offers a one-shot AI insight panel (cached in sessionStorage).
 */
export default function AttributionTab({ adsData, loading, daysFilter, metricsMap, range, selectedLine = 'all' }) {
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
            .select('meta_ad_id, agent_id, created_at, agents(product_line), leads(inquiry_quality, details)')
            .not('meta_ad_id', 'is', null)
            .gte('created_at', fromDate.toISOString())
            .lte('created_at', toDate.toISOString()),
          supabase
            .from('conversations')
            .select('meta_ad_id, agent_id, created_at, agents(product_line), leads(inquiry_quality, details)')
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
              const country = lead.details?.destination_country || '未知';
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

        // Previous period proofRate lookup by product line, for trend arrows.
        const prevProofRateByLine = {};
        for (const [line, bucket] of prevAgg.lineMap) {
          prevProofRateByLine[line] = bucket.conversations > 0
            ? Math.round((bucket.proofCount / bucket.conversations) * 100)
            : 0;
        }

        const sortedCountries = Array.from(currentAgg.countryMap.values())
          .sort((a, b) => b.conversationCount - a.conversationCount)
          .slice(0, 10);

        const maxConv = sortedCountries[0]?.conversationCount || 1;
        const withPct = sortedCountries.map((c) => {
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
          .map((line) => {
            let spend = null;
            if (metricsMap && metricsMap.size > 0) {
              spend = 0;
              for (const adId of line.adIds) {
                const m = metricsMap.get(adId);
                if (m) spend += m.spend;
              }
            }
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
            <button className={s.aiRegenBtn} onClick={fetchAIInsights}>✦ 重新生成</button>
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
          <SkeletonStack style={{ padding: '8px 0' }}>
            <Skeleton variant="card" height={40} />
            <Skeleton variant="card" height={40} />
            <Skeleton variant="card" height={40} />
          </SkeletonStack>
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
                  {productLineData.map((row) => {
                    const qualifyRate = row.conversations > 0
                      ? Math.round((row.qualifyCount / row.conversations) * 100)
                      : 0;
                    const proofRate = row.conversations > 0
                      ? Math.round((row.proofCount / row.conversations) * 100)
                      : 0;
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
          <SkeletonStack style={{ padding: '8px 0' }}>
            <Skeleton variant="card" height={40} />
            <Skeleton variant="card" height={40} />
            <Skeleton variant="card" height={40} />
          </SkeletonStack>
        ) : countryData.length === 0 ? (
          <div style={{ padding: '20px', color: 'var(--text3)', fontSize: '13px' }}>暂无国家数据</div>
        ) : (
          <div className={s.cpaList}>
            {countryData.map((row, i) => (
              <div key={i} className={s.cpaRow}>
                <div className={s.cpaCountry}>{row.country}</div>
                <div className={s.cpaTrack}>
                  <div className={s.cpaFill} style={{ width: `${row.pct}%`, background: row.color }} />
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
