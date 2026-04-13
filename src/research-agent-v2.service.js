import { anthropic, MODELS } from './llm-client.js';
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
- Keep each field concise — 1-3 sentences for string fields, 3-8 items for arrays
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

  // Stream the LLM call and report section-by-section progress
  const SECTION_LABELS = {
    market_competitor_analysis: '市场与竞品分析',
    campaign_objectives: '投放目标设定',
    audience_segmentation: '用户画像与受众分层',
    creative_strategy: '素材创意策略',
    media_mix: '渠道与漏斗布局',
    landing_page_cro: '落地页与转化链路',
    budget_scheduling: '预算与排期分配',
    optimization_reporting: '效果评估与迭代闭环',
    keyword_trends: '关键词趋势',
  };
  const reportedSections = new Set();
  const emittedSections = new Set();

  // Try to parse partial JSON by appending closing braces
  function tryParsePartial(json) {
    for (let i = 0; i < 6; i++) {
      try { return JSON.parse(json + '}'.repeat(i)); } catch {}
    }
    return null;
  }

  const stream = anthropic.messages.stream({
    model: MODELS.SONNET,
    max_tokens: 16384,
    system: systemPrompt,
    messages,
    tools: RESEARCH_V2_TOOLS,
    tool_choice: { type: 'tool', name: 'submit_report' },
  });

  let jsonAccum = '';
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
      jsonAccum += event.delta.partial_json;
      // Detect when a new top-level section key appears in the accumulated JSON
      for (const [key, label] of Object.entries(SECTION_LABELS)) {
        if (!reportedSections.has(key) && jsonAccum.includes(`"${key}"`)) {
          reportedSections.add(key);
          onProgress?.({ step: 'section_progress', detail: `✓ ${label} (${reportedSections.size}/9)` });

          // Try to extract completed sections for live preview
          const parsed = tryParsePartial(jsonAccum);
          if (parsed) {
            for (const [sKey] of Object.entries(SECTION_LABELS)) {
              if (!emittedSections.has(sKey) && parsed[sKey] && typeof parsed[sKey] === 'object') {
                emittedSections.add(sKey);
                onProgress?.({ step: 'research_section', section_key: sKey, section_label: SECTION_LABELS[sKey], section_data: parsed[sKey], completed: emittedSections.size, total: 9 });
              }
            }
          }
        }
      }
    }
  }

  const response = await stream.finalMessage();

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
