#!/usr/bin/env node
/**
 * Benchmark: Strategy agent — current (deep schema) vs flat (2-step schema)
 *
 * Tests only the strategy phase with fixed brief + mock research data.
 * Measures: LLM calls, output tokens, wall time.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load env
const envPath = resolve(process.cwd(), '.env.local');
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('=');
  if (eq > 0) { const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1); }
}

const { generateMediaPlan } = await import('../src/strategy-agent.service.js');

const BRIEF = {
  company_name: '山东华力重工机械有限公司',
  industry: 'agricultural machinery',
  products: [
    { model: 'HL-504 Tractor', category: 'Tractor', key_specs: { horsepower: '50HP', drive: '4WD' }, selling_points: ['Fuel-efficient', '4WD', 'Easy maintenance'] },
    { model: 'HL-1200 Rice Harvester', category: 'Harvester', key_specs: { cutting_width: '2m', grain_tank: '1200L' }, selling_points: ['High efficiency', 'Low grain loss'] },
  ],
  target_countries: ['Tanzania', 'Ethiopia', 'Mozambique'],
  target_audience: { age_range: [28, 60], gender: 'all', interests: ['farming', 'agriculture', 'tractors'] },
  budget_total: 800,
  budget_currency: 'USD',
  campaign_duration_days: 21,
  objectives: ['lead_gen'],
  preferred_platforms: ['meta'],
  website: 'https://hualimachinery.com',
};

const MOCK_RESEARCH = {
  platform_recommendations: [{ platform: 'meta', fit_score: 9, rationale: 'High Facebook penetration in East Africa' }],
  benchmark_metrics: { CPM: 3.5, CPC: 0.8, CTR: 1.2, CPL: 5.5 },
  audience_insights: {
    primary_segments: [{ name: 'Commercial farmers', description: 'Large-scale farming operations' }, { name: 'Agri-dealers', description: 'Equipment dealers and distributors' }],
    content_preferences: 'Video demos and before/after comparisons perform best',
  },
  competitor_ads: { summary: 'Mahindra and TAFE active on Facebook with product showcase ads', common_formats: ['image', 'video'], gaps_and_opportunities: 'No competitors using lead gen forms' },
  keyword_trends: { high_volume: ['tractor price africa', 'farming equipment'], rising: ['chinese tractor africa'] },
  recommendations: ['Focus on Meta lead gen', 'Use Swahili and Portuguese for localization'],
};

console.log('╔══════════════════════════════════════════╗');
console.log('║  Strategy Agent Benchmark                ║');
console.log('╚══════════════════════════════════════════╝\n');

// Run current strategy (single forced call with deep schema)
console.log('=== Current: Deep Schema (forced single call) ===\n');
const t0 = Date.now();
try {
  const plan = await generateMediaPlan(BRIEF, MOCK_RESEARCH);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const campaigns = plan.platforms?.reduce((s, p) => s + (p.campaigns?.length || 0), 0) || 0;
  const adSets = plan.platforms?.reduce((s, p) => p.campaigns?.reduce((s2, c) => s2 + (c.ad_sets?.length || 0), s) || s, 0) || 0;
  const ads = plan.platforms?.reduce((s, p) => p.campaigns?.reduce((s2, c) => c.ad_sets?.reduce((s3, as) => s3 + (as.ads?.length || 0), s2) || s2, s) || s, 0) || 0;
  console.log(`  ✅ ${elapsed}s — ${plan.platforms?.length || 0} platforms, ${campaigns} campaigns, ${adSets} ad_sets, ${ads} ads`);
  console.log(`  Summary: ${plan.summary}`);
} catch (e) {
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  ❌ ${elapsed}s — ${e.message}`);
}

// ── Flat 2-step approach ──────────────────────────────────────────────
console.log('\n=== Flat: 2-Step Schema (structure → ad details) ===\n');

const { anthropic, MODELS } = await import('../src/llm-client.js');

const STEP1_TOOL = {
  name: 'submit_campaign_structure',
  description: 'Submit campaign structure: platforms, campaigns, and ad_sets (no ads yet).',
  input_schema: {
    type: 'object',
    required: ['summary', 'total_budget', 'currency', 'duration_days', 'campaigns'],
    properties: {
      summary: { type: 'string' },
      total_budget: { type: 'number' },
      currency: { type: 'string' },
      duration_days: { type: 'number' },
      campaigns: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'platform', 'objective', 'daily_budget', 'budget_allocation_pct', 'ad_sets'],
          properties: {
            name: { type: 'string' },
            platform: { type: 'string' },
            objective: { type: 'string' },
            daily_budget: { type: 'number' },
            budget_allocation_pct: { type: 'number' },
            rationale: { type: 'string' },
            ad_sets: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'targeting', 'optimization_goal', 'ad_count'],
                properties: {
                  name: { type: 'string' },
                  targeting: { type: 'object' },
                  optimization_goal: { type: 'string' },
                  ad_count: { type: 'integer', description: 'How many ads in this ad_set' },
                },
              },
            },
          },
        },
      },
    },
  },
};

const STEP2_TOOL = {
  name: 'submit_all_ads',
  description: 'Submit all ads for all ad_sets. Each ad must reference its parent ad_set by name.',
  input_schema: {
    type: 'object',
    required: ['ads'],
    properties: {
      ads: {
        type: 'array',
        items: {
          type: 'object',
          required: ['ad_set_name', 'name', 'format', 'primary_text', 'headline', 'cta', 'media_specs', 'suggested_content'],
          properties: {
            ad_set_name: { type: 'string', description: 'Parent ad_set name' },
            name: { type: 'string' },
            format: { type: 'string', enum: ['image'] },
            primary_text: { type: 'string' },
            headline: { type: 'string' },
            description: { type: 'string' },
            cta: { type: 'string' },
            media_specs: { type: 'string', description: 'e.g. "1080x1080"' },
            suggested_content: { type: 'string', description: 'What the image should show' },
          },
        },
      },
    },
  },
};

const { allocateBudget, generateKeywords, generateAudienceSegments } = await import('../src/strategy-agent.service.js');
const budgetData = allocateBudget(BRIEF, MOCK_RESEARCH);
const kwData = generateKeywords(BRIEF, MOCK_RESEARCH);
const segData = generateAudienceSegments(BRIEF, MOCK_RESEARCH);

const FLAT_SYSTEM = `You are a senior digital advertising strategist. Build a media plan in 2 steps.

Step 1: Call submit_campaign_structure with campaigns and ad_sets (no individual ads yet).
Step 2: You'll be asked to fill in the ads.

Rules:
- Budget allocations must sum to 100%
- Daily budgets: minimum $5/day per ad set for Meta
- Prefer platforms from the brief
- Brief summary (1-2 sentences)`;

const t1 = Date.now();
try {
  // Step 1: Campaign structure
  const messages = [{
    role: 'user',
    content: `Create campaign structure and call submit_campaign_structure.

BRIEF: ${JSON.stringify(BRIEF)}
RESEARCH: ${JSON.stringify(MOCK_RESEARCH)}
BUDGET: ${JSON.stringify(budgetData)}
SEGMENTS: ${JSON.stringify(segData)}`,
  }];

  const r1 = await anthropic.messages.create({
    model: MODELS.SONNET,
    max_tokens: 4096,
    system: FLAT_SYSTEM,
    messages,
    tools: [STEP1_TOOL],
    tool_choice: { type: 'tool', name: 'submit_campaign_structure' },
  });
  const step1Time = ((Date.now() - t1) / 1000).toFixed(1);
  const struct = r1.content.find(c => c.type === 'tool_use')?.input;
  const step1Tokens = r1.usage?.output_tokens || 0;
  console.log(`  Step 1: ${step1Time}s, ${step1Tokens} output tokens — ${struct?.campaigns?.length || 0} campaigns, ${struct?.campaigns?.reduce((s, c) => s + (c.ad_sets?.length || 0), 0) || 0} ad_sets`);

  // Step 2: Ad details
  messages.push({ role: 'assistant', content: r1.content });
  messages.push({ role: 'user', content: [
    { type: 'tool_result', tool_use_id: r1.content.find(c => c.type === 'tool_use').id, content: JSON.stringify({ status: 'accepted' }) },
  ]});
  messages.push({ role: 'user', content: `Now fill in all ads for every ad_set. Call submit_all_ads with the complete list. Ad copy should be brief placeholders.` });

  const t2 = Date.now();
  const r2 = await anthropic.messages.create({
    model: MODELS.SONNET,
    max_tokens: 4096,
    system: FLAT_SYSTEM,
    messages,
    tools: [STEP1_TOOL, STEP2_TOOL],
    tool_choice: { type: 'tool', name: 'submit_all_ads' },
  });
  const step2Time = ((Date.now() - t2) / 1000).toFixed(1);
  const adResult = r2.content.find(c => c.type === 'tool_use')?.input;
  const step2Tokens = r2.usage?.output_tokens || 0;
  console.log(`  Step 2: ${step2Time}s, ${step2Tokens} output tokens — ${adResult?.ads?.length || 0} ads`);

  const totalTime = ((Date.now() - t1) / 1000).toFixed(1);
  const totalTokens = step1Tokens + step2Tokens;
  console.log(`\n  Total: ${totalTime}s, ${totalTokens} output tokens`);
} catch (e) {
  const elapsed = ((Date.now() - t1) / 1000).toFixed(1);
  console.log(`  ❌ ${elapsed}s — ${e.message}`);
}

console.log('\n=== Done ===\n');
process.exit(0);
