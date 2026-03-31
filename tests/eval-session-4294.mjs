/**
 * Real-session eval: session 4294c9a7 (BYD Titanium 7, Middle East + Europe)
 * Extracts actual brief + research from DB, runs strategy & creative_plan with both models.
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY);
const { anthropic, MODELS } = await import('../src/llm-client.js');

// ── Load real session data ──────────────────────────────────────────
const SESSION_ID = '4294c9a7-0db5-48e2-a9d5-d06e94937089';
const { data: session } = await supabase.from('orchestrator_sessions').select('*').eq('id', SESSION_ID).single();
const { data: briefRow } = await supabase.from('campaign_briefs').select('*').eq('id', session.brief_id).single();

const brief = briefRow.brief;
const research = session.phase_results.research;

console.log(`Session: ${SESSION_ID}`);
console.log(`Brand: ${brief.company_name} — ${brief.products?.[0]?.name}`);
console.log(`Budget: ${brief.budget_currency} ${brief.budget_total?.toLocaleString()}`);
console.log(`Countries: ${brief.target_countries?.join(', ')}`);
console.log(`Duration: ${brief.campaign_duration_days} days`);

// ── Tool schemas (from production code) ─────────────────────────────

// Import actual tool schemas from strategy agent
const strategyMod = await import('../src/strategy-agent.service.js');
// We can't easily extract SUBMIT_TOOL from the module, so replicate the schema
const STRATEGY_TOOL = {
  name: 'submit_media_plan',
  description: 'Submit the complete media plan with campaigns, ad sets, and ads.',
  input_schema: {
    type: 'object',
    required: ['total_budget', 'duration_days', 'platforms'],
    properties: {
      total_budget: { type: 'number' },
      currency: { type: 'string' },
      duration_days: { type: 'number' },
      platforms: {
        type: 'array',
        items: {
          type: 'object',
          required: ['platform', 'budget_allocation', 'campaigns'],
          properties: {
            platform: { type: 'string' },
            budget_allocation: { type: 'number' },
            budget_amount: { type: 'number' },
            rationale: { type: 'string' },
            campaigns: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'objective', 'daily_budget'],
                properties: {
                  name: { type: 'string' },
                  objective: { type: 'string' },
                  daily_budget: { type: 'number' },
                  ad_sets: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        targeting: {
                          type: 'object',
                          properties: {
                            countries: { type: 'array', items: { type: 'string' } },
                            age_range: { type: 'array', items: { type: 'number' } },
                          },
                        },
                        ads: {
                          type: 'array',
                          items: {
                            type: 'object',
                            properties: {
                              name: { type: 'string' },
                              headline: { type: 'string' },
                              body: { type: 'string' },
                              format: { type: 'string' },
                              cta: { type: 'string' },
                              media_requirements: { type: 'object' },
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
};

const CREATIVE_PLAN_TOOL = {
  name: 'submit_creative_plan',
  description: 'Submit creative production tasks.',
  input_schema: {
    type: 'object',
    required: ['creative_tasks'],
    properties: {
      creative_tasks: {
        type: 'array',
        items: {
          type: 'object',
          required: ['task_id', 'target_market', 'creative_type', 'concept', 'copy', 'image_prompt'],
          properties: {
            task_id: { type: 'string' },
            target_market: { type: 'string' },
            creative_type: { type: 'string' },
            strategy_category: { type: 'string' },
            concept: { type: 'string' },
            copy: {
              type: 'object',
              properties: {
                headline: { type: 'string' },
                body: { type: 'string' },
                cta: { type: 'string' },
              },
            },
            image_prompt: { type: 'string' },
            dimensions: { type: 'string' },
            linked_ads: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  },
};

// ── System prompts (simplified from production) ─────────────────────

const STRATEGY_SYSTEM = `You are a media planning expert. Generate a complete multi-platform media plan.

Rules:
- total_budget must match the brief (${brief.budget_total} ${brief.budget_currency})
- duration_days must match (${brief.campaign_duration_days})
- budget_allocation across platforms must sum to 100%
- One campaign per country — never mix countries in one campaign
- Objective mapping: lead_gen→OUTCOME_LEADS, traffic→OUTCOME_TRAFFIC, awareness→OUTCOME_AWARENESS
- daily_budget = campaign's share of total / duration_days
- targeting: use ISO 2-letter country codes (SA, AE, GB, DE)
- Each campaign needs at least 1 ad_set with targeting and 2 ads
- Ad formats: image, video
- Include rationale for each platform choice`;

const CREATIVE_SYSTEM = `You are a creative director for automotive advertising.
Generate creative production tasks for ad campaigns targeting Middle East and Europe.

Rules:
- Each task must have a unique task_id
- image_prompt must be in English, detailed, suitable for AI image generation (Midjourney-style)
- copy should be localized: Arabic for Middle East, English for UK, German for Germany
- Include at least one task per target market
- Strategy categories: "Tech & Innovation", "Lifestyle & Adventure", "Value & Comparison", "Trust & Heritage"
- link each task to specific ad names from the media plan`;

// ── Evaluators ──────────────────────────────────────────────────────

function evalStrategy(plan) {
  const issues = [];

  // Budget
  if (typeof plan.total_budget !== 'number') issues.push('missing total_budget');
  if (typeof plan.duration_days !== 'number') issues.push('missing duration_days');
  if (!Array.isArray(plan.platforms) || plan.platforms.length === 0) issues.push('missing/empty platforms');

  // Budget allocation
  const totalAlloc = (plan.platforms || []).reduce((s, p) => s + (p.budget_allocation || 0), 0);
  if (Math.abs(totalAlloc - 100) > 5) issues.push(`budget_allocation sums to ${totalAlloc}%, expected ~100%`);

  // Campaign structure
  const metaPlatform = (plan.platforms || []).find(p => p.platform?.toLowerCase().includes('meta'));
  if (!metaPlatform) {
    issues.push('no Meta platform found (required by brief)');
  } else {
    if (!metaPlatform.campaigns?.length) issues.push('Meta platform has no campaigns');
    const countriesCovered = new Set();
    for (const c of metaPlatform.campaigns || []) {
      if (!c.name) issues.push('campaign missing name');
      if (!c.objective) issues.push('campaign missing objective');
      if (typeof c.daily_budget !== 'number') issues.push(`campaign "${c.name}" missing daily_budget`);
      for (const as of c.ad_sets || []) {
        (as.targeting?.countries || []).forEach(co => countriesCovered.add(co));
        if (!as.ads?.length) issues.push(`ad_set "${as.name}" has no ads`);
      }
    }
    // Check country coverage (SA, AE, GB, DE)
    const expected = ['SA', 'AE', 'GB', 'DE'];
    const missing = expected.filter(c => !countriesCovered.has(c));
    if (missing.length) issues.push(`missing country coverage: ${missing.join(', ')}`);
  }

  // Total ad count
  const totalAds = (plan.platforms || []).reduce((s, p) =>
    s + (p.campaigns || []).reduce((s2, c) =>
      s2 + (c.ad_sets || []).reduce((s3, as) => s3 + (as.ads?.length || 0), 0), 0), 0);
  if (totalAds < 4) issues.push(`only ${totalAds} ads total, expected >= 4 for 4 countries`);

  return { pass: issues.length === 0, issues, score: Math.max(0, 100 - issues.length * 10) };
}

function evalCreativePlan(plan, strategyOutput) {
  const issues = [];
  const tasks = plan.creative_tasks || [];

  if (tasks.length < 3) issues.push(`only ${tasks.length} tasks, expected >= 3`);

  for (const t of tasks) {
    if (!t.task_id) issues.push('task missing task_id');
    if (!t.target_market) issues.push(`task ${t.task_id} missing target_market`);
    if (!t.image_prompt || t.image_prompt.length < 30) issues.push(`task ${t.task_id} image_prompt too short`);
    if (!t.copy?.headline) issues.push(`task ${t.task_id} missing copy.headline`);
    if (!t.copy?.cta) issues.push(`task ${t.task_id} missing copy.cta`);
  }

  // Market coverage
  const markets = new Set(tasks.map(t => (t.target_market || '').toLowerCase()));
  const hasMiddleEast = [...markets].some(m => m.includes('middle') || m.includes('saudi') || m.includes('uae') || m.includes('中东'));
  const hasEurope = [...markets].some(m => m.includes('europe') || m.includes('uk') || m.includes('german') || m.includes('欧洲'));
  if (!hasMiddleEast) issues.push('no Middle East market coverage');
  if (!hasEurope) issues.push('no Europe market coverage');

  return { pass: issues.length === 0, issues, score: Math.max(0, 100 - issues.length * 10) };
}

// ── Run eval ────────────────────────────────────────────────────────

const MODELS_TO_TEST = [
  { key: 'minimax', model: MODELS.MINIMAX, label: 'MiniMax M2.7' },
  { key: 'claude', model: MODELS.SONNET, label: 'Claude Sonnet' },
];

async function runStrategyEval(model) {
  const t0 = Date.now();
  const response = await anthropic.messages.create({
    model,
    max_tokens: 8192,
    system: STRATEGY_SYSTEM,
    messages: [{
      role: 'user',
      content: `Generate a complete media plan and call submit_media_plan.

CAMPAIGN BRIEF:
${JSON.stringify(brief)}

MARKET RESEARCH:
${JSON.stringify(research)}`,
    }],
    tools: [STRATEGY_TOOL],
    tool_choice: { type: 'tool', name: 'submit_media_plan' },
  });
  const durationMs = Date.now() - t0;
  const output = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_media_plan')?.input;
  return { output, response, durationMs };
}

async function runCreativePlanEval(model, strategyOutput) {
  const t0 = Date.now();

  // Extract ad placements from strategy output for context
  const adPlacements = [];
  for (const p of strategyOutput?.platforms || []) {
    for (const c of p.campaigns || []) {
      for (const as of c.ad_sets || []) {
        for (const ad of as.ads || []) {
          adPlacements.push({ campaign: c.name, ad_set: as.name, ad_name: ad.name, format: ad.format, headline: ad.headline });
        }
      }
    }
  }

  const response = await anthropic.messages.create({
    model,
    max_tokens: 8192,
    system: CREATIVE_SYSTEM,
    messages: [{
      role: 'user',
      content: `Create creative production tasks for these campaigns.

BRAND & PRODUCTS:
${JSON.stringify({ company: brief.company_name, products: brief.products, differentiation: brief.differentiation })}

TARGET MARKETS: ${brief.target_countries?.join(', ')}
TARGET AUDIENCE: ${JSON.stringify(brief.target_audience)}

AD PLACEMENTS FROM MEDIA PLAN:
${JSON.stringify(adPlacements)}

Generate creative tasks covering all target markets and multiple strategy categories. Call submit_creative_plan.`,
    }],
    tools: [CREATIVE_PLAN_TOOL],
    tool_choice: { type: 'tool', name: 'submit_creative_plan' },
  });
  const durationMs = Date.now() - t0;
  const output = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_creative_plan')?.input;
  return { output, response, durationMs };
}

// ── Main ────────────────────────────────────────────────────────────

console.log(`\n${'═'.repeat(70)}`);
console.log('  STRATEGY AGENT EVAL');
console.log('═'.repeat(70));

const strategyResults = {};
for (const { key, model, label } of MODELS_TO_TEST) {
  console.log(`\nRunning ${label}...`);
  try {
    const { output, response, durationMs } = await runStrategyEval(model);
    if (!output) throw new Error('No tool_use output');
    const eval_ = evalStrategy(output);
    const tokens = { input: response.usage?.input_tokens || 0, output: response.usage?.output_tokens || 0 };
    strategyResults[key] = { output, eval: eval_, tokens, durationMs, label };
    const icon = eval_.pass ? '✅' : '⚠️';
    console.log(`  ${icon} ${label}: ${eval_.score}/100 | ${tokens.input}+${tokens.output} tok | ${durationMs}ms`);
    if (eval_.issues.length) {
      for (const i of eval_.issues) console.log(`    - ${i}`);
    }
    // Summary stats
    const totalCampaigns = (output.platforms || []).reduce((s, p) => s + (p.campaigns?.length || 0), 0);
    const totalAds = (output.platforms || []).reduce((s, p) =>
      s + (p.campaigns || []).reduce((s2, c) =>
        s2 + (c.ad_sets || []).reduce((s3, as) => s3 + (as.ads?.length || 0), 0), 0), 0);
    console.log(`    Platforms: ${output.platforms?.length || 0} | Campaigns: ${totalCampaigns} | Ads: ${totalAds}`);
  } catch (err) {
    console.error(`  ❌ ${label} FAILED: ${err.message}`);
    strategyResults[key] = { error: err.message, label };
  }
}

console.log(`\n${'═'.repeat(70)}`);
console.log('  CREATIVE PLAN AGENT EVAL');
console.log('═'.repeat(70));

// Use MiniMax strategy output for creative plan (since that's the production path now)
const strategyForCreative = strategyResults.minimax?.output || strategyResults.claude?.output;

for (const { key, model, label } of MODELS_TO_TEST) {
  console.log(`\nRunning ${label}...`);
  try {
    const { output, response, durationMs } = await runCreativePlanEval(model, strategyForCreative);
    if (!output) throw new Error('No tool_use output');
    const eval_ = evalCreativePlan(output, strategyForCreative);
    const tokens = { input: response.usage?.input_tokens || 0, output: response.usage?.output_tokens || 0 };
    const icon = eval_.pass ? '✅' : '⚠️';
    console.log(`  ${icon} ${label}: ${eval_.score}/100 | ${tokens.input}+${tokens.output} tok | ${durationMs}ms`);
    if (eval_.issues.length) {
      for (const i of eval_.issues) console.log(`    - ${i}`);
    }
    console.log(`    Tasks: ${output.creative_tasks?.length || 0} | Markets: ${[...new Set(output.creative_tasks?.map(t => t.target_market))].join(', ')}`);
  } catch (err) {
    console.error(`  ❌ ${label} FAILED: ${err.message}`);
  }
}

// ── Cost comparison ─────────────────────────────────────────────────
console.log(`\n${'═'.repeat(70)}`);
console.log('  COST COMPARISON');
console.log('═'.repeat(70));
console.log(`  ${''.padEnd(20)} ${'MiniMax'.padEnd(18)} ${'Claude'.padEnd(18)}`);

for (const agent of ['strategy']) {
  const mm = strategyResults.minimax;
  const cl = strategyResults.claude;
  if (mm?.tokens && cl?.tokens) {
    const mmCost = (mm.tokens.input * 0.3 + mm.tokens.output * 1.2) / 1_000_000;
    const clCost = (cl.tokens.input * 3 + cl.tokens.output * 15) / 1_000_000;
    console.log(`  ${agent.padEnd(20)} $${mmCost.toFixed(5).padEnd(17)} $${clCost.toFixed(5).padEnd(17)}`);
    console.log(`  ${'score'.padEnd(20)} ${String(mm.eval?.score || 'N/A').padEnd(18)} ${String(cl.eval?.score || 'N/A').padEnd(18)}`);
    console.log(`  ${'latency'.padEnd(20)} ${`${mm.durationMs}ms`.padEnd(18)} ${`${cl.durationMs}ms`.padEnd(18)}`);
    console.log(`  ${'cost ratio'.padEnd(20)} ${`${(mmCost / clCost * 100).toFixed(1)}%`.padEnd(18)} ${'100%'.padEnd(18)}`);
  }
}
