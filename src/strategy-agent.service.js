import { anthropic, MODELS } from './llm-client.js';

// ── Tool definition (submit only) ────────────────────────────────────

// ── Flat schema: LLM outputs 4 parallel arrays, code reassembles nesting ──
const SUBMIT_TOOL = {
  name: 'submit_media_plan',
  description: 'Submit the final media plan as flat lists. Use platform/campaign_name/ad_set_name to link entities.',
  input_schema: {
    type: 'object',
    required: ['summary', 'total_budget', 'currency', 'duration_days', 'platforms', 'campaigns', 'ad_sets', 'ads'],
    properties: {
      summary: { type: 'string', description: 'Brief summary (1-2 sentences)' },
      total_budget: { type: 'number' },
      currency: { type: 'string' },
      duration_days: { type: 'number' },
      platforms: {
        type: 'array',
        items: {
          type: 'object',
          required: ['platform', 'budget_allocation', 'budget_amount', 'rationale'],
          properties: {
            platform: { type: 'string', enum: ['meta', 'google', 'tiktok', 'linkedin', 'reddit'] },
            budget_allocation: { type: 'number', description: 'Percentage, e.g. 40 means 40%. Must sum to 100.' },
            budget_amount: { type: 'number' },
            rationale: { type: 'string' },
          },
        },
      },
      campaigns: {
        type: 'array',
        items: {
          type: 'object',
          required: ['platform', 'name', 'objective', 'daily_budget'],
          properties: {
            platform: { type: 'string', description: 'Must match a platform above' },
            name: { type: 'string' },
            objective: { type: 'string', enum: ['lead_gen', 'traffic', 'awareness', 'conversions', 'engagement', 'video_views', 'app_installs', 'reach', 'messages'], description: 'Use exactly these values. Do NOT use "lead_generation" — use "lead_gen" instead.' },
            daily_budget: { type: 'number' },
          },
        },
      },
      ad_sets: {
        type: 'array',
        items: {
          type: 'object',
          required: ['campaign_name', 'name', 'targeting', 'optimization_goal'],
          properties: {
            campaign_name: { type: 'string', description: 'Must match a campaign name above' },
            name: { type: 'string' },
            targeting: { type: 'object' },
            optimization_goal: { type: 'string' },
          },
        },
      },
      ads: {
        type: 'array',
        items: {
          type: 'object',
          required: ['ad_set_name', 'name', 'format', 'primary_text', 'headline', 'description', 'cta', 'suggested_content'],
          properties: {
            ad_set_name: { type: 'string', description: 'Must match an ad_set name above' },
            name: { type: 'string' },
            format: { type: 'string', enum: ['image'] },
            primary_text: { type: 'string' },
            headline: { type: 'string' },
            description: { type: 'string' },
            cta: { type: 'string', enum: ['Learn More', 'Shop Now', 'Sign Up', 'Contact Us', 'Get Quote', 'Apply Now', 'Download', 'Send WhatsApp', 'Subscribe', 'Book Now'], description: 'Must use exact value from enum. For lead_gen campaigns, do NOT use "Send WhatsApp" — use "Learn More", "Sign Up", or "Apply Now" instead.' },
            media_specs: { type: 'string', description: 'Image specs e.g. "1080x1080"' },
            suggested_content: { type: 'string', description: 'What the ad image should visually depict, e.g. "Product hero shot on white background with lifestyle context"' },
          },
        },
      },
    },
  },
};

/**
 * Reassemble flat LLM output into the nested structure consumers expect:
 * platforms[] → campaigns[] → ad_sets[] → ads[]
 */
function nestMediaPlan(flat) {
  const { summary, total_budget, currency, duration_days } = flat;

  // Index ads by ad_set_name
  const adsByAdSet = new Map();
  for (const ad of (flat.ads || [])) {
    const key = ad.ad_set_name;
    if (!adsByAdSet.has(key)) adsByAdSet.set(key, []);
    adsByAdSet.get(key).push({
      name: ad.name,
      format: ad.format || 'image',
      primary_text: ad.primary_text,
      headline: ad.headline,
      description: ad.description,
      cta: ad.cta,
      media_requirements: {
        type: ad.format || 'image',
        specs: ad.media_specs || '',
        suggested_content: ad.suggested_content || `${ad.headline}. ${ad.description}`,
      },
    });
  }

  // Index ad_sets by campaign_name
  const adSetsByCampaign = new Map();
  for (const as of (flat.ad_sets || [])) {
    const key = as.campaign_name;
    if (!adSetsByCampaign.has(key)) adSetsByCampaign.set(key, []);
    adSetsByCampaign.get(key).push({
      name: as.name,
      targeting: as.targeting,
      optimization_goal: as.optimization_goal,
      ads: adsByAdSet.get(as.name) || [],
    });
  }

  // Index campaigns by platform
  const campaignsByPlatform = new Map();
  for (const c of (flat.campaigns || [])) {
    const key = c.platform;
    if (!campaignsByPlatform.has(key)) campaignsByPlatform.set(key, []);
    campaignsByPlatform.get(key).push({
      name: c.name,
      objective: c.objective,
      daily_budget: c.daily_budget,
      ad_sets: adSetsByCampaign.get(c.name) || [],
    });
  }

  // Build nested platforms
  const platforms = (flat.platforms || []).map(p => ({
    platform: p.platform,
    budget_allocation: p.budget_allocation,
    budget_amount: p.budget_amount,
    rationale: p.rationale,
    campaigns: campaignsByPlatform.get(p.platform) || [],
  }));

  // ── Post-processing: normalize objectives & enforce CTA rules ──
  const OBJECTIVE_ALIASES = {
    lead_generation: 'lead_gen',
    LEAD_GENERATION: 'lead_gen',
    OUTCOME_LEADS: 'lead_gen',
    OUTCOME_TRAFFIC: 'traffic',
    OUTCOME_AWARENESS: 'awareness',
    OUTCOME_SALES: 'conversions',
    OUTCOME_ENGAGEMENT: 'engagement',
    OUTCOME_APP_PROMOTION: 'app_installs',
  };
  const LEAD_GEN_OBJECTIVES = new Set(['lead_gen', 'leads']);
  const WHATSAPP_CTA = 'Send WhatsApp';

  for (const plat of platforms) {
    for (const camp of plat.campaigns) {
      // Normalize objective aliases
      if (OBJECTIVE_ALIASES[camp.objective]) {
        camp.objective = OBJECTIVE_ALIASES[camp.objective];
      }
      // Downgrade WhatsApp CTA to Learn More in lead_gen campaigns
      if (LEAD_GEN_OBJECTIVES.has(camp.objective)) {
        for (const adSet of camp.ad_sets) {
          for (const ad of adSet.ads) {
            if (ad.cta === WHATSAPP_CTA) {
              ad.cta = 'Learn More';
            }
          }
        }
      }
    }
  }

  return { summary, total_budget, currency, duration_days, platforms };
}

const STRATEGY_SYSTEM_PROMPT = `You are a senior digital advertising strategist specializing in overseas campaign planning.

Your job: take a campaign brief, market research, and pre-computed data (budget allocation, keywords, audience segments), then synthesize into a complete media plan.

## Audience Segmentation (3-tier)
- P1 High-Intent: decision makers actively searching
- P2 Industry Niche: professionals matching job title + industry criteria
- P3 Retargeting: users who engaged but didn't convert

## Funnel-Based Media Mix
- Top of Funnel (Awareness): 15-25%
- Middle of Funnel (Consideration): 50-60%
- Bottom of Funnel (Conversion/Retargeting): 15-25%

## Rules
- Budget allocations across platforms must sum to 100%
- Each campaign must have at least one ad_set with targeting and at least one ad
- Daily budgets: minimum $5/day per ad set for Meta, $10/day for Google
- Prefer the platforms suggested in the brief
- Campaign count should match the budget scale: 1 campaign for budgets < $3,000, 1-2 for $3,000-$10,000, 2-3 for > $10,000. Do NOT over-create campaigns — each campaign needs enough daily budget to be effective
- Ad copy fields (primary_text, headline, description, cta) should be brief placeholders
- CTA must be an exact match from the enum in the schema (English only, no translations)
- For lead_gen/leads campaigns: NEVER use "Send WhatsApp" as CTA. Use "Learn More", "Sign Up", or "Apply Now" instead
- "Send WhatsApp" CTA is ONLY allowed for messaging/engagement campaigns, never for lead_gen
- Include a brief summary (1-2 sentences)
- Output flat lists: platforms, campaigns (linked by platform), ad_sets (linked by campaign_name), ads (linked by ad_set_name)
- You MUST call submit_media_plan as your final action`;

// ── Pre-computation (no LLM needed) ─────────────────────────────────

function computeBudgetAllocation(brief, researchReport) {
  const total_budget = brief.budget_total || 500;
  const currency = brief.budget_currency || 'USD';
  const duration_days = brief.campaign_duration_days || 30;
  const platforms = brief.preferred_platforms || ['meta'];
  const platform_fit_scores = researchReport?.platform_recommendations || [];

  // Normalize platforms to simple lowercase strings
  const normalizedPlatforms = (Array.isArray(platforms) ? platforms : ['meta']).map(p => {
    if (typeof p !== 'string') return 'meta';
    // "Meta（Instagram/Facebook）+ Click-to-WhatsApp" → "meta"
    const lower = p.toLowerCase();
    if (lower.includes('meta') || lower.includes('facebook') || lower.includes('instagram')) return 'meta';
    if (lower.includes('google')) return 'google';
    if (lower.includes('tiktok')) return 'tiktok';
    if (lower.includes('snapchat')) return 'snapchat';
    if (lower.includes('linkedin')) return 'linkedin';
    return lower.split(/[\s（(]/)[0];
  });
  // Deduplicate
  const uniquePlatforms = [...new Set(normalizedPlatforms)];

  const daily = total_budget / duration_days;
  const scores = {};
  for (const p of uniquePlatforms) {
    const fit = platform_fit_scores.find(f => (f.platform || '').toLowerCase().includes(p));
    scores[p] = fit?.fit_score || 5;
  }
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);

  return {
    total_budget, currency, duration_days,
    daily_budget: Math.round(daily),
    allocations: uniquePlatforms.map(p => {
      const pct = Math.round((scores[p] / totalScore) * 100);
      return { platform: p, percentage: pct, amount: Math.round(total_budget * pct / 100), daily_budget: Math.round(daily * pct / 100) };
    }),
  };
}

function computeKeywords(brief, researchReport) {
  const { industry, target_countries } = brief;
  const products = Array.isArray(brief.products)
    ? brief.products
    : typeof brief.products === 'string' && brief.products.trim()
      ? [brief.products.trim()]
      : [];
  const countries = Array.isArray(target_countries) ? target_countries : [];
  const trending = researchReport?.keyword_trends?.rising || [];
  const groups = [];

  if (products.length) {
    groups.push({ theme: 'product', match_type: 'phrase', keywords: products.map(p => `${(p.model || p)} ${industry || ''}`.trim()) });
  }
  if (industry) {
    groups.push({ theme: 'industry', match_type: 'broad', keywords: [`${industry} supplier`, `${industry} wholesale`, `buy ${industry}`] });
  }
  if (Array.isArray(trending) && trending.length) {
    groups.push({ theme: 'trending', match_type: 'phrase', keywords: trending.slice(0, 10) });
  }
  if (countries.length && products.length) {
    groups.push({ theme: 'geo_intent', match_type: 'phrase', keywords: countries.flatMap(c => products.map(p => `${p.model || p} ${c}`)) });
  }
  return { keyword_groups: groups };
}

function computeAudienceSegments(brief, researchReport) {
  const { industry, target_countries, target_audience } = brief;
  const audience_insights = researchReport?.audience_insights;
  const segments = [{
    name: `${industry} - Primary`,
    targeting: { countries: target_countries || [], age_range: target_audience?.age_range || [25, 55], interests: target_audience?.interests || [industry] },
    priority: 'primary',
  }];

  if (Array.isArray(audience_insights?.primary_segments) && audience_insights.primary_segments.length) {
    for (const seg of audience_insights.primary_segments.slice(0, 2)) {
      segments.push({
        name: seg.name || `${industry} - ${seg.description}`,
        targeting: { countries: target_countries || [], age_range: target_audience?.age_range || [25, 55], interests: [...(target_audience?.interests || []), ...(seg.name ? [seg.name] : [])] },
        priority: 'secondary',
      });
    }
  }
  return { segments };
}

// ── Main entry point (single LLM call) ───────────────────────────────

/**
 * Generate a media plan. Pre-computes budget/keywords/segments, then
 * makes a single forced submit_media_plan call.
 */
export async function generateMediaPlan(brief, researchReport, instructions) {
  // Pre-compute helper data (no LLM needed)
  const budgetData = computeBudgetAllocation(brief, researchReport);
  const keywordData = computeKeywords(brief, researchReport);
  const audienceData = computeAudienceSegments(brief, researchReport);

  const systemPrompt = instructions
    ? `${STRATEGY_SYSTEM_PROMPT}\n\n═══ 额外指令 ═══\n${instructions}`
    : STRATEGY_SYSTEM_PROMPT;

  const response = await anthropic.messages.stream({
    model: MODELS.HAIKU,
    max_tokens: 16384,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Generate a complete media plan and call submit_media_plan.

CAMPAIGN BRIEF:
${JSON.stringify(brief)}

MARKET RESEARCH:
${JSON.stringify(researchReport)}

PRE-COMPUTED DATA:

BUDGET ALLOCATION:
${JSON.stringify(budgetData)}

KEYWORDS:
${JSON.stringify(keywordData)}

AUDIENCE SEGMENTS:
${JSON.stringify(audienceData)}`,
    }],
    tools: [SUBMIT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_media_plan' },
  }).finalMessage();

  const submitBlock = response.content.find(c => c.type === 'tool_use' && c.name === 'submit_media_plan');
  if (!submitBlock) throw new Error('Strategy agent did not produce a media plan');
  return validateAndNestMediaPlan(submitBlock.input);
}

/**
 * Basic validation of MediaPlan structure.
 */
/**
 * Validate flat media plan from LLM, then nest into consumer structure.
 * Returns the nested plan.
 */
function validateAndNestMediaPlan(flat) {
  // Detect JSON parse failure from llm-client
  if (flat._parse_error) {
    console.error('[strategy] MediaPlan received unparseable JSON from LLM.',
      'Parse error:', flat._parse_error,
      'Raw (first 500):', (flat._raw || '').slice(0, 500));
    throw new Error(`MediaPlan JSON parse failed: ${flat._parse_error}. Raw: ${(flat._raw || '').slice(0, 200)}`);
  }

  if (!Array.isArray(flat.platforms) || flat.platforms.length === 0) {
    console.error('[strategy] MediaPlan validation failed. Actual keys:', Object.keys(flat), 'Full input:', JSON.stringify(flat).slice(0, 1000));
    throw new Error(`MediaPlan missing platforms array. Got keys: [${Object.keys(flat).join(', ')}]`);
  }
  if (!Array.isArray(flat.campaigns) || flat.campaigns.length === 0) {
    throw new Error(`MediaPlan missing campaigns array. Got keys: [${Object.keys(flat).join(', ')}]`);
  }
  if (!Array.isArray(flat.ad_sets) || flat.ad_sets.length === 0) {
    throw new Error(`MediaPlan missing ad_sets array. Got keys: [${Object.keys(flat).join(', ')}]`);
  }
  if (!Array.isArray(flat.ads) || flat.ads.length === 0) {
    throw new Error(`MediaPlan missing ads array. Got keys: [${Object.keys(flat).join(', ')}]`);
  }

  // Reassemble into nested structure
  const plan = nestMediaPlan(flat);

  // Normalize budget_allocation: if values look like decimals (sum ≤ 1.1), convert to percentages
  const rawSum = plan.platforms.reduce((s, p) => s + (p.budget_allocation || 0), 0);
  if (rawSum > 0 && rawSum <= 1.1) {
    for (const p of plan.platforms) {
      if (typeof p.budget_allocation === 'number') p.budget_allocation = Math.round(p.budget_allocation * 100);
    }
  }

  if (!plan.summary) {
    const platformNames = plan.platforms.map(p => p.platform).join(', ');
    const totalCampaigns = plan.platforms.reduce((s, p) => s + (p.campaigns?.length || 0), 0);
    plan.summary = `${platformNames} campaign plan: ${totalCampaigns} campaigns, $${plan.total_budget || '?'} ${plan.currency || 'USD'} over ${plan.duration_days || '?'} days`;
  }

  return plan;
}

// ── Merged: Strategy + Creative Plan (progressive disclosure) ─────────

/**
 * Single-conversation flow: strategy (1 call) → creative plan (1 call).
 *
 * Call 1: Pre-computed data + forced submit_media_plan (strategy rules in system prompt)
 * Call 2: Inject creative rules as user message → forced submit_creative_plan
 *
 * Total: 2 LLM calls (was 4-5 before).
 */
export async function generateCampaignPlan(brief, researchReport, instructions, onProgress) {
  onProgress?.({ step: 'computing', detail: '预算分配 & 关键词 & 受众定向' });
  const budgetData = computeBudgetAllocation(brief, researchReport);
  const keywordData = computeKeywords(brief, researchReport);
  const audienceData = computeAudienceSegments(brief, researchReport);

  const systemPrompt = instructions
    ? `${STRATEGY_SYSTEM_PROMPT}\n\n═══ 额外指令 ═══\n${instructions}`
    : STRATEGY_SYSTEM_PROMPT;

  // ── Call 1: Strategy (forced submit) ─────────────────────────────────
  const messages = [{
    role: 'user',
    content: `Generate a complete media plan and call submit_media_plan.

CAMPAIGN BRIEF:
${JSON.stringify(brief)}

MARKET RESEARCH:
${JSON.stringify(researchReport)}

PRE-COMPUTED DATA:

BUDGET ALLOCATION:
${JSON.stringify(budgetData)}

KEYWORDS:
${JSON.stringify(keywordData)}

AUDIENCE SEGMENTS:
${JSON.stringify(audienceData)}`,
  }];

  onProgress?.({ step: 'generating_strategy', detail: '生成媒体投放方案' });
  const strategyResponse = await anthropic.messages.stream({
    model: MODELS.HAIKU,
    max_tokens: 16384,
    system: systemPrompt,
    messages,
    tools: [SUBMIT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_media_plan' },
  }).finalMessage();

  const submitBlock = strategyResponse.content.find(c => c.type === 'tool_use' && c.name === 'submit_media_plan');
  if (!submitBlock) {
    console.error('[strategy] No tool_use block. Response content types:', strategyResponse.content.map(c => c.type), 'stop_reason:', strategyResponse.stop_reason);
    throw new Error('Strategy agent did not produce a media plan');
  }
  let mediaPlan;
  try {
    mediaPlan = validateAndNestMediaPlan(submitBlock.input);
  } catch (valErr) {
    onProgress?.({ step: 'strategy_validation_failed', detail: `方案校验失败: ${valErr.message}` });
    throw valErr;
  }
  onProgress?.({ step: 'strategy_done', detail: `方案已生成：${mediaPlan.platforms?.length || 0} 个平台` });

  return mediaPlan;
}

// ══════════════════════════════════════════════════════════════════════════
// Parallel Strategy: region × funnel stage
// ══════════════════════════════════════════════════════════════════════════

const FUNNEL_STAGES = [
  { key: 'awareness',     label: 'Awareness / Reach',          budget_pct: 0.20 },
  { key: 'consideration', label: 'Consideration / Engagement',  budget_pct: 0.55 },
  { key: 'conversion',    label: 'Conversion / Retargeting',    budget_pct: 0.25 },
];

// ── Strategy Planner: LLM decides optimal dimensions before parallel generation ──

const STRATEGY_PLANNER_PROMPT = `你是资深数字广告投放策略师。根据预算和投放需求，决定最优的 campaign 矩阵维度。

## 平台最低日预算参考
- Meta (Facebook/Instagram): $5/天/campaign
- Google (Search/Display): $10/天/campaign
- TikTok: $5/天/campaign
- LinkedIn: $10/天/campaign
- Reddit: $5/天/campaign

## 漏斗阶段选项
- 完整漏斗 (3 stages): awareness(20%) + consideration(55%) + conversion(25%) — 适合日预算 ≥$30/平台/区域
- 双阶段 (2 stages): consideration(75%) + conversion(25%) — 适合日预算 $15-30/平台/区域
- 单阶段 (1 stage): full_funnel(100%) — 适合日预算 <$15/平台/区域

## 决策规则
1. 计算 日预算 = total_budget / duration_days
2. **硬约束**：每个 campaign (cell = 1 platform × 1 region × 1 stage) 的日预算必须 ≥ 该平台最低日预算。不满足就必须继续裁剪维度，绝不允许低于平台最低预算投放
3. 如果预算不足以覆盖所有 platform × region × stage 组合，按优先级裁剪：
   - 先减 funnel stages（3→2→1）
   - 再减 regions（合并或保留 ROI 最高的区域）
   - 再减 platforms（保留 fit score 最高的平台，优先裁剪其他平台）
   - 如果只剩 1 platform × 1 region × 1 stage 仍不满足最低预算，保留该配置但在 reasoning 中说明预算不足
4. Meta 是当前唯一支持自动执行投放的平台，当用户选择了 Meta 时必须保留，裁剪平台时优先裁剪其他平台
5. 输出你推荐的实际维度，以及每个平台的预算分配百分比（加总 = 100）`;

const STRATEGY_PLANNER_TOOL = {
  name: 'submit_plan_dimensions',
  description: 'Submit the recommended campaign matrix dimensions.',
  input_schema: {
    type: 'object',
    required: ['platforms', 'regions', 'funnel_stages', 'reasoning'],
    properties: {
      platforms: {
        type: 'array',
        items: {
          type: 'object',
          required: ['platform', 'budget_pct'],
          properties: {
            platform: { type: 'string' },
            budget_pct: { type: 'number', description: 'Budget percentage for this platform, all must sum to 100' },
          },
        },
      },
      regions: { type: 'array', items: { type: 'string' }, description: 'Regions to target (subset or all of requested regions)' },
      funnel_stages: {
        type: 'array',
        items: {
          type: 'object',
          required: ['key', 'label', 'budget_pct'],
          properties: {
            key: { type: 'string', enum: ['awareness', 'consideration', 'conversion', 'full_funnel'] },
            label: { type: 'string' },
            budget_pct: { type: 'number', description: 'Fraction of platform-region budget, all must sum to 1.0' },
          },
        },
      },
      reasoning: { type: 'string', description: 'Brief explanation of dimension decisions' },
    },
  },
};

async function planDimensions(brief, budgetData, regions, researchReport) {
  const response = await anthropic.messages.stream({
    model: MODELS.HAIKU,
    max_tokens: 1024,
    system: STRATEGY_PLANNER_PROMPT,
    messages: [{
      role: 'user',
      content: `请为以下投放需求规划最优 campaign 矩阵维度：

BUDGET: ${budgetData.total_budget} ${budgetData.currency} over ${budgetData.duration_days} days (daily: ${(budgetData.total_budget / budgetData.duration_days).toFixed(2)})
REQUESTED PLATFORMS: ${budgetData.allocations.map(a => `${a.platform}(${a.percentage}%)`).join(', ')}
REQUESTED REGIONS: ${JSON.stringify(regions)}
INDUSTRY: ${brief.industry || 'unknown'}
OBJECTIVES: ${JSON.stringify(brief.objectives || [])}`,
    }],
    tools: [STRATEGY_PLANNER_TOOL],
    tool_choice: { type: 'tool', name: 'submit_plan_dimensions' },
  }).finalMessage();

  const block = response.content.find(c => c.type === 'tool_use' && c.name === 'submit_plan_dimensions');
  if (!block?.input?.platforms?.length) return null;
  return block.input;
}

const SINGLE_CAMPAIGN_SYSTEM_PROMPT = `You are a senior digital advertising strategist. Generate exactly ONE campaign for the specified platform, region, and funnel stage.

## Funnel Stage Guidance
- Awareness: broad targeting, brand storytelling, reach optimization
- Consideration: interest-based targeting, comparison content, engagement optimization
- Conversion/Retargeting: narrow targeting (website visitors, engaged users), urgency messaging, conversion optimization

## Platform-Specific Guidance
- Meta (Facebook/Instagram): image/carousel/video ads, Lookalike audiences, pixel retargeting, minimum $5/day per ad set
- Google (Search/Display/YouTube): keyword-based targeting, responsive search ads, minimum $10/day per ad set
- TikTok: short-form video creatives, interest + behavior targeting, Spark Ads
- LinkedIn: B2B targeting by job title/company/industry, Sponsored Content, minimum $10/day

## Rules
- Generate exactly 1 campaign with 2-3 ad_sets for the specified platform
- Each ad_set must have targeting (with countries, age_range, interests) and 2-3 ads
- Ad copy language must match target market language
- Campaign name format: "{Platform}-{RegionCode}-{Stage}-{Description}" (e.g. "Meta-EU-Awareness-BrandReach")
- Output flat lists: ad_sets and ads as separate arrays. Link ads to ad_sets by ad_set_name.
- You MUST call submit_campaign as your final action`;

// ── Flat single-campaign schema: ad_sets and ads are parallel arrays ──
const SINGLE_CAMPAIGN_TOOL = {
  name: 'submit_campaign',
  description: 'Submit a single campaign. Use ad_set_name to link ads to their ad_set.',
  input_schema: {
    type: 'object',
    required: ['name', 'objective', 'daily_budget', 'ad_sets', 'ads'],
    properties: {
      name: { type: 'string' },
      objective: { type: 'string', enum: ['lead_gen', 'traffic', 'awareness', 'conversions', 'engagement', 'video_views', 'app_installs', 'reach', 'messages'], description: 'Use exactly these values. Do NOT use "lead_generation" — use "lead_gen" instead.' },
      daily_budget: { type: 'number' },
      ad_sets: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'targeting', 'optimization_goal'],
          properties: {
            name: { type: 'string' },
            targeting: {
              type: 'object',
              required: ['countries'],
              properties: {
                countries: { type: 'array', items: { type: 'string' }, description: 'Target country names or ISO codes, e.g. ["UAE"] or ["AE"]. REQUIRED for every ad_set.' },
                age_range: { type: 'array', items: { type: 'number' }, description: '[min_age, max_age]' },
                interests: { type: 'array', items: { type: 'string' } },
                gender: { type: 'string', enum: ['all', 'male', 'female'] },
              },
            },
            optimization_goal: { type: 'string' },
          },
        },
      },
      ads: {
        type: 'array',
        items: {
          type: 'object',
          required: ['ad_set_name', 'name', 'format', 'primary_text', 'headline', 'description', 'cta'],
          properties: {
            ad_set_name: { type: 'string', description: 'Must match an ad_set name above' },
            name: { type: 'string' },
            format: { type: 'string', enum: ['image'] },
            primary_text: { type: 'string' },
            headline: { type: 'string' },
            description: { type: 'string' },
            cta: { type: 'string', enum: ['Learn More', 'Shop Now', 'Sign Up', 'Contact Us', 'Get Quote', 'Apply Now', 'Download', 'Send WhatsApp', 'Subscribe', 'Book Now'], description: 'Must use exact value from enum. For lead_gen campaigns, do NOT use "Send WhatsApp" — use "Learn More", "Sign Up", or "Apply Now" instead.' },
            media_specs: { type: 'string' },
            suggested_content: { type: 'string', description: 'What the ad image should visually depict, e.g. "Product hero shot on white background with lifestyle context"' },
          },
        },
      },
    },
  },
};

/**
 * Reassemble flat campaign output into nested structure: ad_sets[] → ads[]
 */
function nestCampaign(flat) {
  const adsByAdSet = new Map();
  for (const ad of (flat.ads || [])) {
    const key = ad.ad_set_name;
    if (!adsByAdSet.has(key)) adsByAdSet.set(key, []);
    adsByAdSet.get(key).push({
      name: ad.name,
      format: ad.format || 'image',
      primary_text: ad.primary_text,
      headline: ad.headline,
      description: ad.description,
      cta: ad.cta,
      media_requirements: {
        type: ad.format || 'image',
        specs: ad.media_specs || '',
        suggested_content: ad.suggested_content || `${ad.headline}. ${ad.description}`,
      },
    });
  }

  // Normalize objective alias
  const OBJECTIVE_ALIASES = {
    lead_generation: 'lead_gen', LEAD_GENERATION: 'lead_gen',
    OUTCOME_LEADS: 'lead_gen', OUTCOME_TRAFFIC: 'traffic',
    OUTCOME_AWARENESS: 'awareness', OUTCOME_SALES: 'conversions',
  };
  const objective = OBJECTIVE_ALIASES[flat.objective] || flat.objective;
  const LEAD_GEN_OBJECTIVES = new Set(['lead_gen', 'leads']);

  const adSets = (flat.ad_sets || []).map(as => ({
    name: as.name,
    targeting: as.targeting,
    optimization_goal: as.optimization_goal,
    ads: (adsByAdSet.get(as.name) || []).map(ad => {
      // Downgrade WhatsApp CTA in lead_gen campaigns
      if (LEAD_GEN_OBJECTIVES.has(objective) && ad.cta === 'Send WhatsApp') {
        return { ...ad, cta: 'Learn More' };
      }
      return ad;
    }),
  }));

  return { name: flat.name, objective, daily_budget: flat.daily_budget, ad_sets: adSets };
}

/**
 * Normalize LLM output: if ads are nested inside ad_sets, flatten them out.
 * Haiku sometimes nests ads inside ad_sets instead of outputting flat parallel arrays.
 */
function normalizeCellOutput(raw) {
  if (Array.isArray(raw.ads) && raw.ads.length > 0) return raw; // already flat
  // Check if ads are nested inside ad_sets
  const hasNestedAds = Array.isArray(raw.ad_sets) && raw.ad_sets.some(as => Array.isArray(as.ads) && as.ads.length > 0);
  if (!hasNestedAds) return raw;
  // Flatten: extract ads from ad_sets, add ad_set_name link
  const flatAds = [];
  const cleanAdSets = [];
  for (const as of raw.ad_sets) {
    const { ads: nestedAds, ...adSetFields } = as;
    cleanAdSets.push(adSetFields);
    for (const ad of (nestedAds || [])) {
      flatAds.push({ ad_set_name: as.name, ...ad });
    }
  }
  return { ...raw, ad_sets: cleanAdSets, ads: flatAds };
}

/**
 * Validate a flat single-campaign output from a cell. Returns array of error strings (empty = valid).
 * Works on the flat structure (before nesting).
 */
function validateCellCampaign(flat, cellLabel) {
  if (flat._parse_error) return [`JSON parse failed: ${flat._parse_error}`];
  const errors = [];
  if (!flat.name) errors.push('missing name');
  if (!flat.objective) errors.push('missing objective');
  if (typeof flat.daily_budget !== 'number' || flat.daily_budget <= 0) errors.push(`invalid daily_budget: ${flat.daily_budget}`);
  if (!Array.isArray(flat.ad_sets) || flat.ad_sets.length === 0) {
    errors.push('missing or empty ad_sets');
    return errors;
  }
  for (const as of flat.ad_sets) {
    if (!as.name) errors.push('ad_set missing name');
    if (!as.targeting) errors.push(`ad_set ${as.name || '?'} missing targeting`);
  }
  if (!Array.isArray(flat.ads) || flat.ads.length === 0) {
    errors.push('missing or empty ads');
    return errors;
  }
  for (const ad of flat.ads) {
    if (!ad.name) errors.push('ad missing name');
    if (!ad.ad_set_name) errors.push(`ad ${ad.name || '?'} missing ad_set_name`);
    if (!ad.primary_text) errors.push(`ad ${ad.name || '?'} missing primary_text`);
    if (!ad.headline) errors.push(`ad ${ad.name || '?'} missing headline`);
  }
  return errors;
}

/**
 * Generate ONE campaign for a single platform × region × funnel cell.
 * Validates output before returning.
 */
async function generateCellCampaign(
  brief, researchReport, platform, region, funnelStage, cellBudget,
  keywordData, audienceData, instructions, onProgress, cellIndex, totalCells,
) {
  const cellLabel = `${platform}/${region}/${funnelStage.key}`;
  const t0 = Date.now();

  onProgress?.({ step: 'cell_start', detail: `[${cellIndex + 1}/${totalCells}] ${cellLabel} 开始生成` });

  const systemPrompt = instructions
    ? `${SINGLE_CAMPAIGN_SYSTEM_PROMPT}\n\n═══ 额外指令 ═══\n${instructions}`
    : SINGLE_CAMPAIGN_SYSTEM_PROMPT;

  const messages = [{
    role: 'user',
    content: `Generate exactly ONE ${funnelStage.label} campaign on ${platform} for region: ${region}.

PLATFORM: ${platform}
CAMPAIGN BRIEF:
${JSON.stringify({ ...brief, target_countries: [region] })}

BUDGET FOR THIS CAMPAIGN:
${JSON.stringify(cellBudget)}

KEYWORDS:
${JSON.stringify(keywordData)}

AUDIENCE SEGMENTS:
${JSON.stringify(audienceData)}

MARKET RESEARCH:
${JSON.stringify(researchReport)}`,
  }];

  const strategyResp = await anthropic.messages.stream({
    model: MODELS.HAIKU,
    max_tokens: 8192,
    system: systemPrompt,
    messages,
    tools: [SINGLE_CAMPAIGN_TOOL],
    tool_choice: { type: 'tool', name: 'submit_campaign' },
  }).finalMessage();

  const submitBlock = strategyResp.content.find(c => c.type === 'tool_use' && c.name === 'submit_campaign');
  if (!submitBlock) {
    const err = `No tool_use block returned`;
    onProgress?.({ step: 'cell_failed', detail: `[${cellIndex + 1}/${totalCells}] ${cellLabel} 失败: ${err}` });
    throw new Error(`[parallel] ${cellLabel}: ${err}`);
  }

  const flatCampaign = normalizeCellOutput(submitBlock.input);
  const durationMs = Date.now() - t0;

  // Validate flat output
  const validationErrors = validateCellCampaign(flatCampaign, cellLabel);
  if (validationErrors.length > 0) {
    const summary = validationErrors.slice(0, 3).join('; ') + (validationErrors.length > 3 ? `; +${validationErrors.length - 3} more` : '');
    onProgress?.({ step: 'cell_failed', detail: `[${cellIndex + 1}/${totalCells}] ${cellLabel} 校验失败 (${durationMs}ms): ${summary}` });
    throw new Error(`[parallel] ${cellLabel} validation failed: ${summary}`);
  }

  // Reassemble into nested structure for downstream consumers
  const campaign = nestCampaign(flatCampaign);

  const adCount = campaign.ad_sets.reduce((s, as) => s + (as.ads?.length || 0), 0);
  onProgress?.({ step: 'cell_done', detail: `[${cellIndex + 1}/${totalCells}] ${cellLabel} 完成 (${durationMs}ms): ${campaign.name} — ${campaign.ad_sets.length} ad_sets, ${adCount} ads` });
  console.log(`[strategy-parallel] ${cellLabel} done (${durationMs}ms): ${campaign.name} — ${campaign.ad_sets.length} ad_sets, ${adCount} ads`);

  return { campaign };
}

/**
 * Parallel campaign plan generation: splits brief into platform × region × funnel cells,
 * fires all cells concurrently, then merges into a unified media plan.
 *
 * Cell matrix: platform × region × funnel_stage
 * Falls back to sequential generateCampaignPlan when only 1 cell.
 */
export async function generateCampaignPlanParallel(brief, researchReport, instructions, onProgress) {
  const regions = brief.target_countries || ['Global'];

  onProgress?.({ step: 'computing', detail: '预算分配 & 关键词 & 受众定向' });
  const budgetData = computeBudgetAllocation(brief, researchReport);
  const platforms = budgetData.allocations.map(a => a.platform);

  const keywordData = computeKeywords(brief, researchReport);
  const audienceData = computeAudienceSegments(brief, researchReport);

  // ── Strategy Planner: let LLM decide optimal dimensions ─────────────
  onProgress?.({ step: 'planning_dimensions', detail: '分析预算，规划最优投放维度' });
  let activeAllocations = budgetData.allocations;
  let activeRegions = regions;
  let activeStages = FUNNEL_STAGES;

  try {
    const plan = await planDimensions(brief, budgetData, regions, researchReport);
    if (plan) {
      // Apply LLM-planned platforms (keep only those in original allocations)
      const plannedPlatforms = new Set(plan.platforms.map(p => p.platform));
      activeAllocations = budgetData.allocations.filter(a => plannedPlatforms.has(a.platform));
      if (activeAllocations.length > 0) {
        // Recalculate percentages from planner output
        const pctMap = Object.fromEntries(plan.platforms.map(p => [p.platform, p.budget_pct]));
        activeAllocations = activeAllocations.map(a => {
          const pct = pctMap[a.platform] || a.percentage;
          return { ...a, percentage: pct, amount: Math.round(budgetData.total_budget * pct / 100), daily_budget: Math.round((budgetData.total_budget / budgetData.duration_days) * pct / 100) };
        });
      } else {
        activeAllocations = budgetData.allocations; // fallback
      }

      // Apply LLM-planned regions (keep only those in original regions)
      if (plan.regions?.length) {
        const plannedRegions = plan.regions.filter(r => regions.includes(r));
        if (plannedRegions.length > 0) activeRegions = plannedRegions;
      }

      // Apply LLM-planned funnel stages
      if (plan.funnel_stages?.length) {
        activeStages = plan.funnel_stages.map(s => ({
          key: s.key,
          label: s.label,
          budget_pct: s.budget_pct,
        }));
      }

      console.log(`[strategy-parallel] Planner: ${activeAllocations.map(a => a.platform).join('+')} × ${activeRegions.length}r × ${activeStages.length}f — ${plan.reasoning}`);
      onProgress?.({ step: 'dimensions_planned', detail: plan.reasoning });
    }
  } catch (err) {
    console.warn(`[strategy-parallel] Planner failed, using full dimensions:`, err.message);
  }

  // ── Budget guardrail: ensure every cell meets platform minimum daily budget ──
  const PLATFORM_MIN_DAILY = { meta: 5, google: 10, tiktok: 5, linkedin: 10, reddit: 5 };
  const DEFAULT_MIN_DAILY = 5;
  const totalDaily = budgetData.total_budget / budgetData.duration_days;

  function lowestCellDaily() {
    // Simulate cell budget for current dimensions
    let min = Infinity;
    for (const alloc of activeAllocations) {
      const platformDaily = totalDaily * (alloc.percentage / 100) / activeRegions.length;
      for (const stage of activeStages) {
        const cellDaily = platformDaily * stage.budget_pct;
        const minRequired = PLATFORM_MIN_DAILY[alloc.platform] || DEFAULT_MIN_DAILY;
        if (cellDaily < minRequired) min = Math.min(min, cellDaily / minRequired);
      }
    }
    return min; // ratio: <1 means under minimum
  }

  // Prune until all cells meet minimum, or dimensions are at minimum
  if (lowestCellDaily() < 1) {
    // Step 1: collapse funnel stages
    if (activeStages.length > 1) {
      activeStages = [{ key: 'full_funnel', label: 'Full Funnel', budget_pct: 1.0 }];
    }
    // Step 2: reduce regions
    while (lowestCellDaily() < 1 && activeRegions.length > 1) {
      activeRegions = activeRegions.slice(0, -1);
    }
    // Step 3: reduce platforms (keep meta if present)
    while (lowestCellDaily() < 1 && activeAllocations.length > 1) {
      const hasMeta = activeAllocations.some(a => a.platform === 'meta');
      // Drop last non-meta platform, or last if no meta
      const dropIdx = hasMeta
        ? activeAllocations.findLastIndex(a => a.platform !== 'meta')
        : activeAllocations.length - 1;
      if (dropIdx < 0) break;
      activeAllocations = activeAllocations.filter((_, i) => i !== dropIdx);
      // Redistribute percentages
      const totalPct = activeAllocations.reduce((s, a) => s + a.percentage, 0);
      activeAllocations = activeAllocations.map(a => ({
        ...a,
        percentage: Math.round((a.percentage / totalPct) * 100),
      }));
    }

    console.log(`[strategy-parallel] Budget guardrail: pruned to ${activeAllocations.map(a => a.platform).join('+')} × ${activeRegions.length}r × ${activeStages.length}f`);
    onProgress?.({
      step: 'budget_guardrail',
      detail: `预算兜底：${activeAllocations.map(a => a.platform).join('+')} × ${activeRegions.length} 区域 × ${activeStages.length} 阶段`,
    });
  }

  // Build cell matrix: platform × region × funnel stage
  const cells = [];
  for (const alloc of activeAllocations) {
    const platformBudgetShare = alloc.percentage / 100;
    const regionBudgetShare = platformBudgetShare / activeRegions.length;
    for (const region of activeRegions) {
      for (const stage of activeStages) {
        const cellTotal = budgetData.total_budget * regionBudgetShare * stage.budget_pct;
        const cellDaily = cellTotal / budgetData.duration_days;
        cells.push({
          platform: alloc.platform,
          region,
          stage,
          budget: {
            total: parseFloat(cellTotal.toFixed(2)),
            daily: parseFloat(cellDaily.toFixed(2)),
            currency: budgetData.currency,
            duration_days: budgetData.duration_days,
          },
        });
      }
    }
  }

  const totalCells = cells.length;
  onProgress?.({
    step: 'generating_strategy',
    detail: `并行生成 ${totalCells} 个 campaign（${activeAllocations.length} 平台 × ${activeRegions.length} 区域 × ${activeStages.length} 漏斗阶段）`,
    cells: cells.map(c => ({ platform: c.platform, region: c.region, stage: c.stage.key, budget: c.budget })),
  });
  console.log(`[strategy-parallel] Launching ${totalCells} parallel cells: ${cells.map(c => `${c.platform}/${c.region}/${c.stage.key}`).join(', ')}`);

  // Fire all cells in parallel
  const t0 = Date.now();
  const results = await Promise.allSettled(
    cells.map(({ platform, region, stage, budget }, i) =>
      generateCellCampaign(
        brief, researchReport, platform, region, stage, budget,
        keywordData, audienceData, instructions, onProgress, i, totalCells,
      )
    )
  );

  // Collect results
  const succeeded = [];
  const failed = [];
  results.forEach((r, i) => {
    const cellLabel = `${cells[i].platform}/${cells[i].region}/${cells[i].stage.key}`;
    if (r.status === 'fulfilled') {
      succeeded.push({ ...r.value, cell: cells[i] });
    } else {
      failed.push({ cell: cells[i], label: cellLabel, reason: r.reason?.message || String(r.reason) });
    }
  });

  if (failed.length) {
    console.warn(`[strategy-parallel] ${failed.length}/${totalCells} cells failed:`,
      failed.map(f => `${f.label}: ${f.reason}`));
    onProgress?.({
      step: 'cells_partial_failure',
      detail: `${failed.length}/${totalCells} cells 失败: ${failed.map(f => f.label).join(', ')}`,
      failed: failed.map(f => ({ label: f.label, reason: f.reason })),
    });
  }
  if (succeeded.length === 0) {
    throw new Error(`All ${totalCells} parallel strategy cells failed`);
  }

  const elapsedMs = Date.now() - t0;
  console.log(`[strategy-parallel] ${succeeded.length}/${totalCells} cells completed in ${elapsedMs}ms`);

  // Assemble unified media plan — group campaigns by platform
  const platformMap = new Map();
  for (const { campaign, cell } of succeeded) {
    if (!platformMap.has(cell.platform)) {
      const alloc = budgetData.allocations.find(a => a.platform === cell.platform);
      platformMap.set(cell.platform, {
        platform: cell.platform,
        budget_allocation: alloc?.percentage || Math.round(100 / platforms.length),
        budget_amount: alloc?.amount || Math.round(budgetData.total_budget / platforms.length),
        rationale: `${cell.platform} campaigns across ${regions.join(', ')}`,
        campaigns: [],
      });
    }
    platformMap.get(cell.platform).campaigns.push(campaign);
  }

  const mediaPlan = {
    summary: `Parallel plan: ${succeeded.length} campaigns on ${platformMap.size} platforms across ${regions.length} regions, ${budgetData.total_budget} ${budgetData.currency} over ${budgetData.duration_days} days`,
    total_budget: budgetData.total_budget,
    currency: budgetData.currency,
    duration_days: budgetData.duration_days,
    platforms: [...platformMap.values()],
  };

  const totalAds = mediaPlan.platforms.reduce((s, p) => s + p.campaigns.reduce((s2, c) => s2 + c.ad_sets.reduce((s3, as) => s3 + (as.ads?.length || 0), 0), 0), 0);
  onProgress?.({
    step: 'strategy_done',
    detail: `${succeeded.length}/${totalCells} campaigns 生成完成 (${(elapsedMs / 1000).toFixed(1)}s) — ${platformMap.size} 平台, ${succeeded.length} campaigns, ${totalAds} ads${failed.length ? ` | ${failed.length} 失败` : ''}`,
  });

  return mediaPlan;
}

// Standalone exports for direct use
export { computeBudgetAllocation as allocateBudget };
export { computeKeywords as generateKeywords };
export { computeAudienceSegments as generateAudienceSegments };
