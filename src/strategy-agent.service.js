import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL && { baseURL: config.anthropic.baseURL }),
});

const MAX_TOOL_ITERATIONS = 8;

// ── Tool definitions ───────────────────────────────────────────────────

const STRATEGY_TOOLS = [
  {
    name: 'allocate_budget',
    description: 'Calculate budget allocation across platforms based on objectives, target markets, and research insights. Returns recommended allocation percentages and daily budgets per platform.',
    input_schema: {
      type: 'object',
      required: ['total_budget', 'currency', 'duration_days', 'objectives', 'platforms'],
      properties: {
        total_budget: { type: 'number', description: 'Total campaign budget' },
        currency: { type: 'string', description: 'Budget currency (e.g. USD)' },
        duration_days: { type: 'number', description: 'Campaign duration in days' },
        objectives: { type: 'array', items: { type: 'string' }, description: 'Campaign objectives' },
        platforms: { type: 'array', items: { type: 'string' }, description: 'Candidate platforms' },
        platform_fit_scores: {
          type: 'array',
          items: { type: 'object' },
          description: 'Platform fit scores from research (optional)',
        },
      },
    },
  },
  {
    name: 'generate_keywords',
    description: 'Generate keyword lists for Google Ads search campaigns. Returns themed keyword groups with match types and estimated CPC ranges.',
    input_schema: {
      type: 'object',
      required: ['industry', 'products', 'target_countries'],
      properties: {
        industry: { type: 'string' },
        products: { type: 'array', items: { type: 'string' }, description: 'Product names/categories' },
        target_countries: { type: 'array', items: { type: 'string' } },
        trending_keywords: { type: 'array', items: { type: 'string' }, description: 'Trending keywords from research (optional)' },
      },
    },
  },
  {
    name: 'generate_audience_segments',
    description: 'Design audience targeting segments for Meta and TikTok campaigns. Returns named segments with demographic, interest, and behavioral targeting.',
    input_schema: {
      type: 'object',
      required: ['industry', 'target_countries', 'target_audience'],
      properties: {
        industry: { type: 'string' },
        target_countries: { type: 'array', items: { type: 'string' } },
        target_audience: { type: 'object', description: 'Target audience description from brief' },
        audience_insights: { type: 'object', description: 'Audience insights from research (optional)' },
      },
    },
  },
  {
    name: 'submit_media_plan',
    description: 'Submit the final media plan. Call this after generating budget allocation, keywords, and audience segments. The plan should incorporate all gathered data into a complete, executable campaign structure.',
    input_schema: {
      type: 'object',
      required: ['summary', 'total_budget', 'currency', 'duration_days', 'platforms'],
      properties: {
        summary: { type: 'string', description: 'Executive summary of the strategy' },
        total_budget: { type: 'number' },
        currency: { type: 'string' },
        duration_days: { type: 'number' },
        platforms: {
          type: 'array',
          items: {
            type: 'object',
            required: ['platform', 'budget_allocation', 'budget_amount', 'rationale', 'campaigns'],
            properties: {
              platform: { type: 'string', enum: ['meta', 'google', 'tiktok', 'linkedin', 'reddit'] },
              budget_allocation: { type: 'number', description: 'Percentage of total budget' },
              budget_amount: { type: 'number' },
              rationale: { type: 'string' },
              campaigns: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['name', 'objective', 'daily_budget', 'ad_sets'],
                  properties: {
                    name: { type: 'string' },
                    objective: { type: 'string' },
                    daily_budget: { type: 'number' },
                    ad_sets: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['name', 'targeting', 'optimization_goal', 'ads'],
                        properties: {
                          name: { type: 'string' },
                          targeting: { type: 'object' },
                          optimization_goal: { type: 'string' },
                          ads: {
                            type: 'array',
                            items: {
                              type: 'object',
                              required: ['name', 'format', 'primary_text', 'headline', 'description', 'cta'],
                              properties: {
                                name: { type: 'string' },
                                format: { type: 'string', enum: ['image'], description: 'Only image format is currently supported for auto-generation' },
                                primary_text: { type: 'string' },
                                headline: { type: 'string' },
                                description: { type: 'string' },
                                cta: { type: 'string' },
                                media_requirements: {
                                  type: 'object',
                                  required: ['type', 'specs', 'suggested_content'],
                                  properties: {
                                    type: { type: 'string', enum: ['image', 'video'], description: 'Media type' },
                                    specs: { type: 'string', description: 'Dimensions and duration, e.g. "1080x1080" or "1080x1920, 15-30s"' },
                                    suggested_content: { type: 'string', description: 'Description of what the image/video should show' },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
];

const STRATEGY_SYSTEM_PROMPT = `You are a senior digital advertising strategist.

Your job: take a campaign brief and market research report, then build a complete, actionable media plan.

Workflow:
1. Review the brief and research report
2. Call allocate_budget to determine platform budget split
3. Call generate_keywords if Google Ads is in the plan
4. Call generate_audience_segments for Meta/TikTok targeting
5. Synthesize everything into a complete media plan
6. Call submit_media_plan with the final plan

Rules:
- Budget allocations across platforms must sum to 100% (or less if you recommend a reserve)
- Each campaign must have at least one ad_set with targeting and at least one ad
- Ad copy must be platform-appropriate (character limits, tone)
- Daily budgets must be realistic (minimum $5/day per ad set for Meta, $10/day for Google)
- Prefer the platforms suggested in the brief; add others only if research strongly supports them
- You MUST call submit_media_plan as your final action`;

// ── Tool execution ─────────────────────────────────────────────────────

async function executeTool(toolName, toolInput) {
  switch (toolName) {
    case 'allocate_budget':
      return computeBudgetAllocation(toolInput);
    case 'generate_keywords':
      return computeKeywords(toolInput);
    case 'generate_audience_segments':
      return computeAudienceSegments(toolInput);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

/**
 * Budget allocation computation.
 * Uses simple heuristics; Claude will interpret and refine.
 */
function computeBudgetAllocation({ total_budget, currency, duration_days, objectives, platforms, platform_fit_scores }) {
  const daily = total_budget / duration_days;
  const platformCount = platforms.length || 1;

  // Base equal split, adjusted by fit scores if available
  const scores = {};
  for (const p of platforms) {
    const fit = (platform_fit_scores || []).find(f => f.platform === p);
    scores[p] = fit?.fit_score || 5;
  }
  const totalScore = Object.values(scores).reduce((a, b) => a + b, 0);

  const allocations = platforms.map(p => {
    const pct = Math.round((scores[p] / totalScore) * 100);
    return {
      platform: p,
      percentage: pct,
      amount: Math.round(total_budget * pct / 100),
      daily_budget: Math.round(daily * pct / 100),
    };
  });

  return {
    total_budget,
    currency,
    duration_days,
    daily_budget: Math.round(daily),
    allocations,
    note: 'Allocations based on platform fit scores. Adjust based on campaign objectives and market conditions.',
  };
}

/**
 * Keyword generation heuristic — returns structured keyword themes.
 */
function computeKeywords({ industry, products, target_countries, trending_keywords }) {
  const groups = [];

  // Brand/product keywords
  if (products?.length) {
    groups.push({
      theme: 'product',
      match_type: 'phrase',
      keywords: products.map(p => `${p} ${industry || ''}`.trim()),
      negative_keywords: ['DIY', 'repair', 'used', 'second hand'],
    });
  }

  // Industry keywords
  if (industry) {
    groups.push({
      theme: 'industry',
      match_type: 'broad',
      keywords: [`${industry} supplier`, `${industry} wholesale`, `buy ${industry}`],
      negative_keywords: ['jobs', 'salary', 'career'],
    });
  }

  // Trending keywords
  if (trending_keywords?.length) {
    groups.push({
      theme: 'trending',
      match_type: 'phrase',
      keywords: trending_keywords.slice(0, 10),
      negative_keywords: [],
    });
  }

  // Geo keywords
  if (target_countries?.length) {
    groups.push({
      theme: 'geo_intent',
      match_type: 'phrase',
      keywords: target_countries.flatMap(c => products?.map(p => `${p} ${c}`) || [`${industry} ${c}`]),
      negative_keywords: [],
    });
  }

  return { keyword_groups: groups };
}

/**
 * Audience segment generation heuristic.
 */
function computeAudienceSegments({ industry, target_countries, target_audience, audience_insights }) {
  const segments = [];

  // Primary segment from brief
  const primary = {
    name: `${industry} - Primary`,
    platform: 'both',
    targeting: {
      countries: target_countries || [],
      age_range: target_audience?.age_range || [25, 55],
      gender: target_audience?.gender || 'all',
      interests: target_audience?.interests || [industry],
    },
    priority: 'primary',
  };
  segments.push(primary);

  // Lookalike/similar segment
  if (audience_insights?.primary_segments?.length) {
    for (const seg of audience_insights.primary_segments.slice(0, 2)) {
      segments.push({
        name: seg.name || `${industry} - ${seg.description}`,
        platform: 'meta',
        targeting: {
          countries: target_countries || [],
          age_range: target_audience?.age_range || [25, 55],
          gender: 'all',
          interests: [...(target_audience?.interests || []), ...(seg.name ? [seg.name] : [])],
        },
        priority: 'secondary',
      });
    }
  }

  return { segments };
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Generate a media plan using Claude tool_use.
 * Claude calls budget, keyword, and audience tools, then submits the final plan.
 *
 * @param {Object} brief - CampaignBrief
 * @param {Object} researchReport - Output from conductResearch()
 * @returns {Promise<Object>} MediaPlan
 */
export async function generateMediaPlan(brief, researchReport, instructions) {
  const systemPrompt = instructions
    ? `${STRATEGY_SYSTEM_PROMPT}\n\n═══ 额外指令 ═══\n${instructions}`
    : STRATEGY_SYSTEM_PROMPT;

  const messages = [{
    role: 'user',
    content: `Generate a complete media plan. Use the tools to build budget allocation, keywords, and audience segments, then submit the final plan.

CAMPAIGN BRIEF:
${JSON.stringify(brief, null, 2)}

MARKET RESEARCH REPORT:
${JSON.stringify(researchReport, null, 2)}`,
  }];

  let response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 16384,
    system: systemPrompt,
    messages,
    tools: STRATEGY_TOOLS,
    tool_choice: { type: 'auto' },
  });

  // Tool-use loop
  let iterations = 0;
  while (iterations < MAX_TOOL_ITERATIONS) {
    if (response.stop_reason !== 'tool_use') break;
    iterations++;

    const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');

    // Check for submit_media_plan
    const submitBlock = toolUseBlocks.find(t => t.name === 'submit_media_plan');
    if (submitBlock) {
      validateMediaPlan(submitBlock.input);
      return submitBlock.input;
    }

    // Execute all non-submit tools
    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      const result = await executeTool(toolUse.name, toolUse.input);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 16384,
      system: systemPrompt,
      messages,
      tools: STRATEGY_TOOLS,
      tool_choice: { type: 'auto' },
    });
  }

  // Final check
  const finalSubmit = response.content.find(c => c.type === 'tool_use' && c.name === 'submit_media_plan');
  if (finalSubmit) {
    validateMediaPlan(finalSubmit.input);
    return finalSubmit.input;
  }

  // Force submit
  messages.push({ role: 'assistant', content: response.content });
  messages.push({ role: 'user', content: 'Please call submit_media_plan now. Remember: the top-level fields are summary, total_budget, currency, duration_days, and platforms (an array of platform objects). Do NOT nest them inside a wrapper object.' });

  response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 16384,
    system: systemPrompt,
    messages,
    tools: STRATEGY_TOOLS,
    tool_choice: { type: 'tool', name: 'submit_media_plan' },
  });

  const forced = response.content.find(c => c.type === 'tool_use' && c.name === 'submit_media_plan');
  if (forced) {
    validateMediaPlan(forced.input);
    return forced.input;
  }

  throw new Error('Strategy agent did not produce a media plan');
}

/**
 * Basic validation of MediaPlan structure.
 */
function validateMediaPlan(plan) {
  if (!plan.platforms && plan.platform) plan.platforms = Array.isArray(plan.platform) ? plan.platform : [plan.platform];
  if (!plan.platforms || !Array.isArray(plan.platforms)) {
    console.error('[strategy] MediaPlan validation failed. Actual keys:', Object.keys(plan), 'Input:', JSON.stringify(plan).slice(0, 500));
    throw new Error('MediaPlan missing platforms array');
  }
  if (plan.platforms.length === 0) throw new Error('MediaPlan has no platforms');

  for (const platform of plan.platforms) {
    if (!platform.platform) throw new Error('Platform entry missing platform name');
    if (!Array.isArray(platform.campaigns)) throw new Error(`Platform ${platform.platform} missing campaigns array`);
  }

  // Auto-generate summary if missing (model sometimes omits it in large plans)
  if (!plan.summary) {
    const platformNames = plan.platforms.map(p => p.platform).join(', ');
    const totalCampaigns = plan.platforms.reduce((s, p) => s + (p.campaigns?.length || 0), 0);
    plan.summary = `${platformNames} campaign plan: ${totalCampaigns} campaigns, $${plan.total_budget || '?'} ${plan.currency || 'USD'} over ${plan.duration_days || '?'} days`;
  }
}

// Standalone exports for direct use
export { computeBudgetAllocation as allocateBudget };
export { computeKeywords as generateKeywords };
export { computeAudienceSegments as generateAudienceSegments };
