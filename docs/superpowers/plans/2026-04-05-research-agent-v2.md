# Research Agent V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a new research agent with 8-section output schema, legacy mapping layer, and frontend card — replacing v1 as default while keeping v1 code intact.

**Architecture:** New `research-agent-v2.service.js` exports `conductResearchV2()` with the same signature as v1. Orchestrator's `runResearch()` calls v2 and applies `mapV2ToLegacy()` to produce backward-compatible fields plus `_v2` for the frontend. `ResearchCardV2` renders when `report._v2` exists; old `ResearchCard` remains as fallback.

**Tech Stack:** Claude HAIKU via llm-client, React (Next.js App Router), CSS Modules

**Spec:** `docs/superpowers/specs/2026-04-05-research-agent-v2-design.md`

---

### File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/research-agent-v2.service.js` | V2 research agent: 8-section schema, system prompt, submit_report tool |
| Create | `app/v5/components/PhaseCards/ResearchCardV2.js` | Frontend card rendering 8 sections |
| Modify | `src/campaign-orchestrator.service.js` | `mapV2ToLegacy()`, switch `runResearch` to v2, update `evaluateOutput` + `summarizePhaseResult` |
| Modify | `src/creative-plan.service.js` | Robustness fallback in `extractCreativeContext` |
| Modify | `app/v5/(app)/campaign-studio/page.js` | Import + render ResearchCardV2 |

---

### Task 1: Create research-agent-v2.service.js

**Files:**
- Create: `src/research-agent-v2.service.js`

- [ ] **Step 1: Create the v2 research agent**

Create `src/research-agent-v2.service.js` with the 8-section `submit_report` schema. Same structure as v1: pre-fetch Meta Ad Library + Google Trends data, single LLM call with `tool_choice: { type: 'tool', name: 'submit_report' }`.

```js
import { anthropic, MODELS } from './llm-client.js';
import { config } from './config.js';
import { fetchMetaAdLibrary, fetchGoogleTrends } from './research-agent.service.js';

const RESEARCH_V2_TOOLS = [
  {
    name: 'submit_report',
    description: 'Submit the complete 8-section research report.',
    input_schema: {
      type: 'object',
      required: [
        'market_competitor_analysis',
        'campaign_objectives',
        'audience_segmentation',
        'creative_strategy',
        'media_mix',
        'landing_page_cro',
        'budget_scheduling',
        'optimization_reporting',
        'keyword_trends',
      ],
      properties: {
        market_competitor_analysis: {
          type: 'object',
          required: ['market_insights', 'competitor_summary', 'gaps_and_opportunities'],
          properties: {
            market_insights: { type: 'string', description: '目标市场文化背景、消费习惯概述' },
            regulations: { type: 'array', items: { type: 'string' }, description: '相关政策法规 (GDPR、平台广告政策等)' },
            competitor_summary: { type: 'string', description: '竞品整体分析' },
            competitor_creative_formats: { type: 'array', items: { type: 'string' }, description: '竞品常用素材类型' },
            competitor_messaging: { type: 'array', items: { type: 'string' }, description: '竞品常用话术/卖点' },
            gaps_and_opportunities: { type: 'array', items: { type: 'string' }, description: '差异化机会' },
          },
        },
        campaign_objectives: {
          type: 'object',
          required: ['primary_kpi', 'phases'],
          properties: {
            primary_kpi: { type: 'string', description: '核心 KPI (如 CPA < $5)' },
            secondary_kpis: { type: 'array', items: { type: 'string' }, description: '辅助 KPI (CTR, ROAS 等)' },
            phases: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  duration: { type: 'string' },
                  goal: { type: 'string' },
                },
              },
              description: '投放阶段划分 (启动期/成长期/稳定期)',
            },
          },
        },
        audience_segmentation: {
          type: 'object',
          required: ['core_audiences'],
          properties: {
            core_audiences: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  demographics: { type: 'string' },
                  interests: { type: 'array', items: { type: 'string' } },
                  behaviors: { type: 'array', items: { type: 'string' } },
                },
              },
              description: '核心受众人群',
            },
            retargeting_strategies: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  segment: { type: 'string' },
                  strategy: { type: 'string' },
                },
              },
              description: '再营销策略',
            },
            content_preferences: { type: 'array', items: { type: 'string' }, description: '目标受众内容偏好' },
          },
        },
        creative_strategy: {
          type: 'object',
          required: ['creative_matrix'],
          properties: {
            creative_matrix: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  format: { type: 'string', description: 'video/image/carousel' },
                  pain_point: { type: 'string' },
                  concept: { type: 'string' },
                  cta: { type: 'string' },
                },
              },
            },
            localization_notes: { type: 'array', items: { type: 'string' }, description: '本地化适配要点' },
            hook_scripts: { type: 'array', items: { type: 'string' }, description: '短视频前3秒 Hook 脚本' },
          },
        },
        media_mix: {
          type: 'object',
          required: ['channels'],
          properties: {
            channels: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  platform: { type: 'string' },
                  fit_score: { type: 'number', description: '适配度 0-100' },
                  rationale: { type: 'string' },
                  funnel_role: { type: 'string', description: 'awareness/consideration/conversion' },
                },
              },
            },
            funnel_strategy: { type: 'string', description: '漏斗整体策略' },
          },
        },
        landing_page_cro: {
          type: 'object',
          properties: {
            page_recommendations: { type: 'array', items: { type: 'string' }, description: '落地页优化建议' },
            tracking_setup: { type: 'array', items: { type: 'string' }, description: '追踪工具配置 (Pixel/GTM/S2S)' },
            cta_suggestions: { type: 'array', items: { type: 'string' }, description: 'CTA 建议' },
          },
        },
        budget_scheduling: {
          type: 'object',
          required: ['benchmarks'],
          properties: {
            budget_model: { type: 'string', description: '预算分配模型 (如 70/20/10 法则)' },
            allocation_rationale: { type: 'string', description: '分配逻辑' },
            scheduling_notes: { type: 'array', items: { type: 'string' }, description: '排期注意事项 (时区/高峰/节点)' },
            benchmarks: {
              type: 'object',
              properties: {
                estimated_cpm: { type: 'string' },
                estimated_cpc: { type: 'string' },
                estimated_ctr: { type: 'string' },
                estimated_cpl: { type: 'string' },
              },
            },
          },
        },
        optimization_reporting: {
          type: 'object',
          properties: {
            attribution_model: { type: 'string', description: '归因模型 (如 7-day click, 1-day view)' },
            ab_test_plan: { type: 'array', items: { type: 'string' }, description: 'AB 测试计划' },
            reporting_cadence: { type: 'string', description: '报告周期' },
            optimization_suggestions: { type: 'array', items: { type: 'string' }, description: '优化建议' },
          },
        },
        keyword_trends: {
          type: 'object',
          properties: {
            high_volume_keywords: { type: 'array', items: { type: 'string' } },
            rising_keywords: { type: 'array', items: { type: 'string' } },
            seasonal_patterns: { type: 'string' },
          },
        },
      },
    },
  },
];

const RESEARCH_V2_SYSTEM_PROMPT = `You are a professional overseas advertising planner (海外广告策划专家).

Your job: analyze a campaign brief and pre-fetched external data, then produce a structured research report by calling submit_report.

The report MUST cover exactly 8 sections (八大策划模块):

1. **市场与竞品分析 (Market & Competitor Analysis)** — 目标市场文化/消费习惯、政策法规、竞品素材/话术/流量路径分析、差异化机会
2. **投放目标设定 (Campaign Objectives)** — 核心 KPI、辅助指标、阶段划分(启动/成长/稳定)
3. **用户画像与受众分层 (Audience Segmentation)** — 核心受众(地理/人口/兴趣/行为)、再营销策略、内容偏好
4. **素材创意策略 (Creative Strategy)** — 创意矩阵(格式×痛点×概念×CTA)、本地化适配、Hook脚本
5. **渠道与漏斗布局 (Media Mix & Funnel Strategy)** — 渠道选择+适配度评分、漏斗策略(认知→考虑→转化)
6. **落地页与转化链路 (Landing Page & CRO)** — 页面优化建议、追踪配置、CTA建议
7. **预算与排期分配 (Budget Allocation & Scheduling)** — 预算模型、分配逻辑、排期注意事项、行业基准指标(CPM/CPC/CTR/CPL)
8. **效果评估与迭代闭环 (Optimization & Reporting)** — 归因模型、AB测试计划、报告周期、优化建议

Plus a standalone **keyword_trends** section with high-volume and rising keywords.

Rules:
- Analyze all provided external data carefully — it is real-time data
- If external data is unavailable or empty, supplement with your training knowledge
- Be specific: use numbers, benchmarks, and actionable insights — not vague generalities
- Focus on the target markets and platforms relevant to the brief
- Each section must be substantive (not single-word answers)
- For media_mix.channels, provide fit_score as a number 0-100
- You MUST call submit_report with ALL required fields filled`;

export async function conductResearchV2(brief, instructions, onProgress) {
  const systemPrompt = instructions
    ? `${RESEARCH_V2_SYSTEM_PROMPT}\n\n═══ 额外指令 ═══\n${instructions}`
    : RESEARCH_V2_SYSTEM_PROMPT;

  const productsArr = Array.isArray(brief.products) ? brief.products : [];
  const productsStr = typeof brief.products === 'string' ? brief.products : '';
  const productNames = productsArr.map(p => p.model || p.name).filter(Boolean);
  const searchTerms = [brief.industry, ...productNames, productsStr].filter(Boolean).join(' ').trim();
  const countries = brief.target_countries || [];
  const keywords = [brief.industry, ...productNames, productsStr].filter(Boolean).slice(0, 3);

  onProgress?.({ step: 'fetching_data', detail: '获取 Meta 广告库和 Google Trends 数据' });
  const [adLibraryResult, trendsResult] = await Promise.all([
    fetchMetaAdLibrary({ search_terms: searchTerms, countries }).catch(err => ({ available: false, error: err.message })),
    fetchGoogleTrends({ keywords }).catch(err => ({ available: false, error: err.message })),
  ]);
  onProgress?.({ step: 'analyzing', detail: '分析市场数据，生成八大模块调研报告' });

  const rawAds = adLibraryResult?.ads || [];

  const messages = [{
    role: 'user',
    content: `Conduct comprehensive market research for this campaign brief and submit your 8-section report via submit_report.

CAMPAIGN BRIEF:
${JSON.stringify(brief)}

EXTERNAL DATA (pre-fetched):

=== Meta Ad Library Results ===
${JSON.stringify(adLibraryResult)}

=== Google Trends Results ===
${JSON.stringify(trendsResult)}

Analyze the brief and external data above, then call submit_report with your complete 8-section research report.`,
  }];

  const response = await anthropic.messages.stream({
    model: MODELS.HAIKU,
    max_tokens: 16384,
    system: systemPrompt,
    messages,
    tools: RESEARCH_V2_TOOLS,
    tool_choice: { type: 'tool', name: 'submit_report' },
  }).finalMessage();

  const submitBlock = response.content.find(c => c.type === 'tool_use' && c.name === 'submit_report');
  if (submitBlock?.input && Object.keys(submitBlock.input).length > 0) {
    submitBlock.input.competitor_ads_raw = rawAds;
    return submitBlock.input;
  }

  const textBlock = response.content.find(c => c.type === 'text');
  console.error('[research-v2] No valid submit_report. stop_reason:', response.stop_reason,
    'content_types:', response.content.map(c => c.type),
    'text_preview:', textBlock?.text?.slice(0, 200));

  throw new Error('Research V2 agent did not produce a report');
}
```

- [ ] **Step 2: Commit**

```bash
git add src/research-agent-v2.service.js
git commit -m "feat: add research-agent-v2 with 8-section schema"
```

---

### Task 2: Add mapV2ToLegacy and wire into orchestrator

**Files:**
- Modify: `src/campaign-orchestrator.service.js`

- [ ] **Step 1: Add import for conductResearchV2**

At the top of the file, after the existing `conductResearch` import line, add:

```js
import { conductResearchV2 } from './research-agent-v2.service.js';
```

- [ ] **Step 2: Add mapV2ToLegacy function**

Add this function before the `runResearch` function (around line 154):

```js
/**
 * Map v2 research output (8-section schema) to legacy field names
 * consumed by strategy-agent, creative-plan, evaluateOutput, summarizePhaseResult.
 */
function mapV2ToLegacy(v2) {
  return {
    platform_recommendations: (v2.media_mix?.channels || []).map(c => ({
      platform: c.platform,
      fit_score: c.fit_score,
      rationale: c.rationale,
    })),
    keyword_trends: {
      high_volume_keywords: v2.keyword_trends?.high_volume_keywords || [],
      rising_keywords: v2.keyword_trends?.rising_keywords || [],
      rising: v2.keyword_trends?.rising_keywords || [],
      seasonal_patterns: v2.keyword_trends?.seasonal_patterns || '',
    },
    audience_insights: {
      primary_segments: v2.audience_segmentation?.core_audiences || [],
      content_preferences: v2.audience_segmentation?.content_preferences || [],
      platform_preferences: {},
    },
    competitor_ads: {
      summary: v2.market_competitor_analysis?.competitor_summary || '',
      common_formats: v2.market_competitor_analysis?.competitor_creative_formats || [],
      common_messaging: v2.market_competitor_analysis?.competitor_messaging || [],
      gaps_and_opportunities: v2.market_competitor_analysis?.gaps_and_opportunities || [],
    },
    recommendations: v2.optimization_reporting?.optimization_suggestions || [],
    benchmark_metrics: v2.budget_scheduling?.benchmarks || {},
    market_overview: {
      market_size_estimate: '',
      growth_trend: '',
      key_players: [],
      market_characteristics: [],
    },
    competitor_ads_raw: v2.competitor_ads_raw,
    _v2: v2,
  };
}
```

- [ ] **Step 3: Update runResearch to use v2 + mapping**

Replace the existing `runResearch` function:

```js
async function runResearch(sessionId, brief, _phaseResults, instructions, onProgress) {
  const v2Result = await runAgentWithTrace(sessionId, 'research', conductResearchV2, [brief.brief || {}, instructions, onProgress]);
  return mapV2ToLegacy(v2Result);
}
```

- [ ] **Step 4: Update evaluateOutput for research**

The mapped output already has `recommendations`, `platform_recommendations`, and `competitor_ads.summary`, so `evaluateOutput` continues to work. No code change needed — but verify the three checks:
- `result?.recommendations?.length` — mapped from `optimization_reporting.optimization_suggestions`
- `result?.platform_recommendations?.length` — mapped from `media_mix.channels`
- `result?.competitor_ads?.summary` — mapped from `market_competitor_analysis.competitor_summary`

All paths preserved. No change required.

- [ ] **Step 5: Commit**

```bash
git add src/campaign-orchestrator.service.js
git commit -m "feat: wire research v2 into orchestrator with legacy mapping"
```

---

### Task 3: Add robustness fallback in creative-plan.service.js

**Files:**
- Modify: `src/creative-plan.service.js:131-140`

- [ ] **Step 1: Update extractCreativeContext with v2 fallback**

Replace the existing `extractCreativeContext` function:

```js
function extractCreativeContext(report) {
  if (!report) return {};

  // Support both legacy fields and v2 direct fields
  const v2 = report._v2;

  const competitor_ads = report.competitor_ads || (v2?.market_competitor_analysis ? {
    summary: v2.market_competitor_analysis.competitor_summary,
    common_formats: v2.market_competitor_analysis.competitor_creative_formats,
    common_messaging: v2.market_competitor_analysis.competitor_messaging,
    gaps_and_opportunities: v2.market_competitor_analysis.gaps_and_opportunities,
  } : undefined);

  const content_preferences = report.audience_insights?.content_preferences
    || v2?.audience_segmentation?.content_preferences
    || [];

  const rawSegments = report.audience_insights?.primary_segments
    || v2?.audience_segmentation?.core_audiences
    || [];

  return {
    competitor_ads,
    content_preferences,
    primary_segments: Array.isArray(rawSegments)
      ? rawSegments.map(s => s.name || s.description)
      : [],
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/creative-plan.service.js
git commit -m "fix: add v2 fallback in extractCreativeContext for robustness"
```

---

### Task 4: Create ResearchCardV2 frontend component

**Files:**
- Create: `app/v5/components/PhaseCards/ResearchCardV2.js`

- [ ] **Step 1: Create ResearchCardV2.js**

This component renders the 8 fixed sections. Uses the same `CardShell`, `Bullet`, `KV` helpers and CSS module from `PhaseCards.js`.

```jsx
'use client';

import { useState } from 'react';
import s from './PhaseCards.module.css';

// ── Shared helpers (duplicated from PhaseCards to keep files independent) ──

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
  green:  { bg: 'rgba(42, 140, 90, 0.10)',  border: 'rgba(42, 140, 90, 0.3)',  text: '#2a8c5a' },
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

// ── Section renderer ──────────────────────────────────────────────

const SECTIONS = [
  { key: 'market_competitor_analysis', num: '1', title: '市场与竞品分析', titleEn: 'Market & Competitor Analysis', color: 'green' },
  { key: 'campaign_objectives',       num: '2', title: '投放目标设定',   titleEn: 'Campaign Objectives',        color: 'green' },
  { key: 'audience_segmentation',     num: '3', title: '用户画像与受众分层', titleEn: 'Audience Segmentation',  color: 'green' },
  { key: 'creative_strategy',        num: '4', title: '素材创意策略',   titleEn: 'Creative Strategy',          color: 'green' },
  { key: 'media_mix',                num: '5', title: '渠道与漏斗布局', titleEn: 'Media Mix & Funnel Strategy', color: 'green' },
  { key: 'landing_page_cro',         num: '6', title: '落地页与转化链路', titleEn: 'Landing Page & CRO',       color: 'green' },
  { key: 'budget_scheduling',        num: '7', title: '预算与排期分配', titleEn: 'Budget Allocation & Scheduling', color: 'green' },
  { key: 'optimization_reporting',   num: '8', title: '效果评估与迭代闭环', titleEn: 'Optimization & Reporting', color: 'green' },
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

    default:
      return <pre className={s.rawJson}>{JSON.stringify(data, null, 2)}</pre>;
  }
}

// ── Main component ────────────────────────────────────────────────

export function ResearchCardV2({ report, duration }) {
  const [expanded, setExpanded] = useState(false);
  const v2 = report?._v2;
  if (!v2) return null;

  // Summary: market insights excerpt + top channels
  const summaryText = v2.market_competitor_analysis?.market_insights || '';
  const topChannels = (v2.media_mix?.channels || []).slice(0, 3);

  return (
    <CardShell
      icon="✓"
      title="市场调研完成"
      badge={duration ? `${duration}s` : '8 模块'}
      footer={
        <button className={s.expandBtn} onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起报告' : '查看完整报告 (8 模块)'} →
        </button>
      }
    >
      {/* Summary area — always visible */}
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

          {/* Keyword trends (standalone) */}
          {v2.keyword_trends && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text3)', marginBottom: 6 }}>关键词趋势</div>
              {v2.keyword_trends.high_volume_keywords?.length > 0 && (
                <div className={s.tagRow}>
                  {v2.keyword_trends.high_volume_keywords.map((kw, i) => (
                    <span key={i} className={`${s.tag} ${s.tag_green}`}>{kw}</span>
                  ))}
                </div>
              )}
              {v2.keyword_trends.rising_keywords?.length > 0 && (
                <div className={s.tagRow} style={{ marginTop: 4 }}>
                  {v2.keyword_trends.rising_keywords.map((kw, i) => (
                    <span key={i} className={`${s.tag} ${s.tag_amber}`}>↑ {kw}</span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </CardShell>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add app/v5/components/PhaseCards/ResearchCardV2.js
git commit -m "feat: add ResearchCardV2 component with 8-section layout"
```

---

### Task 5: Wire ResearchCardV2 into the campaign-studio page

**Files:**
- Modify: `app/v5/(app)/campaign-studio/page.js:15` (import line)
- Modify: `app/v5/(app)/campaign-studio/page.js:1301-1302` (render line)

- [ ] **Step 1: Add import**

At line 15, update the import from PhaseCards to include ResearchCardV2:

```js
// existing line:
import {
  ResearchCard, StrategyCard, CreativePlanCard, CreativeCard,
  ExecutionCard, FeedbackCard, PhaseDivider,
} from '../../components/PhaseCards/PhaseCards';

// add after it:
import { ResearchCardV2 } from '../../components/PhaseCards/ResearchCardV2';
```

- [ ] **Step 2: Update render logic**

Replace the `research_complete` render block (around line 1301-1302):

```js
// Before:
if (item.type === 'research_complete') {
  return <ResearchCard key={item.id || i} report={item.report} duration={item.duration} />;
}

// After:
if (item.type === 'research_complete') {
  if (item.report?._v2) {
    return <ResearchCardV2 key={item.id || i} report={item.report} duration={item.duration} />;
  }
  return <ResearchCard key={item.id || i} report={item.report} duration={item.duration} />;
}
```

- [ ] **Step 3: Commit**

```bash
git add app/v5/\(app\)/campaign-studio/page.js
git commit -m "feat: render ResearchCardV2 when v2 data available"
```

---

### Task 6: Browser test

**Files:** None (manual verification)

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

- [ ] **Step 2: Open browser and run a campaign orchestration**

Navigate to the campaign studio page, create or use an existing brief, and trigger the research phase. Verify:

1. The research phase completes without errors
2. The `ResearchCardV2` renders with all 8 section headers visible in expanded view
3. Each section shows substantive content (not empty)
4. The summary area shows market insights excerpt + top channel tags
5. The "查看完整报告 (8 模块)" expand/collapse button works

- [ ] **Step 3: Verify downstream phases work**

Continue the orchestration through strategy and creative_plan phases. Verify:
1. Strategy phase receives budget allocation (platform_recommendations mapping works)
2. Strategy phase receives keyword trends (keyword_trends.rising mapping works)
3. Creative plan phase receives competitor ads data (competitor_ads mapping works)
4. No console errors related to missing fields
