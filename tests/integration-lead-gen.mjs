/**
 * Integration test: LEAD_GENERATION flow against real Meta API.
 * Creates PAUSED entities — nothing goes live. Cleans up after.
 *
 * Run: node tests/integration-lead-gen.mjs
 */
import { readFileSync } from 'fs';

// Load .env.local before importing modules
const envLocal = readFileSync('.env.local', 'utf-8');
for (const line of envLocal.split('\n')) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) process.env[match[1].trim()] = match[2].trim();
}

const { createLeadForm, createCampaign, createAdSet, createAd, uploadMedia } = await import('../src/execution-agent.service.js');

const results = { passed: 0, failed: 0, created: [] };
function log(icon, msg) { console.log(`${icon}  ${msg}`); }

async function step(name, fn) {
  try {
    const result = await fn();
    results.passed++;
    log('\u2705', name);
    return result;
  } catch (err) {
    results.failed++;
    log('\u274C', `${name}: ${err.message}`);
    return null;
  }
}

async function deleteEntity(id, label) {
  try {
    const version = process.env.META_API_VERSION || 'v21.0';
    const token = process.env.META_SYSTEM_TOKEN || process.env.META_ACCESS_TOKEN;
    const res = await fetch(`https://graph.facebook.com/${version}/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: token }),
    });
    const data = await res.json();
    log(data.success ? '\uD83E\uDDF9' : '\u26A0\uFE0F',
      data.success ? `Deleted ${label} ${id}` : `Could not delete ${label} ${id}: ${JSON.stringify(data)}`);
  } catch (err) {
    log('\u26A0\uFE0F', `Cleanup error for ${label} ${id}: ${err.message}`);
  }
}

// ── Run ──────────────────────────────────────────────────────────────
console.log('\n=== LEAD_GENERATION Integration Test (Real Meta API) ===\n');
console.log(`Ad Account: ${process.env.META_AD_ACCOUNT_ID}`);
console.log(`Page ID:    ${process.env.META_PAGE_ID}\n`);

// 1. Lead Form
const formResult = await step('1. Create Lead Gen Form (button_type=WHATSAPP)', () =>
  createLeadForm({
    name: `[TEST] Lead Form ${Date.now()}`,
    questions: [
      { type: 'FULL_NAME' }, { type: 'EMAIL' },
      { type: 'PHONE' }, { type: 'COMPANY_NAME' },
    ],
    headline: 'Dealer Inquiry',
    description: 'Integration test — LEAD_GENERATION flow validation.',
    privacy_policy_url: 'https://revopanda.com/privacy',
    thank_you_message: 'Thank you! We will contact you shortly.',
  })
);
if (formResult) {
  log('\uD83D\uDCCB', `Form ID: ${formResult.form_id}`);
  results.created.push({ type: 'lead_form', id: formResult.form_id });
}

// 2. Campaign (OUTCOME_LEADS)
const campaignResult = await step('2. Create OUTCOME_LEADS Campaign', () =>
  createCampaign({
    name: `[TEST] LeadGen Campaign ${Date.now()}`,
    objective: 'lead_gen',
    daily_budget: 5,
  })
);
if (campaignResult) {
  log('\uD83D\uDCCB', `Campaign ID: ${campaignResult.id}`);
  results.created.push({ type: 'campaign', id: campaignResult.id });
}

// 3. Ad Set (LEAD_GENERATION + ON_AD + age clamping)
let adSetResult = null;
if (campaignResult) {
  adSetResult = await step('3. Create Ad Set (LEAD_GENERATION, ON_AD, age clamped to 25-65)', () =>
    createAdSet({
      campaign_id: campaignResult.id,
      name: `[TEST] LeadGen AdSet ${Date.now()}`,
      targeting: { countries: ['TH'], age_range: [28, 55] },
      optimization_goal: 'lead_generation',
      lead_gen_form_id: formResult?.form_id,
      duration_days: 7,
    })
  );
  if (adSetResult) {
    log('\uD83D\uDCCB', `Ad Set ID: ${adSetResult.id}`);
    results.created.push({ type: 'adset', id: adSetResult.id });
  }
}

// 4. Upload test image
const imageResult = await step('4. Upload test image', () =>
  uploadMedia(
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'),
    'test_1px.png',
  )
);
if (imageResult) log('\uD83D\uDCCB', `Image Hash: ${imageResult.image_hash}`);

// 5. Ad (creative with lead_gen_form_id in call_to_action.value)
let adResult = null;
if (adSetResult && imageResult && formResult) {
  adResult = await step('5. Create Ad (creative with lead_gen_form_id in CTA)', () =>
    createAd({
      adset_id: adSetResult.id,
      name: `[TEST] LeadGen Ad ${Date.now()}`,
      primary_text: 'Integration test for LEAD_GENERATION.',
      headline: 'Test Headline',
      description: 'Test description.',
      cta: 'Sign Up',
      image_hash: imageResult.image_hash,
      link_url: 'https://revopanda.com',
      lead_gen_form_id: formResult.form_id,
    })
  );
  if (adResult) {
    log('\uD83D\uDCCB', `Ad ID: ${adResult.ad_id}, Creative ID: ${adResult.creative_id}`);
    results.created.push({ type: 'ad', id: adResult.ad_id });
    results.created.push({ type: 'creative', id: adResult.creative_id });
  }
}

// ── Summary ──────────────────────────────────────────────────────────
console.log(`\n=== Results: ${results.passed}/${results.passed + results.failed} passed ===\n`);

// ── Cleanup ──────────────────────────────────────────────────────────
console.log('=== Cleanup ===\n');
for (const entity of [...results.created].reverse()) {
  if (entity.type !== 'lead_form') {
    await deleteEntity(entity.id, entity.type);
  }
}

const ok = results.failed === 0;
console.log('\n' + (ok ? '\uD83C\uDF89 LEAD_GENERATION flow works end-to-end!' : '\u26A0\uFE0F  Some steps failed.') + '\n');
process.exit(ok ? 0 : 1);
