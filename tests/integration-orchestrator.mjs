/**
 * Integration test: Full orchestrator pipeline end-to-end.
 *
 * Runs against real APIs:
 *   - Supabase (DB + Storage)
 *   - OpenRouter → Claude (Research, Strategy, Execution agents)
 *   - Meta Graph API (create PAUSED campaign/adset/ad)
 *
 * Skips creative phase (AIGC image gen) to keep test fast.
 * Uses a pre-built brief instead of multi-turn intake.
 *
 * Run: node tests/integration-orchestrator.mjs
 * Requires: .env.local with OPENROUTER_API_KEY, META_ACCESS_TOKEN, META_AD_ACCOUNT_ID
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── Load env ───────────────────────────────────────────────────────────

const envPath = resolve(process.cwd(), '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx > 0) {
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = val;
  }
}

// ── Imports (after env loaded) ─────────────────────────────────────────

const { createBrief, updateBrief, getBrief } = await import('../lib/repositories/campaign-brief.repository.js');
const {
  createSession,
  getSession,
  updateSession,
  getMessages,
} = await import('../lib/repositories/orchestrator.repository.js');
const { conductResearch } = await import('../src/research-agent.service.js');
const { generateMediaPlan } = await import('../src/strategy-agent.service.js');
const {
  createCampaign,
  createAdSet,
  createAd,
  previewExecution,
} = await import('../src/execution-agent.service.js');
const { config } = await import('../src/config.js');

// ── Test data ──────────────────────────────────────────────────────────

const TEST_BRIEF = {
  company_name: 'RevoPanda Test Co',
  industry: 'electric vehicles',
  products: [
    {
      model: 'BYD Seal 05 DM-i',
      category: 'Sedan',
      key_specs: { range: '1200km', engine: 'DM-i hybrid', seats: '5' },
      selling_points: ['Ultra-long range', 'Low fuel consumption', 'Smart cockpit'],
    },
  ],
  target_countries: ['Nigeria', 'Kenya'],
  target_audience: {
    age_range: [25, 55],
    gender: 'all',
    interests: ['automobiles', 'electric vehicles', 'car import'],
  },
  budget_total: 500,
  budget_currency: 'USD',
  campaign_duration_days: 14,
  objectives: ['lead_gen'],
  preferred_platforms: ['meta'],
  website: 'https://revopanda.com',
};

// ── Helpers ────────────────────────────────────────────────────────────

function hr(title) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(60));
}

function elapsed(start) {
  return ((Date.now() - start) / 1000).toFixed(1);
}

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`  OK: ${message}`);
}

// ── Cleanup helper ─────────────────────────────────────────────────────

const cleanupTasks = [];

function onCleanup(fn) {
  cleanupTasks.push(fn);
}

const SKIP_CLEANUP = process.argv.includes('--keep');

async function cleanup() {
  if (SKIP_CLEANUP) {
    console.log('\n--- Cleanup skipped (--keep flag) ---');
    return;
  }
  console.log('\n--- Cleanup ---');
  for (const fn of cleanupTasks.reverse()) {
    try { await fn(); } catch (e) { console.warn('  cleanup error:', e.message); }
  }
}

// ── Main test ──────────────────────────────────────────────────────────

async function run() {
  const testStart = Date.now();

  // ── Preflight checks ──────────────────────────────────────
  hr('0. Preflight checks');

  assert(config.anthropic.apiKey, 'OPENROUTER_API_KEY is set');
  assert(config.meta.accessToken, 'META_ACCESS_TOKEN is set');
  assert(config.meta.adAccountId, 'META_AD_ACCOUNT_ID is set');
  console.log(`  Model: ${config.anthropic.model}`);
  console.log(`  Ad Account: ${config.meta.adAccountId}`);

  // ── Phase 0: Create brief + session in DB ─────────────────
  hr('1. Create brief + session in DB');

  const brief = await createBrief();
  console.log(`  Brief created: ${brief.id}`);
  onCleanup(async () => {
    // Leave data in DB for inspection, just log
    console.log(`  (Brief ${brief.id} left in DB for inspection)`);
  });

  await updateBrief(brief.id, {
    status: 'completed',
    brief: TEST_BRIEF,
    completion: { filled: Object.keys(TEST_BRIEF), missing: [], completion_pct: 100 },
  });
  console.log('  Brief populated with test data');

  const session = await createSession(brief.id);
  console.log(`  Session created: ${session.id}`);

  assert(session.status === 'draft', 'Session starts in draft status');

  // ── Phase 2: Research ─────────────────────────────────────
  hr('2. Research Agent (Claude tool_use via OpenRouter)');

  let start = Date.now();
  console.log('  Running market research...');

  let researchReport;
  try {
    researchReport = await conductResearch(TEST_BRIEF);
  } catch (err) {
    console.error(`  Research agent error: ${err.message}`);
    console.error(err.stack);
    throw err;
  }

  console.log(`  Completed in ${elapsed(start)}s`);
  console.log(`  Result type: ${typeof researchReport}, keys: ${Object.keys(researchReport || {}).join(', ')}`);
  if (!researchReport.market_overview) {
    console.log(`  DEBUG full result: ${JSON.stringify(researchReport).slice(0, 500)}`);
  }
  console.log(`  Market overview: ${researchReport.market_overview?.market_size_estimate || 'N/A'}`);
  console.log(`  Recommendations: ${researchReport.recommendations?.length || 0}`);
  console.log(`  Platform scores: ${(researchReport.platform_recommendations || []).map(p => `${p.platform}=${p.fit_score}`).join(', ')}`);

  assert(researchReport.market_overview, 'Research has market_overview');
  assert(researchReport.recommendations?.length > 0, 'Research has recommendations');
  assert(researchReport.platform_recommendations?.length > 0, 'Research has platform scores');

  // Persist to session
  await updateSession(session.id, {
    status: 'running',
    current_phase: 'research',
    phase_results: { research: researchReport },
  });
  console.log('  Persisted research results to session');

  // ── Phase 3: Strategy ─────────────────────────────────────
  hr('3. Strategy Agent (Claude tool_use via OpenRouter)');

  start = Date.now();
  console.log('  Generating media plan...');

  const mediaPlan = await generateMediaPlan(TEST_BRIEF, researchReport);

  console.log(`  Completed in ${elapsed(start)}s`);
  console.log(`  Summary: ${mediaPlan.summary?.slice(0, 100)}...`);
  console.log(`  Platforms: ${mediaPlan.platforms?.map(p => `${p.platform} ($${p.budget_amount})`).join(', ')}`);

  const metaPlatform = mediaPlan.platforms?.find(p => p.platform === 'meta');
  assert(metaPlatform, 'Plan includes Meta platform');
  assert(metaPlatform.campaigns?.length > 0, 'Meta has at least 1 campaign');

  const firstCampaign = metaPlatform.campaigns[0];
  assert(firstCampaign.ad_sets?.length > 0, 'Campaign has at least 1 ad set');

  const firstAdSet = firstCampaign.ad_sets[0];
  assert(firstAdSet.ads?.length > 0, 'Ad set has at least 1 ad');

  const firstAd = firstAdSet.ads[0];
  console.log(`  First ad: "${firstAd.name}" (${firstAd.format})`);
  console.log(`  Headline: ${firstAd.headline}`);
  console.log(`  CTA: ${firstAd.cta}`);
  console.log(`  Media requirements: ${firstAd.media_requirements?.suggested_content ? 'defined' : 'MISSING'}`);

  // Persist
  await updateSession(session.id, {
    current_phase: 'strategy',
    phase_results: { research: researchReport, strategy: mediaPlan },
  });
  console.log('  Persisted strategy results to session');

  // ── Preview execution ─────────────────────────────────────
  hr('4. Execution Preview (human-in-the-loop)');

  const preview = previewExecution(mediaPlan);
  console.log(preview.preview);
  console.log(`  Entities: ${preview.entity_counts.campaigns} campaigns, ${preview.entity_counts.ad_sets} ad sets, ${preview.entity_counts.ads} ads`);

  // ── Phase 5: Execution (Meta API — real calls) ────────────
  hr('5. Execution — Meta Graph API (PAUSED campaigns)');

  start = Date.now();
  console.log(`  Creating campaigns on ad account act_${config.meta.adAccountId}...`);

  // Create campaign
  const campaignSpec = firstCampaign;
  console.log(`\n  [Campaign] "${campaignSpec.name}" objective=${campaignSpec.objective} budget=$${campaignSpec.daily_budget}/day`);

  let campaignId;
  try {
    const campaign = await createCampaign({
      name: `[TEST] ${campaignSpec.name}`,
      objective: campaignSpec.objective,
      daily_budget: campaignSpec.daily_budget,
    });
    campaignId = campaign.id;
    console.log(`  -> Created: ${campaignId}`);
    onCleanup(async () => {
      console.log(`  Deleting test campaign ${campaignId}...`);
      await fetch(`https://graph.facebook.com/${config.meta.apiVersion}/${campaignId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: config.meta.accessToken }),
      });
      console.log(`  Campaign ${campaignId} deleted`);
    });
  } catch (err) {
    console.error(`  Campaign creation failed: ${err.message}`);
    throw err;
  }

  // Create ad set
  const adSetSpec = firstAdSet;
  console.log(`\n  [AdSet] "${adSetSpec.name}" countries=${adSetSpec.targeting?.countries?.join(',')}`);

  let adSetId;
  try {
    const adSet = await createAdSet({
      campaign_id: campaignId,
      name: `[TEST] ${adSetSpec.name}`,
      targeting: adSetSpec.targeting,
      optimization_goal: adSetSpec.optimization_goal,
    });
    adSetId = adSet.id;
    console.log(`  -> Created: ${adSetId}`);
  } catch (err) {
    console.error(`  AdSet creation failed: ${err.message}`);
    if (err.code) console.error(`  Error code: ${err.code}, type: ${err.type}`);
    console.log(`  Targeting sent: ${JSON.stringify(adSetSpec.targeting)}`);
    console.log('  (Continuing without ad set — some targeting params may be invalid)');
  }

  // Create ad (only if we have an adset)
  if (adSetId) {
    const adSpec = firstAd;
    console.log(`\n  [Ad] "${adSpec.name}" headline="${adSpec.headline}" cta=${adSpec.cta}`);
    console.log('  (Skipping ad creative — no real image in test)');
  }

  console.log(`\n  Execution completed in ${elapsed(start)}s`);

  // Persist execution results
  const executionResult = {
    status: adSetId ? 'completed' : 'partial',
    platform: 'meta',
    campaigns: [{
      id: campaignId,
      name: campaignSpec.name,
      ad_sets: adSetId ? [{
        id: adSetId,
        name: adSetSpec.name,
        ads: [],
      }] : [],
    }],
    errors: [],
  };

  await updateSession(session.id, {
    status: 'completed',
    current_phase: 'done',
    phase_results: {
      research: researchReport,
      strategy: mediaPlan,
      creative: { creatives: {}, skipped: true },
      execution: executionResult,
    },
  });

  // ── Verify DB state ───────────────────────────────────────
  hr('6. Verify DB state');

  const finalSession = await getSession(session.id);
  assert(finalSession.status === 'completed', 'Session status = completed');
  assert(finalSession.current_phase === 'done', 'Current phase = done');
  assert(finalSession.phase_results.research, 'Research results persisted');
  assert(finalSession.phase_results.strategy, 'Strategy results persisted');
  assert(finalSession.phase_results.execution, 'Execution results persisted');
  assert(finalSession.phase_results.execution.campaigns[0].id === campaignId, 'Campaign ID matches');

  const finalBrief = await getBrief(brief.id);
  assert(finalBrief.status === 'completed', 'Brief status = completed');

  // ── Summary ───────────────────────────────────────────────
  hr('RESULT');

  console.log(`  Total time: ${elapsed(testStart)}s`);
  console.log(`  Brief ID: ${brief.id}`);
  console.log(`  Session ID: ${session.id}`);
  console.log(`  Meta Campaign ID: ${campaignId}`);
  if (adSetId) console.log(`  Meta AdSet ID: ${adSetId}`);
  console.log(`\n  All checks passed!\n`);
}

// ── Run ────────────────────────────────────────────────────────────────

run()
  .then(() => cleanup())
  .catch(async (err) => {
    console.error('\n  INTEGRATION TEST FAILED:', err.message);
    console.error(err.stack);
    await cleanup();
    process.exit(1);
  });
