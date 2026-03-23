'use client';

import { useState } from 'react';
import ReactMarkdown from 'react-markdown';

function Section({ title, children }) {
  return (
    <div className="mb-3">
      <div className="text-xs font-semibold text-gray-900 mb-1.5">{title}</div>
      {children}
    </div>
  );
}

function BulletList({ items }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="space-y-1">
      {items.map((item, i) => (
        <div key={i} className="flex gap-2 items-start text-[13px] text-gray-700">
          <span className="text-green-500 mt-0.5 text-[8px]">●</span>
          <span>{typeof item === 'string' ? item : (item.name || JSON.stringify(item))}</span>
        </div>
      ))}
    </div>
  );
}

function KeyValue({ label, value }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 text-[13px]">
      <span className="text-gray-500 shrink-0">{label}:</span>
      <span className="text-gray-700">{value}</span>
    </div>
  );
}

export default function ResearchCard({ report, duration }) {
  const [expanded, setExpanded] = useState(false);

  const isStructured = report && typeof report === 'object';

  // Extract recommendations as the primary bullets (matches actual agent output)
  const recommendations = isStructured
    ? (report.recommendations || report.key_findings || [])
    : [];

  // For string reports, extract bullet lines
  const stringBullets = !isStructured && typeof report === 'string'
    ? report.split('\n')
        .filter(l => l.trim().startsWith('-') || l.trim().startsWith('•'))
        .map(l => l.replace(/^[\s\-•]+/, '').trim())
        .slice(0, 5)
    : [];

  const bullets = recommendations.length > 0 ? recommendations : stringBullets;

  return (
    <div className="bg-white border border-green-200 rounded-xl overflow-hidden shadow-sm">
      {/* Header */}
      <div className="px-4 py-3 bg-green-50 flex items-center gap-2 border-b border-green-200">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="#16a34a" strokeWidth="1.5"/>
          <path d="M5.5 8l2 2 3-3" stroke="#16a34a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <span className="text-xs font-semibold text-green-900">市场调研完成</span>
        {duration && <span className="ml-auto text-[11px] text-gray-400">耗时 {duration}s</span>}
      </div>

      {/* Summary content */}
      <div className="px-4 py-3 text-[13px] text-gray-700 leading-relaxed">
        {bullets.length > 0 ? (
          <>
            <div className="font-semibold text-gray-900 mb-2">核心建议</div>
            <BulletList items={expanded ? bullets : bullets.slice(0, 3)} />
            {bullets.length > 3 && !expanded && (
              <button
                onClick={() => setExpanded(true)}
                className="text-xs text-green-600 mt-2 hover:underline"
              >
                展开全部 ({bullets.length} 条)
              </button>
            )}
          </>
        ) : (
          <div className="whitespace-pre-wrap">
            {typeof report === 'string' ? report : '调研完成'}
          </div>
        )}
      </div>

      {/* Footer with expand button */}
      {isStructured && (
        <div className="px-4 py-2.5 border-t border-green-200">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs bg-white border border-gray-200 text-gray-600 px-3.5 py-1.5 rounded-lg hover:bg-gray-50 font-medium"
          >
            {expanded ? '收起报告' : '查看完整报告'} →
          </button>
        </div>
      )}

      {/* Expanded structured report */}
      {expanded && isStructured && (
        <div className="px-4 py-3 border-t border-green-100 bg-green-50/30 space-y-3 text-[13px]">
          {/* Market Overview */}
          {report.market_overview && (
            <Section title="市场概览">
              <div className="space-y-1">
                <KeyValue label="市场规模" value={report.market_overview.market_size_estimate} />
                <KeyValue label="增长趋势" value={report.market_overview.growth_trend} />
                {report.market_overview.key_players?.length > 0 && (
                  <KeyValue label="主要玩家" value={report.market_overview.key_players.join('、')} />
                )}
                <BulletList items={report.market_overview.market_characteristics} />
              </div>
            </Section>
          )}

          {/* Competitor Ads */}
          {report.competitor_ads && (
            <Section title="竞品广告分析">
              {report.competitor_ads.summary && (
                <p className="text-gray-600 mb-1">{report.competitor_ads.summary}</p>
              )}
              {report.competitor_ads.gaps_and_opportunities?.length > 0 && (
                <BulletList items={report.competitor_ads.gaps_and_opportunities} />
              )}
            </Section>
          )}

          {/* Keyword Trends */}
          {report.keyword_trends && (
            <Section title="关键词趋势">
              {report.keyword_trends.high_volume_keywords?.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-1">
                  {report.keyword_trends.high_volume_keywords.map((kw, i) => (
                    <span key={i} className="px-2 py-0.5 bg-green-100 text-green-800 rounded text-[11px]">{kw}</span>
                  ))}
                </div>
              )}
              {report.keyword_trends.rising_keywords?.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {report.keyword_trends.rising_keywords.map((kw, i) => (
                    <span key={i} className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded text-[11px]">↑ {kw}</span>
                  ))}
                </div>
              )}
            </Section>
          )}

          {/* Platform Recommendations */}
          {report.platform_recommendations?.length > 0 && (
            <Section title="平台推荐">
              <div className="space-y-2">
                {report.platform_recommendations.map((p, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <span className="text-xs font-medium text-gray-800 w-24 shrink-0">{p.platform}</span>
                    <div className="flex-1 h-1.5 bg-green-100 rounded-full overflow-hidden">
                      <div className="h-full bg-green-500 rounded-full" style={{ width: `${p.fit_score}%` }} />
                    </div>
                    <span className="text-[11px] text-gray-500 w-8 text-right">{p.fit_score}</span>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* Benchmark Metrics */}
          {report.benchmark_metrics && (
            <Section title="基准指标">
              <div className="grid grid-cols-2 gap-2">
                <KeyValue label="CPM" value={report.benchmark_metrics.estimated_cpm} />
                <KeyValue label="CPC" value={report.benchmark_metrics.estimated_cpc} />
                <KeyValue label="CTR" value={report.benchmark_metrics.estimated_ctr} />
                <KeyValue label="CPL" value={report.benchmark_metrics.estimated_cpl} />
              </div>
            </Section>
          )}

          {/* Fallback: show raw data if no structured sections matched */}
          {!report.market_overview && !report.competitor_ads && !report.keyword_trends && !report.platform_recommendations && !report.benchmark_metrics && (
            <pre className="text-xs text-gray-600 whitespace-pre-wrap overflow-x-auto font-mono leading-relaxed">
              {JSON.stringify(report, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
