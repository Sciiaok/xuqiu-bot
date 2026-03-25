/**
 * Integration test: Meta Ads API — Campaign/AdSet/Ad creation.
 *
 * Tests real Meta Graph API calls against the configured ad account.
 * All entities created in PAUSED status and cleaned up after test.
 *
 * Run: node tests/integration-meta-ads.mjs
 * Run without cleanup: node tests/integration-meta-ads.mjs --keep
 * Requires: META_SYSTEM_TOKEN, META_AD_ACCOUNT_ID in .env.local
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Load env
const envPath = resolve(process.cwd(), '.env.local');
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const t = line.trim(); if (!t || t.startsWith('#')) continue;
  const eq = t.indexOf('='); if (eq > 0 && !process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
}

const { createCampaign, createAdSet, createAd, uploadMedia, previewExecution } = await import('../src/execution-agent.service.js');
const { config } = await import('../src/config.js');

const KEEP = process.argv.includes('--keep');
const cleanupIds = [];

function assert(cond, msg) {
  if (!cond) { console.error(`  FAIL: ${msg}`); process.exit(1); }
  console.log(`  OK: ${msg}`);
}

async function cleanup() {
  if (KEEP) { console.log('\n--- Cleanup skipped (--keep) ---'); return; }
  console.log('\n--- Cleanup ---');
  for (const id of cleanupIds.reverse()) {
    try {
      await fetch(`https://graph.facebook.com/${config.meta.apiVersion}/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: config.meta.accessToken }),
      });
      console.log(`  Deleted ${id}`);
    } catch (e) { console.warn(`  Failed to delete ${id}: ${e.message}`); }
  }
}

async function run() {
  console.log('=== Meta Ads API Integration Tests ===\n');
  console.log(`Ad Account: act_${config.meta.adAccountId}`);
  console.log(`API Version: ${config.meta.apiVersion}\n`);

  // ── Test 1: Create OUTCOME_TRAFFIC campaign ──────────────
  console.log('--- Test 1: Create TRAFFIC campaign ---');
  const trafficCampaign = await createCampaign({
    name: '[TEST] Traffic Campaign',
    objective: 'traffic',
    daily_budget: 10,
  });
  assert(trafficCampaign.id, `Campaign created: ${trafficCampaign.id}`);
  cleanupIds.push(trafficCampaign.id);

  // ── Test 2: Create OUTCOME_LEADS campaign ────────────────
  console.log('\n--- Test 2: Create LEADS campaign ---');
  const leadsCampaign = await createCampaign({
    name: '[TEST] Lead Gen Campaign',
    objective: 'lead_gen',
    daily_budget: 15,
  });
  assert(leadsCampaign.id, `Campaign created: ${leadsCampaign.id}`);
  cleanupIds.push(leadsCampaign.id);

  // ── Test 3: Create OUTCOME_AWARENESS campaign ────────────
  console.log('\n--- Test 3: Create AWARENESS campaign ---');
  const awarenessCampaign = await createCampaign({
    name: '[TEST] Brand Awareness Campaign',
    objective: 'brand_awareness',
    daily_budget: 5,
  });
  assert(awarenessCampaign.id, `Campaign created: ${awarenessCampaign.id}`);
  cleanupIds.push(awarenessCampaign.id);

  // ── Test 4: AdSet with Nigeria targeting (country name → ISO) ─
  console.log('\n--- Test 4: AdSet with country name "Nigeria" → NG ---');
  const ngAdSet = await createAdSet({
    campaign_id: trafficCampaign.id,
    name: '[TEST] Nigeria Urban 25-55',
    targeting: {
      countries: ['Nigeria'],
      age_range: [25, 55],
      interests: ['Automobiles'],
    },
    optimization_goal: 'LINK_CLICKS',
  });
  assert(ngAdSet.id, `AdSet created: ${ngAdSet.id}`);
  cleanupIds.push(ngAdSet.id);

  // ── Test 5: AdSet with ISO code directly ─────────────────
  console.log('\n--- Test 5: AdSet with ISO code "KE" directly ---');
  const keAdSet = await createAdSet({
    campaign_id: trafficCampaign.id,
    name: '[TEST] Kenya 25-45',
    targeting: {
      countries: ['KE'],
      age_range: [25, 45],
      gender: 'male',
    },
    optimization_goal: 'LINK_CLICKS',
  });
  assert(keAdSet.id, `AdSet created: ${keAdSet.id}`);
  cleanupIds.push(keAdSet.id);

  // ── Test 6: AdSet with multiple countries ─────────────────
  console.log('\n--- Test 6: AdSet with multiple countries ---');
  const multiAdSet = await createAdSet({
    campaign_id: trafficCampaign.id,
    name: '[TEST] Multi-country NG+KE+GH',
    targeting: {
      countries: ['Nigeria', 'Kenya', 'Ghana'],
      age_range: [25, 55],
    },
    optimization_goal: 'LANDING_PAGE_VIEWS',
  });
  assert(multiAdSet.id, `AdSet created: ${multiAdSet.id}`);
  cleanupIds.push(multiAdSet.id);

  // ── Test 7: AdSet for LEADS campaign (fallback to LANDING_PAGE_VIEWS) ─
  console.log('\n--- Test 7: AdSet for LEADS campaign (no page_id → fallback) ---');
  const leadsAdSet = await createAdSet({
    campaign_id: leadsCampaign.id,
    name: '[TEST] Leads NG - Fallback Goal',
    targeting: {
      countries: ['NG'],
      age_range: [28, 50],
      interests: ['Electric vehicles'],
    },
    optimization_goal: 'LEAD_GENERATION',
  });
  assert(leadsAdSet.id, `AdSet created: ${leadsAdSet.id}`);
  cleanupIds.push(leadsAdSet.id);

  // ── Test 8: AdSet with female gender targeting ────────────
  console.log('\n--- Test 8: AdSet with female gender ---');
  const femaleAdSet = await createAdSet({
    campaign_id: trafficCampaign.id,
    name: '[TEST] Nigeria Female 25-40',
    targeting: {
      countries: ['NG'],
      age_range: [25, 40],
      gender: 'female',
      interests: ['Shopping', 'Fashion'],
    },
    optimization_goal: 'LINK_CLICKS',
  });
  assert(femaleAdSet.id, `AdSet created: ${femaleAdSet.id}`);
  cleanupIds.push(femaleAdSet.id);

  // ── Test 9: AdSet with age_min/age_max directly (Claude sometimes outputs this) ─
  console.log('\n--- Test 9: AdSet with age_min/age_max (not age_range) ---');
  const directAgeAdSet = await createAdSet({
    campaign_id: trafficCampaign.id,
    name: '[TEST] Direct age_min/age_max',
    targeting: {
      countries: ['NG'],
      age_min: 30,
      age_max: 50,
    },
    optimization_goal: 'LINK_CLICKS',
  });
  assert(directAgeAdSet.id, `AdSet created: ${directAgeAdSet.id}`);
  cleanupIds.push(directAgeAdSet.id);

  // ── Test 10: previewExecution ─────────────────────────────
  console.log('\n--- Test 10: previewExecution formatting ---');
  const plan = {
    platforms: [{
      platform: 'meta', budget_allocation: 100, budget_amount: 500, rationale: 'Test',
      campaigns: [{
        name: 'Test Campaign', objective: 'lead_gen', daily_budget: 35,
        ad_sets: [{
          name: 'Nigeria', targeting: { countries: ['NG'] }, optimization_goal: 'leads',
          ads: [
            { name: 'Ad 1', format: 'image', headline: 'Test', cta: 'Learn More' },
            { name: 'Ad 2', format: 'video', headline: 'Test 2', cta: 'Get Quote' },
          ],
        }],
      }],
    }],
  };
  const { preview, entity_counts } = previewExecution(plan);
  assert(preview.includes('Test Campaign'), 'Preview includes campaign name');
  assert(entity_counts.campaigns === 1, 'Counts 1 campaign');
  assert(entity_counts.ads === 2, 'Counts 2 ads');

  // ── Summary ──────────────────────────────────────────────
  console.log('\n=== All tests passed! ===');
  console.log(`Created: ${cleanupIds.length} entities`);
  console.log(`Campaigns: ${[trafficCampaign.id, leadsCampaign.id, awarenessCampaign.id].join(', ')}`);
  console.log(`AdSets: ${[ngAdSet.id, keAdSet.id, multiAdSet.id, leadsAdSet.id, femaleAdSet.id, directAgeAdSet.id].join(', ')}`);
}

run()
  .then(() => cleanup())
  .catch(async (err) => {
    console.error('\nTEST FAILED:', err.message);
    if (err.code) console.error('Code:', err.code, 'Type:', err.type);
    await cleanup();
    process.exit(1);
  });
