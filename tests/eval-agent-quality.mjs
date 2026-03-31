/**
 * Agent Quality Eval — Compare Claude vs MiniMax on forced-tool agents
 *
 * Runs each agent with both models using identical golden inputs,
 * then evaluates: schema compliance → business rules → content quality.
 *
 * Usage:
 *   node tests/eval-agent-quality.mjs                  # run all
 *   node tests/eval-agent-quality.mjs --agent strategy  # run one agent
 *   node tests/eval-agent-quality.mjs --runs 3          # multiple runs for variance
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const { anthropic, MODELS } = await import('../src/llm-client.js');

const args = process.argv.slice(2);
const AGENT_FILTER = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : null;
const NUM_RUNS = args.includes('--runs') ? parseInt(args[args.indexOf('--runs') + 1]) : 1;

// ══════════════════════════════════════════════════════════════════════
// Golden Inputs (deterministic, no external API calls)
// ══════════════════════════════════════════════════════════════════════

const GOLDEN_BRIEF = {
  company_name: 'GreenTech Agri',
  industry: 'agricultural_machinery',
  products: [
    { name: 'T-500 Tractor', category: 'tractor', price_range: '$8,000-$12,000' },
    { name: 'H-200 Harvester', category: 'harvester', price_range: '$15,000-$20,000' },
  ],
  target_countries: ['KE', 'TZ', 'ET'],
  budget: 3000,
  duration_days: 30,
  website: 'https://greentech-agri.example.com',
  campaign_goal: 'lead_generation',
  language: 'English',
};

const GOLDEN_RESEARCH = {
  market_overview: 'East Africa agricultural machinery market growing at 12% CAGR. Mechanization rate under 15%.',
  competitor_ads: {
    summary: 'Competitors focus on durability and local dealer networks.',
    top_themes: ['Affordable mechanization', 'After-sale support', 'Fuel efficiency'],
  },
  recommendations: [
    'Target smallholder farmers (2-10 acres)',
    'Emphasize financing/payment plans',
    'Use local language creative for each country',
  ],
  platform_recommendations: [
    { platform: 'meta', reason: 'Highest mobile penetration in East Africa', budget_share: 80 },
    { platform: 'google', reason: 'Search intent for "buy tractor Kenya"', budget_share: 20 },
  ],
};

// ══════════════════════════════════════════════════════════════════════
// Tool Schemas (mirror production definitions)
// ══════════════════════════════════════════════════════════════════════

const STRATEGY_TOOL = {
  name: 'submit_media_plan',
  description: 'Submit the complete media plan.',
  input_schema: {
    type: 'object',
    required: ['total_budget', 'duration_days', 'platforms'],
    properties: {
      total_budget: { type: 'number' },
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

const RESEARCH_TOOL = {
  name: 'submit_report',
  description: 'Submit the market research report.',
  input_schema: {
    type: 'object',
    required: ['market_overview', 'competitor_ads', 'recommendations', 'platform_recommendations'],
    properties: {
      market_overview: { type: 'string' },
      competitor_ads: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          top_themes: { type: 'array', items: { type: 'string' } },
        },
      },
      recommendations: { type: 'array', items: { type: 'string' } },
      platform_recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            platform: { type: 'string' },
            reason: { type: 'string' },
            budget_share: { type: 'number' },
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

const ROUTER_TOOL = {
  name: 'select_agent',
  description: 'Select the best agent to handle this conversation.',
  input_schema: {
    type: 'object',
    required: ['agent_id', 'confidence', 'reason'],
    properties: {
      agent_id: { type: 'string' },
      confidence: { type: 'number' },
      reason: { type: 'string' },
      needs_clarification: { type: 'boolean' },
      clarification_message: { type: 'string' },
    },
  },
};

// ══════════════════════════════════════════════════════════════════════
// Evaluators
// ══════════════════════════════════════════════════════════════════════

/**
 * Layer 1: Schema compliance (hard fail)
 */
function evalSchema(result, requiredFields) {
  const issues = [];
  for (const field of requiredFields) {
    const val = getNestedField(result, field);
    if (val === undefined || val === null) {
      issues.push(`missing: ${field}`);
    }
  }
  return { pass: issues.length === 0, issues };
}

function getNestedField(obj, path) {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    if (part === '[]') {
      // Dive into first array element
      current = Array.isArray(current) ? current[0] : undefined;
    } else {
      current = current[part];
    }
  }
  return current;
}

/**
 * Layer 2: Business rule checks
 */
function evalStrategyRules(plan) {
  const issues = [];
  const meta = plan.platforms?.find(p => p.platform?.toLowerCase() === 'meta');

  // Budget coherence
  if (plan.total_budget && plan.total_budget !== GOLDEN_BRIEF.budget) {
    issues.push(`total_budget ${plan.total_budget} != brief ${GOLDEN_BRIEF.budget}`);
  }
  if (plan.duration_days && plan.duration_days !== GOLDEN_BRIEF.duration_days) {
    issues.push(`duration_days ${plan.duration_days} != brief ${GOLDEN_BRIEF.duration_days}`);
  }

  // Budget allocation sums
  const totalAlloc = (plan.platforms || []).reduce((s, p) => s + (p.budget_allocation || 0), 0);
  if (Math.abs(totalAlloc - 100) > 5) {
    issues.push(`budget_allocation sums to ${totalAlloc}%, expected ~100%`);
  }

  // Campaign count — should have campaigns for target countries
  if (meta?.campaigns?.length < 2) {
    issues.push(`only ${meta?.campaigns?.length || 0} meta campaigns, expected >= 2 for 3 countries`);
  }

  // Daily budget check — campaigns shouldn't exceed total / duration
  const maxDaily = GOLDEN_BRIEF.budget / GOLDEN_BRIEF.duration_days;
  for (const c of meta?.campaigns || []) {
    if (c.daily_budget > maxDaily * 1.5) {
      issues.push(`campaign "${c.name}" daily_budget $${c.daily_budget} exceeds max ~$${maxDaily.toFixed(0)}`);
    }
  }

  // Targeting — should use ISO country codes
  for (const c of meta?.campaigns || []) {
    for (const as of c.ad_sets || []) {
      const countries = as.targeting?.countries || [];
      const invalidCodes = countries.filter(c => !['KE', 'TZ', 'ET', 'UG', 'RW'].includes(c));
      if (invalidCodes.length) {
        issues.push(`ad_set "${as.name}" has unexpected country codes: ${invalidCodes.join(', ')}`);
      }
    }
  }

  return { pass: issues.length === 0, issues, score: Math.max(0, 100 - issues.length * 20) };
}

function evalResearchRules(report) {
  const issues = [];
  if (!report.market_overview || report.market_overview.length < 50) {
    issues.push('market_overview too short (< 50 chars)');
  }
  if (!report.recommendations?.length || report.recommendations.length < 2) {
    issues.push(`only ${report.recommendations?.length || 0} recommendations, expected >= 2`);
  }
  if (!report.platform_recommendations?.length) {
    issues.push('no platform_recommendations');
  }
  const budgetShares = (report.platform_recommendations || []).map(p => p.budget_share || 0);
  const totalShare = budgetShares.reduce((s, v) => s + v, 0);
  if (totalShare > 0 && Math.abs(totalShare - 100) > 10) {
    issues.push(`platform budget_shares sum to ${totalShare}%, expected ~100%`);
  }
  return { pass: issues.length === 0, issues, score: Math.max(0, 100 - issues.length * 25) };
}

function evalCreativePlanRules(plan) {
  const issues = [];
  const tasks = plan.creative_tasks || [];
  if (tasks.length < 2) {
    issues.push(`only ${tasks.length} creative tasks, expected >= 2`);
  }
  for (const t of tasks) {
    if (!t.image_prompt || t.image_prompt.length < 30) {
      issues.push(`task "${t.task_id}" image_prompt too short`);
    }
    if (!t.copy?.headline) {
      issues.push(`task "${t.task_id}" missing copy.headline`);
    }
  }
  // Check market coverage
  const markets = new Set(tasks.map(t => t.target_market));
  if (markets.size < 2) {
    issues.push(`only covers ${markets.size} market(s), expected >= 2`);
  }
  return { pass: issues.length === 0, issues, score: Math.max(0, 100 - issues.length * 20) };
}

function evalRouterRules(result) {
  const issues = [];
  if (typeof result.confidence !== 'number' || result.confidence < 0 || result.confidence > 1) {
    issues.push(`confidence ${result.confidence} should be 0-1`);
  }
  if (!result.reason || result.reason.length < 10) {
    issues.push('reason too short');
  }
  return { pass: issues.length === 0, issues, score: Math.max(0, 100 - issues.length * 25) };
}

// ══════════════════════════════════════════════════════════════════════
// Agent Test Definitions
// ══════════════════════════════════════════════════════════════════════

const AGENTS = {
  research: {
    name: 'Research Agent',
    call: (model) => anthropic.messages.create({
      model,
      max_tokens: 8192,
      system: 'You are a market research analyst. Analyze the given data and submit a comprehensive research report.',
      messages: [{
        role: 'user',
        content: `Conduct market research for this campaign brief and submit your report.

CAMPAIGN BRIEF:
${JSON.stringify(GOLDEN_BRIEF)}

=== Meta Ad Library Results ===
[{"page_name":"John Deere Africa","body":"Powerful tractors for African farms","title":"JD 5E Series"},
 {"page_name":"TAFE Motors","body":"Affordable farming solutions","title":"Eicher 380"}]

=== Google Trends Results ===
{"keywords":["tractor Kenya","farming equipment Tanzania"],"trend":"rising","interest_over_time":[{"date":"2024-01","value":65},{"date":"2024-06","value":82}]}

Analyze the brief and external data above, then call submit_report with your complete research report.`,
      }],
      tools: [RESEARCH_TOOL],
      tool_choice: { type: 'tool', name: 'submit_report' },
    }),
    extract: (r) => r.content.find(b => b.type === 'tool_use' && b.name === 'submit_report')?.input,
    schemaFields: ['market_overview', 'competitor_ads', 'competitor_ads.summary', 'recommendations', 'platform_recommendations'],
    evalRules: evalResearchRules,
  },

  strategy: {
    name: 'Strategy Agent',
    call: (model) => anthropic.messages.create({
      model,
      max_tokens: 8192,
      system: `You are a media planning expert. Generate a complete Meta Ads media plan.
Rules:
- total_budget must match the brief budget
- duration_days must match the brief
- budget_allocation across platforms must sum to 100%
- One campaign per country — never mix countries
- Objective: OUTCOME_LEADS for lead generation goals
- daily_budget in dollars (not cents)
- targeting must use ISO 2-letter country codes`,
      messages: [{
        role: 'user',
        content: `Generate a complete media plan and call submit_media_plan.

CAMPAIGN BRIEF:
${JSON.stringify(GOLDEN_BRIEF)}

MARKET RESEARCH:
${JSON.stringify(GOLDEN_RESEARCH)}`,
      }],
      tools: [STRATEGY_TOOL],
      tool_choice: { type: 'tool', name: 'submit_media_plan' },
    }),
    extract: (r) => r.content.find(b => b.type === 'tool_use' && b.name === 'submit_media_plan')?.input,
    schemaFields: ['total_budget', 'duration_days', 'platforms'],
    evalRules: evalStrategyRules,
  },

  creative_plan: {
    name: 'Creative Plan Agent',
    call: (model) => anthropic.messages.create({
      model,
      max_tokens: 8192,
      system: `You are a creative director. Generate creative production tasks for ad campaigns.
Each task needs: task_id, target_market, creative_type, concept, copy (headline/body/cta), image_prompt (English, descriptive, suitable for AI image generation), and linked_ads.`,
      messages: [{
        role: 'user',
        content: `Create creative production tasks for these campaigns:

BRAND & PRODUCTS:
${JSON.stringify({ company: GOLDEN_BRIEF.company_name, products: GOLDEN_BRIEF.products })}

TARGET MARKETS: Kenya, Tanzania, Ethiopia

AD PLACEMENTS:
- Kenya Lead Gen Campaign: 1 ad set, 2 image ads
- Tanzania Traffic Campaign: 1 ad set, 2 image ads

Generate at least 3 creative tasks covering different markets and strategies. Call submit_creative_plan.`,
      }],
      tools: [CREATIVE_PLAN_TOOL],
      tool_choice: { type: 'tool', name: 'submit_creative_plan' },
    }),
    extract: (r) => r.content.find(b => b.type === 'tool_use' && b.name === 'submit_creative_plan')?.input,
    schemaFields: ['creative_tasks'],
    evalRules: evalCreativePlanRules,
  },

};

// ══════════════════════════════════════════════════════════════════════
// Runner
// ══════════════════════════════════════════════════════════════════════

const COMPARE_MODELS = [
  { key: 'minimax', model: MODELS.MINIMAX, label: 'MiniMax M2.7' },
  { key: 'claude', model: MODELS.SONNET, label: 'Claude Sonnet' },
];

async function runAgentEval(agentKey, agentDef) {
  const results = {};

  for (const { key: modelKey, model, label } of COMPARE_MODELS) {
    const runs = [];

    for (let i = 0; i < NUM_RUNS; i++) {
      const t0 = Date.now();
      try {
        const response = await agentDef.call(model);
        const output = agentDef.extract(response);
        const durationMs = Date.now() - t0;

        if (!output) {
          runs.push({ success: false, error: 'No tool_use output', durationMs });
          continue;
        }

        // Layer 1: Schema
        const schema = evalSchema(output, agentDef.schemaFields);

        // Layer 2: Business rules
        const rules = agentDef.evalRules(output);

        // Layer 3: Extra checks (e.g., router correctness)
        let extra = { pass: true };
        if (agentDef.extraCheck) extra = agentDef.extraCheck(output);

        const tokens = {
          input: response.usage?.input_tokens || 0,
          output: response.usage?.output_tokens || 0,
        };

        runs.push({
          success: true,
          schema,
          rules,
          extra,
          tokens,
          durationMs,
          output,
        });
      } catch (err) {
        runs.push({ success: false, error: err.message, durationMs: Date.now() - t0 });
      }
    }

    results[modelKey] = { label, runs };
  }

  return results;
}

function printAgentResults(agentKey, agentDef, results) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ${agentDef.name} (${agentKey})`);
  console.log(`${'═'.repeat(70)}`);

  for (const [modelKey, { label, runs }] of Object.entries(results)) {
    console.log(`\n  ── ${label} ──`);

    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      const runLabel = NUM_RUNS > 1 ? ` [run ${i + 1}]` : '';

      if (!r.success) {
        console.log(`  ${runLabel} ❌ FAILED: ${r.error} (${r.durationMs}ms)`);
        continue;
      }

      const schemaIcon = r.schema.pass ? '✅' : '❌';
      const rulesIcon = r.rules.pass ? '✅' : '⚠️';
      const extraIcon = r.extra.pass ? '✅' : '❌';

      console.log(`  ${runLabel} ${schemaIcon} Schema | ${rulesIcon} Rules (${r.rules.score}/100) | ${extraIcon} Extra | ${r.tokens.input}+${r.tokens.output} tok | ${r.durationMs}ms`);

      if (!r.schema.pass) {
        for (const issue of r.schema.issues) console.log(`      schema: ${issue}`);
        console.log(`      actual top-level keys: ${Object.keys(r.output || {}).join(', ')}`);
        console.log(`      output preview: ${JSON.stringify(r.output).slice(0, 300)}`);
      }
      if (!r.rules.pass) {
        for (const issue of r.rules.issues) console.log(`      rule: ${issue}`);
      }
      if (!r.extra.pass) {
        console.log(`      extra: ${r.extra.issue}`);
      }
    }
  }

  // Side-by-side comparison
  const mm = results.minimax?.runs?.[0];
  const cl = results.claude?.runs?.[0];
  if (mm?.success && cl?.success) {
    console.log(`\n  ── Comparison ──`);
    console.log(`  ${''.padEnd(20)} ${'MiniMax'.padEnd(15)} ${'Claude'.padEnd(15)}`);
    console.log(`  ${'Schema'.padEnd(20)} ${(mm.schema.pass ? 'PASS' : 'FAIL').padEnd(15)} ${(cl.schema.pass ? 'PASS' : 'FAIL').padEnd(15)}`);
    console.log(`  ${'Rules Score'.padEnd(20)} ${String(mm.rules.score).padEnd(15)} ${String(cl.rules.score).padEnd(15)}`);
    console.log(`  ${'Tokens (in+out)'.padEnd(20)} ${`${mm.tokens.input}+${mm.tokens.output}`.padEnd(15)} ${`${cl.tokens.input}+${cl.tokens.output}`.padEnd(15)}`);
    console.log(`  ${'Latency'.padEnd(20)} ${`${mm.durationMs}ms`.padEnd(15)} ${`${cl.durationMs}ms`.padEnd(15)}`);

    // Cost estimate (rough $/1M tokens)
    const mmCost = (mm.tokens.input * 0.3 + mm.tokens.output * 1.2) / 1_000_000;
    const clCost = (cl.tokens.input * 3 + cl.tokens.output * 15) / 1_000_000;
    console.log(`  ${'Est. Cost'.padEnd(20)} ${`$${mmCost.toFixed(5)}`.padEnd(15)} ${`$${clCost.toFixed(5)}`.padEnd(15)}`);
    if (clCost > 0) {
      console.log(`  ${'Cost Ratio'.padEnd(20)} ${`${(mmCost / clCost * 100).toFixed(1)}%`.padEnd(15)} ${'100%'.padEnd(15)}`);
    }
  }
}

async function main() {
  console.log(`\nAgent Quality Eval`);
  console.log(`Models: ${COMPARE_MODELS.map(m => m.label).join(' vs ')}`);
  console.log(`Runs per model: ${NUM_RUNS}`);

  const agentEntries = Object.entries(AGENTS).filter(([k]) => !AGENT_FILTER || k === AGENT_FILTER);

  if (agentEntries.length === 0) {
    console.error(`No agent matching "${AGENT_FILTER}". Available: ${Object.keys(AGENTS).join(', ')}`);
    process.exit(1);
  }

  const allResults = {};
  for (const [key, def] of agentEntries) {
    console.log(`\nRunning ${def.name}...`);
    allResults[key] = await runAgentEval(key, def);
    printAgentResults(key, def, allResults[key]);
  }

  // Final summary
  console.log(`\n${'═'.repeat(70)}`);
  console.log('  FINAL SUMMARY');
  console.log(`${'═'.repeat(70)}`);
  console.log(`  ${'Agent'.padEnd(20)} ${'MiniMax'.padEnd(20)} ${'Claude'.padEnd(20)}`);

  for (const [key, results] of Object.entries(allResults)) {
    const mm = results.minimax?.runs?.[0];
    const cl = results.claude?.runs?.[0];
    const mmStatus = !mm?.success ? 'FAIL' : `${mm.schema.pass ? '✅' : '❌'}S ${mm.rules.score}pt`;
    const clStatus = !cl?.success ? 'FAIL' : `${cl.schema.pass ? '✅' : '❌'}S ${cl.rules.score}pt`;
    console.log(`  ${key.padEnd(20)} ${mmStatus.padEnd(20)} ${clStatus.padEnd(20)}`);
  }
}

main().catch(console.error);
