'use client';

import { useState } from 'react';
import s from './PhaseCards.module.css';

// ── Shared helpers ────────────────────────────────────────────────

function Bullet({ items: raw, color = 'green' }) {
  const items = Array.isArray(raw) ? raw : raw ? [raw] : [];
  if (!items.length) return null;
  return (
    <div className={s.bulletList}>
      {items.map((item, i) => (
        <div key={i} className={s.bulletItem}>
          <span className={`${s.bulletDot} ${s[`dot_${color}`]}`} />
          <span>{typeof item === 'string' ? item : (item.name || JSON.stringify(item))}</span>
        </div>
      ))}
    </div>
  );
}

function KV({ label, value }) {
  if (!value) return null;
  return (
    <div className={s.kv}>
      <span className={s.kvLabel}>{label}:</span>
      <span className={s.kvValue}>{value}</span>
    </div>
  );
}

const COLOR_MAP = {
  green: { bg: 'rgba(42, 140, 90, 0.10)', border: 'rgba(42, 140, 90, 0.3)', text: '#2a8c5a' },
};

function CardShell({ icon, title, badge, children, footer }) {
  const c = COLOR_MAP.green;
  return (
    <div style={{ borderRadius: 12, border: `1px solid ${c.border}`, background: '#f6f1ea', boxShadow: '0 1px 6px rgba(80,50,20,0.08)', marginBottom: 4, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderBottom: `1px solid ${c.border}`, fontSize: 12, fontWeight: 600, background: c.bg, color: c.text }}>
        <span>{icon}</span>
        <span style={{ flex: 1 }}>{title}</span>
        {badge && <span style={{ fontWeight: 400, fontSize: 11, opacity: 0.7 }}>{badge}</span>}
      </div>
      <div style={{ padding: '12px 14px' }}>{children}</div>
      {footer && <div style={{ padding: '8px 14px', borderTop: `1px solid ${c.border}` }}>{footer}</div>}
    </div>
  );
}

// ── Section definitions ───────────────────────────────────────────

const SECTIONS = [
  { key: 'market_competitor_analysis', num: '1', title: '市场与竞品分析', titleEn: 'Market & Competitor Analysis' },
  { key: 'campaign_objectives',       num: '2', title: '投放目标设定',   titleEn: 'Campaign Objectives' },
  { key: 'audience_segmentation',     num: '3', title: '用户画像与受众分层', titleEn: 'Audience Segmentation' },
  { key: 'creative_strategy',        num: '4', title: '素材创意策略',   titleEn: 'Creative Strategy' },
  { key: 'media_mix',                num: '5', title: '渠道与漏斗布局', titleEn: 'Media Mix & Funnel Strategy' },
  { key: 'landing_page_cro',         num: '6', title: '落地页与转化链路', titleEn: 'Landing Page & CRO' },
  { key: 'budget_scheduling',        num: '7', title: '预算与排期分配', titleEn: 'Budget Allocation & Scheduling' },
  { key: 'optimization_reporting',   num: '8', title: '效果评估与迭代闭环', titleEn: 'Optimization & Reporting' },
  { key: 'keyword_trends',           num: '9', title: '关键词趋势分析',   titleEn: 'Keyword Trends Analysis' },
];

function SectionHeader({ num, title, titleEn }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, marginTop: 14 }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20, borderRadius: '50%',
        background: 'rgba(42, 140, 90, 0.12)', color: '#2a8c5a',
        fontSize: 10, fontWeight: 700, flexShrink: 0,
      }}>{num}</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{title}</span>
      <span style={{ fontSize: 10, color: 'var(--text3)' }}>{titleEn}</span>
    </div>
  );
}

// ── Per-section renderers ─────────────────────────────────────────

function renderSection(key, data) {
  if (!data) return <div style={{ fontSize: 11, color: 'var(--text3)' }}>暂无数据</div>;

  switch (key) {
    case 'market_competitor_analysis':
      return (
        <>
          {data.market_insights && <p className={s.sectionText}>{data.market_insights}</p>}
          {data.regulations?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className={s.tagRow}>
                {data.regulations.map((r, i) => <span key={i} className={`${s.tag} ${s.tag_amber}`}>{r}</span>)}
              </div>
            </div>
          )}
          {data.competitor_summary && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', marginBottom: 4 }}>竞品分析</div>
              <p className={s.sectionText}>{data.competitor_summary}</p>
            </div>
          )}
          {data.competitor_creative_formats?.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <div className={s.tagRow}>
                {data.competitor_creative_formats.map((f, i) => <span key={i} className={`${s.tag} ${s.tag_green}`}>{f}</span>)}
              </div>
            </div>
          )}
          <Bullet items={data.gaps_and_opportunities} color="green" />
        </>
      );

    case 'campaign_objectives':
      return (
        <>
          <KV label="核心 KPI" value={data.primary_kpi} />
          {data.secondary_kpis?.length > 0 && (
            <div className={s.tagRow} style={{ marginTop: 4 }}>
              {data.secondary_kpis.map((k, i) => <span key={i} className={`${s.tag} ${s.tag_green}`}>{k}</span>)}
            </div>
          )}
          {data.phases?.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {data.phases.map((p, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11, color: 'var(--text2)', marginBottom: 3 }}>
                  <span style={{ fontWeight: 600, color: 'var(--text)', minWidth: 50 }}>{p.name}</span>
                  <span style={{ color: 'var(--text3)' }}>{p.duration}</span>
                  <span>{p.goal}</span>
                </div>
              ))}
            </div>
          )}
        </>
      );

    case 'audience_segmentation':
      return (
        <>
          {data.core_audiences?.map((aud, i) => (
            <div key={i} style={{ marginBottom: 8, padding: '6px 8px', background: 'var(--bg3)', borderRadius: 'var(--r)', border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)' }}>{aud.name}</div>
              {aud.description && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 2 }}>{aud.description}</div>}
              {aud.demographics && <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>{aud.demographics}</div>}
              {aud.interests?.length > 0 && (
                <div className={s.tagRow} style={{ marginTop: 4 }}>
                  {aud.interests.map((t, j) => <span key={j} className={`${s.tag} ${s.tag_green}`}>{t}</span>)}
                </div>
              )}
            </div>
          ))}
          {data.retargeting_strategies?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', marginBottom: 4 }}>再营销策略</div>
              {data.retargeting_strategies.map((r, i) => (
                <div key={i} style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 2 }}>
                  <span style={{ fontWeight: 500 }}>{r.segment}:</span> {r.strategy}
                </div>
              ))}
            </div>
          )}
          {data.content_preferences?.length > 0 && (
            <div className={s.tagRow} style={{ marginTop: 6 }}>
              {data.content_preferences.map((p, i) => <span key={i} className={`${s.tag} ${s.tag_amber}`}>{p}</span>)}
            </div>
          )}
        </>
      );

    case 'creative_strategy':
      return (
        <>
          {data.creative_matrix?.map((cm, i) => (
            <div key={i} style={{ marginBottom: 6, padding: '6px 8px', background: 'var(--bg3)', borderRadius: 'var(--r)', border: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className={`${s.tag} ${s.tag_purple}`}>{cm.format}</span>
                <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--text)' }}>{cm.concept}</span>
              </div>
              {cm.pain_point && <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 2 }}>痛点: {cm.pain_point}</div>}
              {cm.cta && <div style={{ fontSize: 10, color: 'var(--accent)', marginTop: 2 }}>CTA: {cm.cta}</div>}
            </div>
          ))}
          {data.localization_notes?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', marginBottom: 4 }}>本地化要点</div>
              <Bullet items={data.localization_notes} color="amber" />
            </div>
          )}
          {data.hook_scripts?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', marginBottom: 4 }}>Hook 脚本</div>
              <Bullet items={data.hook_scripts} color="green" />
            </div>
          )}
        </>
      );

    case 'media_mix':
      return (
        <>
          {data.channels?.map((ch, i) => (
            <div key={i} className={s.barRow}>
              <span className={s.barLabel}>{ch.platform}</span>
              <div className={s.barTrack}>
                <div className={`${s.barFill} ${s.barFill_green}`} style={{ width: `${ch.fit_score || 0}%` }} />
              </div>
              <span className={s.barValue}>{ch.fit_score}</span>
              {ch.funnel_role && <span style={{ fontSize: 10, color: 'var(--text3)', width: 80 }}>{ch.funnel_role}</span>}
            </div>
          ))}
          {data.funnel_strategy && <p className={s.sectionText} style={{ marginTop: 6 }}>{data.funnel_strategy}</p>}
        </>
      );

    case 'landing_page_cro':
      return (
        <>
          <Bullet items={data.page_recommendations} color="green" />
          {data.tracking_setup?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div className={s.tagRow}>
                {data.tracking_setup.map((t, i) => <span key={i} className={`${s.tag} ${s.tag_green}`}>{t}</span>)}
              </div>
            </div>
          )}
          {data.cta_suggestions?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', marginBottom: 4 }}>CTA 建议</div>
              <Bullet items={data.cta_suggestions} color="amber" />
            </div>
          )}
        </>
      );

    case 'budget_scheduling':
      return (
        <>
          {data.budget_model && <KV label="预算模型" value={data.budget_model} />}
          {data.allocation_rationale && <p className={s.sectionText}>{data.allocation_rationale}</p>}
          <Bullet items={data.scheduling_notes} color="amber" />
          {data.benchmarks && (
            <div className={s.metricsGrid} style={{ marginTop: 8 }}>
              <KV label="CPM" value={data.benchmarks.estimated_cpm} />
              <KV label="CPC" value={data.benchmarks.estimated_cpc} />
              <KV label="CTR" value={data.benchmarks.estimated_ctr} />
              <KV label="CPL" value={data.benchmarks.estimated_cpl} />
            </div>
          )}
        </>
      );

    case 'optimization_reporting':
      return (
        <>
          {data.attribution_model && <KV label="归因模型" value={data.attribution_model} />}
          {data.reporting_cadence && <KV label="报告周期" value={data.reporting_cadence} />}
          {data.ab_test_plan?.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', marginBottom: 4 }}>AB 测试计划</div>
              <Bullet items={data.ab_test_plan} color="green" />
            </div>
          )}
          <Bullet items={data.optimization_suggestions} color="green" />
        </>
      );
    case 'keyword_trends':
      return (
        <>
          {data.seasonal_patterns && <p className={s.sectionText}>{data.seasonal_patterns}</p>}
          {data.high_volume_keywords?.length > 0 && (
            <div className={s.tagRow} style={{ marginTop: 6 }}>
              {data.high_volume_keywords.map((kw, i) => <span key={i} className={`${s.tag} ${s.tag_green}`}>{kw}</span>)}
            </div>
          )}
          {data.rising_keywords?.length > 0 && (
            <div className={s.tagRow} style={{ marginTop: 4 }}>
              {data.rising_keywords.map((kw, i) => <span key={i} className={`${s.tag} ${s.tag_amber}`}>↑ {kw}</span>)}
            </div>
          )}
        </>
      );

    default:
      return <pre className={s.rawJson}>{JSON.stringify(data, null, 2)}</pre>;
  }
}

// ── Main component ────────────────────────────────────────────────

export function ResearchCardV2({ report, duration, inProgress, completed, total }) {
  const [expanded, setExpanded] = useState(false);
  const v2 = report?._v2;
  if (!v2) return null;

  const summaryText = v2.market_competitor_analysis?.market_insights || '';
  const topChannels = (v2.media_mix?.channels || []).slice(0, 3);
  const availableSections = SECTIONS.filter(sec => v2[sec.key]);
  const hasProgress = typeof total === 'number' && total > 0;
  const pct = hasProgress ? Math.round(((completed || 0) / total) * 100) : 0;

  if (inProgress) {
    return (
      <CardShell
        icon={<span className={s.spinner} />}
        title="市场调研生成中"
        badge={hasProgress ? `${completed || 0}/${total} 模块` : null}
      >
        {hasProgress && (
          <div className={s.progressTrack}>
            <div className={`${s.progressFill} ${s.progressFill_green}`} style={{ width: `${pct}%` }} />
          </div>
        )}

        {/* Render completed sections as they arrive */}
        {availableSections.length > 0 && (
          <div className={s.expandedSection}>
            {availableSections.map(sec => (
              <div key={sec.key}>
                <SectionHeader num={sec.num} title={sec.title} titleEn={sec.titleEn} />
                {renderSection(sec.key, v2[sec.key])}
              </div>
            ))}
          </div>
        )}

      </CardShell>
    );
  }

  return (
    <CardShell
      icon="✓"
      title="市场调研完成"
      badge={duration ? `${duration}s` : '9 模块'}
      footer={
        <button className={s.expandBtn} onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起报告' : '查看完整报告 (9 模块)'} →
        </button>
      }
    >
      {/* Summary — always visible */}
      {summaryText && (
        <p className={s.sectionText} style={{ marginBottom: 8 }}>
          {summaryText.length > 150 ? summaryText.slice(0, 150) + '…' : summaryText}
        </p>
      )}
      {topChannels.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {topChannels.map((ch, i) => (
            <span key={i} className={`${s.tag} ${s.tag_green}`}>
              {ch.platform} ({ch.fit_score})
            </span>
          ))}
        </div>
      )}

      {/* Expanded: all 8 sections */}
      {expanded && (
        <div className={s.expandedSection}>
          {SECTIONS.map(sec => (
            <div key={sec.key}>
              <SectionHeader num={sec.num} title={sec.title} titleEn={sec.titleEn} />
              {renderSection(sec.key, v2[sec.key])}
            </div>
          ))}

        </div>
      )}
    </CardShell>
  );
}
