# Research Agent V2 Design

## Goal

Replace the research phase output with a structured 8-section schema matching professional ad planning methodology, while preserving backward compatibility with downstream consumers (strategy, creative_plan, orchestrator).

## V2 Output Schema (`submit_report`)

All 8 sections are required fields.

```js
{
  // 1. 市场与竞品分析
  market_competitor_analysis: {
    market_insights: string,           // 目标市场文化背景、消费习惯概述
    regulations: string[],             // 政策法规 (GDPR, 平台政策等)
    competitor_summary: string,        // 竞品整体分析 (maps to legacy competitor_ads.summary)
    competitor_creative_formats: string[], // 竞品素材类型 (maps to legacy competitor_ads.common_formats)
    competitor_messaging: string[],    // 竞品话术 (maps to legacy competitor_ads.common_messaging)
    gaps_and_opportunities: string[],  // 差异化机会 (maps to legacy competitor_ads.gaps_and_opportunities)
  },

  // 2. 投放目标设定
  campaign_objectives: {
    primary_kpi: string,               // 核心 KPI (e.g. "CPA < $5")
    secondary_kpis: string[],          // 辅助指标 (CTR, ROAS等)
    phases: [{                         // 启动期/成长期/稳定期
      name: string,
      duration: string,
      goal: string,
    }],
  },

  // 3. 用户画像与受众分层
  audience_segmentation: {
    core_audiences: [{                 // maps to legacy audience_insights.primary_segments
      name: string,
      description: string,
      demographics: string,
      interests: string[],
      behaviors: string[],
    }],
    retargeting_strategies: [{
      segment: string,
      strategy: string,
    }],
    content_preferences: string[],     // maps to legacy audience_insights.content_preferences
  },

  // 4. 素材创意策略
  creative_strategy: {
    creative_matrix: [{
      format: string,                  // video/image/carousel
      pain_point: string,
      concept: string,
      cta: string,
    }],
    localization_notes: string[],      // 本地化要点
    hook_scripts: string[],            // 短视频前3秒脚本
  },

  // 5. 渠道与漏斗布局
  media_mix: {
    channels: [{                       // maps to legacy platform_recommendations
      platform: string,
      fit_score: number,               // 0-100
      rationale: string,
      funnel_role: string,             // awareness/consideration/conversion
    }],
    funnel_strategy: string,           // 漏斗整体策略描述
  },

  // 6. 落地页与转化链路
  landing_page_cro: {
    page_recommendations: string[],    // 落地页优化建议
    tracking_setup: string[],          // Pixel, GTM, S2S API
    cta_suggestions: string[],         // CTA 建议
  },

  // 7. 预算与排期分配
  budget_scheduling: {
    budget_model: string,              // e.g. "70/20/10 法则"
    allocation_rationale: string,      // 分配逻辑
    scheduling_notes: string[],        // 时区、高峰时段
    benchmarks: {                      // maps to legacy benchmark_metrics
      estimated_cpm: string,
      estimated_cpc: string,
      estimated_ctr: string,
      estimated_cpl: string,
    },
  },

  // 8. 效果评估与迭代闭环
  optimization_reporting: {
    attribution_model: string,         // 归因窗口
    ab_test_plan: string[],            // AB测试计划
    reporting_cadence: string,         // 报告周期
    optimization_suggestions: string[],// 优化建议
  },

  // Standalone field: keyword trends (no natural section home, strategy needs it)
  keyword_trends: {
    high_volume_keywords: string[],
    rising_keywords: string[],         // strategy reads .rising (alias for rising_keywords)
    seasonal_patterns: string,
  },
}
```

## Legacy Mapping Function (`mapV2ToLegacy`)

Located in `campaign-orchestrator.service.js`. Runs after research completes, produces the field structure that strategy/creative_plan expect:

```js
function mapV2ToLegacy(v2) {
  return {
    // strategy reads: .platform_recommendations[].platform, .fit_score
    platform_recommendations: v2.media_mix?.channels?.map(c => ({
      platform: c.platform,
      fit_score: c.fit_score,
      rationale: c.rationale,
    })) || [],

    // strategy reads: .keyword_trends?.rising (string[])
    keyword_trends: {
      ...(v2.keyword_trends || {}),
      rising: v2.keyword_trends?.rising_keywords || [],
    },

    // strategy + creative_plan reads: .audience_insights.primary_segments[].name/.description
    // creative_plan reads: .audience_insights.content_preferences
    audience_insights: {
      primary_segments: v2.audience_segmentation?.core_audiences || [],
      content_preferences: v2.audience_segmentation?.content_preferences || [],
      platform_preferences: {},
    },

    // creative_plan reads: .competitor_ads (full object)
    competitor_ads: {
      summary: v2.market_competitor_analysis?.competitor_summary || '',
      common_formats: v2.market_competitor_analysis?.competitor_creative_formats || [],
      common_messaging: v2.market_competitor_analysis?.competitor_messaging || [],
      gaps_and_opportunities: v2.market_competitor_analysis?.gaps_and_opportunities || [],
    },

    // orchestrator evaluateOutput reads .recommendations.length
    recommendations: v2.optimization_reporting?.optimization_suggestions || [],

    // frontend reads benchmark_metrics
    benchmark_metrics: v2.budget_scheduling?.benchmarks || {},

    // Preserve the full v2 structure for frontend rendering
    _v2: v2,
  };
}
```

## Downstream Adaptation (Robustness)

### strategy-agent.service.js

`computeBudgetAllocation`:
- Currently: `researchReport?.platform_recommendations || []`
- After mapping: same path works, no change needed

`computeKeywords`:
- Currently: `researchReport?.keyword_trends?.rising || []`
- Mapping adds `.rising` alias pointing to `.rising_keywords`
- No change needed

`computeAudienceSegments`:
- Currently: `researchReport?.audience_insights?.primary_segments` → `seg.name`, `seg.description`
- V2 `core_audiences` has both `.name` and `.description`
- No change needed

### creative-plan.service.js

`extractCreativeContext`:
- Currently reads `report.competitor_ads`, `report.audience_insights?.content_preferences`, `report.audience_insights?.primary_segments`
- All mapped correctly
- Add robustness: fallback to `report._v2?.market_competitor_analysis` if `report.competitor_ads` is missing

### campaign-orchestrator.service.js

`evaluateOutput('research')`:
- Reads `result.recommendations?.length`, `result.platform_recommendations?.length`, `result.competitor_ads?.summary`
- All present in mapped output
- No change needed

`summarizePhaseResult('research')`:
- Same fields as evaluateOutput
- No change needed

## Files to Create/Modify

### New files
1. `src/research-agent-v2.service.js` — v2 agent with 8-section schema
2. `app/v5/components/PhaseCards/ResearchCardV2.js` — frontend card

### Modified files
3. `src/campaign-orchestrator.service.js`:
   - Add `mapV2ToLegacy()` function
   - Change `runResearch()` to call `conductResearchV2` + apply mapping
   - Update `evaluateOutput('research')` to handle v2 fields
4. `src/creative-plan.service.js`:
   - Add fallback in `extractCreativeContext` for v2 direct fields
5. `app/v5/(app)/campaign-studio/page.js`:
   - Import and render `ResearchCardV2` when `report._v2` exists

## Frontend ResearchCardV2

8 collapsible sections, all titles always visible. Each section:
- Fixed title (中英文)
- Structured content per section
- Color coding per section type

Summary area (always visible): Section 1 market insights + Section 5 top channels.
Expand reveals all 8 sections with full content.

## Research Agent V2 Prompt

System prompt instructs Claude to act as a professional overseas advertising planner. Pre-fetches Meta Ad Library + Google Trends data (same as v1). Forces `submit_report` tool call with the 8-section schema. Uses HAIKU model (same as v1).
