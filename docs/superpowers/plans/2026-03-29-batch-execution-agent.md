# Batch Execution Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the LLM-driven execution agent (26+ tool calls) with batch custom tools that reduce Claude's orchestration to 3-4 rounds while reusing MCP for actual Meta API calls.

**Architecture:** Add three batch custom tools (`upload_images`, `create_full_campaign`, `submit_execution_result`) to the existing execution agent. The batch tools internally call MCP `callTool` in deterministic loops. The existing MCP-based `executeMediaPlan` is preserved as `executeMediaPlanMCP` for simple/vibe-ads use cases. A new `executeMediaPlanBatch` becomes the default.

**Tech Stack:** Node.js, MCP client (`callTool`), Claude API (`tool_use`), `node:test` for testing.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/execution-agent.service.js` | Modify | Add batch tools, rename old export, add new `executeMediaPlanBatch` |
| `tests/unit/execution-batch.test.js` | Create | Unit tests for batch execution (mock MCP `callTool`) |
| `src/campaign-orchestrator.service.js` | Modify | Wire `runExecution` to use batch by default |

---

### Task 1: Add batch tool implementations — `uploadImages` and `createFullCampaign`

**Files:**
- Modify: `src/execution-agent.service.js`

These are plain async functions (not Claude tools yet) that call MCP internally. We test them directly before wiring into Claude.

- [ ] **Step 1: Write failing tests for `uploadImages`**

Create `tests/unit/execution-batch.test.js`:

```javascript
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Mock config ──────────────────────────────────────────────────────
const configModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/config.js')).href;
mock.module(configModuleUrl, {
  namedExports: {
    config: {
      meta: {
        accessToken: 'test-meta-token',
        adAccountId: '123456789',
        pageId: '9988776655',
        apiVersion: 'v21.0',
      },
    },
  },
});

// ── Mock MCP client ──────────────────────────────────────────────────
const mcpModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/meta-ads-mcp-client.js')).href;
let mcpCalls = [];
mock.module(mcpModuleUrl, {
  namedExports: {
    callTool: mock.fn(async (name, args) => {
      mcpCalls.push({ name, args });
      switch (name) {
        case 'upload_ad_image':
          return { image_hash: `hash_${args.image_url.split('/').pop()}` };
        case 'create_campaign':
          return { id: `camp_${mcpCalls.length}` };
        case 'create_adset':
          return { id: `adset_${mcpCalls.length}` };
        case 'create_ad_creative':
          return { id: `creative_${mcpCalls.length}` };
        case 'create_ad':
          return { id: `ad_${mcpCalls.length}` };
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    }),
    listTools: mock.fn(async () => []),
  },
});

// ── Mock fetch (for createLeadForm which uses direct API) ────────────
const originalFetch = globalThis.fetch;
beforeEach(() => {
  mcpCalls = [];
  globalThis.fetch = mock.fn(async (url) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('fields=access_token')) {
      return { json: async () => ({ access_token: 'page-token-abc' }) };
    }
    if (urlStr.includes('/leadgen_forms')) {
      return { json: async () => ({ id: 'form_001' }) };
    }
    return { json: async () => ({}) };
  });
});

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/execution-agent.service.js')).href;
const { uploadImages, createFullCampaign, executeMediaPlanBatch } = await import(moduleUrl);

// ── Tests ────────────────────────────────────────────────────────────

describe('uploadImages', () => {
  it('uploads multiple images via MCP and returns hash map', async () => {
    const result = await uploadImages([
      { name: 'Hero_v1', url: 'https://cdn.example.com/hero.jpg' },
      { name: 'Banner_v2', url: 'https://cdn.example.com/banner.jpg' },
    ]);

    assert.equal(Object.keys(result).length, 2);
    assert.ok(result['Hero_v1'], 'should have hash for Hero_v1');
    assert.ok(result['Banner_v2'], 'should have hash for Banner_v2');
    assert.equal(mcpCalls.filter(c => c.name === 'upload_ad_image').length, 2);
  });

  it('reports onProgress for each image', async () => {
    const progress = [];
    await uploadImages(
      [{ name: 'Img1', url: 'https://cdn.example.com/1.jpg' }],
      { onProgress: (p) => progress.push(p) },
    );

    assert.ok(progress.length >= 1);
    assert.equal(progress[0].step, 'upload_image');
  });

  it('records errors without stopping other uploads', async () => {
    // Make the second upload fail
    let callIdx = 0;
    const { callTool } = await import(mcpModuleUrl);
    callTool.mock.mockImplementation(async (name, args) => {
      mcpCalls.push({ name, args });
      callIdx++;
      if (name === 'upload_ad_image' && callIdx === 2) {
        throw new Error('Upload failed');
      }
      return { image_hash: `hash_${callIdx}` };
    });

    const result = await uploadImages([
      { name: 'Good', url: 'https://cdn.example.com/good.jpg' },
      { name: 'Bad', url: 'https://cdn.example.com/bad.jpg' },
      { name: 'Also_Good', url: 'https://cdn.example.com/also.jpg' },
    ]);

    assert.ok(result['Good'], 'first should succeed');
    assert.ok(result['Also_Good'], 'third should succeed');
    assert.equal(result['Bad'], undefined, 'failed upload should not be in results');
  });
});

// Restore
after(() => { globalThis.fetch = originalFetch; });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/execution-batch.test.js`
Expected: FAIL — `uploadImages` is not exported.

- [ ] **Step 3: Implement `uploadImages`**

Add to `src/execution-agent.service.js` after the `createLeadForm` function (around line 222):

```javascript
// ── Batch tool: upload multiple images ────────────────────────────────

/**
 * Upload multiple images via MCP in one batch call.
 * @param {Array<{name: string, url: string}>} images
 * @param {Object} [options]
 * @param {Function} [options.onProgress]
 * @returns {Promise<Object>} Map of name → image_hash
 */
export async function uploadImages(images, options = {}) {
  const { onProgress } = options;
  const hashes = {};

  for (let i = 0; i < images.length; i++) {
    const { name, url } = images[i];
    onProgress?.({ step: 'upload_image', detail: `上传图片 ${name} (${i + 1}/${images.length})`, name, index: i, total: images.length });
    try {
      const result = await callTool('upload_ad_image', { image_url: url });
      hashes[name] = result.image_hash;
    } catch (err) {
      onProgress?.({ step: 'upload_error', detail: `✗ 图片 ${name} 上传失败: ${err.message}`, name, error: err.message });
    }
  }

  return hashes;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/execution-batch.test.js`
Expected: PASS for all `uploadImages` tests.

- [ ] **Step 5: Write failing tests for `createFullCampaign`**

Append to `tests/unit/execution-batch.test.js`:

```javascript
describe('createFullCampaign', () => {
  const CAMPAIGN_INPUT = {
    name: 'Lead Gen - Nigeria',
    objective: 'lead_gen',
    daily_budget: 100,
    duration_days: 30,
    link_url: 'https://example.com',
    lead_gen_form_id: 'form_001',
    ad_sets: [{
      name: 'Homeowners 25-55',
      targeting: { countries: ['NG'], age_range: [25, 55] },
      optimization_goal: 'lead_generation',
      ads: [{
        name: 'Hero Ad',
        primary_text: 'Power up your home',
        headline: 'Never Lose Power',
        description: 'Reliable battery system',
        cta: 'Learn More',
        image_hash: 'hash_hero',
      }],
    }],
  };

  it('creates campaign → adset → creative → ad in correct order', async () => {
    const result = await createFullCampaign(CAMPAIGN_INPUT);

    assert.equal(result.status, 'completed');
    assert.ok(result.campaign_id);
    assert.equal(result.ad_sets.length, 1);
    assert.equal(result.ad_sets[0].ads.length, 1);

    // Verify MCP call order
    const callNames = mcpCalls.map(c => c.name);
    const campIdx = callNames.indexOf('create_campaign');
    const adsetIdx = callNames.indexOf('create_adset');
    const creativeIdx = callNames.indexOf('create_ad_creative');
    const adIdx = callNames.indexOf('create_ad');

    assert.ok(campIdx < adsetIdx, 'campaign before adset');
    assert.ok(adsetIdx < creativeIdx, 'adset before creative');
    assert.ok(creativeIdx < adIdx, 'creative before ad');
  });

  it('reports onProgress for each entity', async () => {
    const progress = [];
    await createFullCampaign(CAMPAIGN_INPUT, { onProgress: (p) => progress.push(p) });

    const steps = progress.map(p => p.step);
    assert.ok(steps.includes('create_campaign'));
    assert.ok(steps.includes('create_adset'));
    assert.ok(steps.includes('create_ad'));
  });

  it('maps objective to Meta enum', async () => {
    await createFullCampaign(CAMPAIGN_INPUT);

    const campCall = mcpCalls.find(c => c.name === 'create_campaign');
    assert.equal(campCall.args.objective, 'OUTCOME_LEADS');
  });

  it('converts daily_budget to cents', async () => {
    await createFullCampaign(CAMPAIGN_INPUT);

    const campCall = mcpCalls.find(c => c.name === 'create_campaign');
    assert.equal(campCall.args.daily_budget, 10000);
  });

  it('sets Advantage+ targeting on adset', async () => {
    await createFullCampaign(CAMPAIGN_INPUT);

    const adsetCall = mcpCalls.find(c => c.name === 'create_adset');
    assert.deepEqual(adsetCall.args.targeting.targeting_automation, { advantage_audience: 1 });
  });

  it('clamps age for Advantage+ (min ≤ 18, max ≥ 65)', async () => {
    await createFullCampaign(CAMPAIGN_INPUT);

    const adsetCall = mcpCalls.find(c => c.name === 'create_adset');
    assert.ok(adsetCall.args.targeting.age_min <= 18);
    assert.ok(adsetCall.args.targeting.age_max >= 65);
  });

  it('sets promoted_object and destination_type for lead_gen', async () => {
    await createFullCampaign(CAMPAIGN_INPUT);

    const adsetCall = mcpCalls.find(c => c.name === 'create_adset');
    assert.deepEqual(adsetCall.args.promoted_object, { page_id: '9988776655' });
    assert.equal(adsetCall.args.destination_type, 'ON_AD');
  });

  it('passes lead_gen_form_id to ad creative call_to_action', async () => {
    await createFullCampaign(CAMPAIGN_INPUT);

    const creativeCall = mcpCalls.find(c => c.name === 'create_ad_creative');
    const cta = creativeCall.args.object_story_spec.link_data.call_to_action;
    assert.equal(cta.value.lead_gen_form_id, 'form_001');
  });

  it('skips adset children when adset creation fails', async () => {
    const { callTool } = await import(mcpModuleUrl);
    callTool.mock.mockImplementation(async (name, args) => {
      mcpCalls.push({ name, args });
      if (name === 'create_adset') throw new Error('Targeting too narrow');
      if (name === 'create_campaign') return { id: 'camp_1' };
      return { id: `entity_${mcpCalls.length}` };
    });

    const result = await createFullCampaign(CAMPAIGN_INPUT);

    assert.equal(result.status, 'partial');
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors.some(e => e.level === 'ad_set'));
    // No create_ad or create_ad_creative calls should have been made
    assert.ok(!mcpCalls.some(c => c.name === 'create_ad'));
    assert.ok(!mcpCalls.some(c => c.name === 'create_ad_creative'));
  });

  it('skips all children when campaign creation fails', async () => {
    const { callTool } = await import(mcpModuleUrl);
    callTool.mock.mockImplementation(async (name) => {
      mcpCalls.push({ name });
      if (name === 'create_campaign') throw new Error('Budget too low');
      return { id: 'never' };
    });

    const result = await createFullCampaign(CAMPAIGN_INPUT);

    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some(e => e.level === 'campaign'));
    // No child entity calls
    assert.ok(!mcpCalls.some(c => c.name === 'create_adset'));
  });

  it('continues other ads when one ad has no image_hash', async () => {
    const input = {
      ...CAMPAIGN_INPUT,
      ad_sets: [{
        ...CAMPAIGN_INPUT.ad_sets[0],
        ads: [
          { name: 'Good Ad', primary_text: 'ok', headline: 'ok', description: 'ok', cta: 'Learn More', image_hash: 'hash_good' },
          { name: 'No Image Ad', primary_text: 'ok', headline: 'ok', description: 'ok', cta: 'Learn More' },
        ],
      }],
    };

    const result = await createFullCampaign(input);

    assert.equal(result.status, 'partial');
    assert.equal(result.ad_sets[0].ads.length, 1, 'only the good ad should be in results');
    assert.ok(result.errors.some(e => e.name === 'No Image Ad'));
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `node --test tests/unit/execution-batch.test.js`
Expected: FAIL — `createFullCampaign` is not exported.

- [ ] **Step 7: Implement `createFullCampaign`**

Add to `src/execution-agent.service.js` after `uploadImages`:

```javascript
// ── Batch tool: create a full campaign tree ───────────────────────────

const OBJECTIVE_MAP = {
  lead_gen: 'OUTCOME_LEADS', leads: 'OUTCOME_LEADS',
  traffic: 'OUTCOME_TRAFFIC',
  brand_awareness: 'OUTCOME_AWARENESS', awareness: 'OUTCOME_AWARENESS',
  conversions: 'OUTCOME_SALES', sales: 'OUTCOME_SALES',
  engagement: 'OUTCOME_ENGAGEMENT',
};

const CTA_MAP = {
  'Learn More': 'LEARN_MORE', 'Shop Now': 'SHOP_NOW', 'Sign Up': 'SIGN_UP',
  'Contact Us': 'CONTACT_US', 'Get Quote': 'GET_QUOTE',
  'Send WhatsApp': 'WHATSAPP_MESSAGE', 'WhatsApp': 'WHATSAPP_MESSAGE',
  'Download': 'DOWNLOAD', 'Apply Now': 'APPLY_NOW',
};

/**
 * Create a full campaign with all adsets, creatives, and ads via MCP.
 *
 * @param {Object} input
 * @param {string} input.name - Campaign name
 * @param {string} input.objective - e.g. 'lead_gen', 'traffic'
 * @param {number} input.daily_budget - In dollars (converted to cents internally)
 * @param {number} input.duration_days
 * @param {string} input.link_url - Default landing page
 * @param {string} [input.lead_gen_form_id] - Lead form ID for lead_gen campaigns
 * @param {Array} input.ad_sets - Array of ad set objects with nested ads
 * @param {Object} [options]
 * @param {Function} [options.onProgress]
 * @returns {Promise<Object>} { status, campaign_id, ad_sets: [...], errors: [...] }
 */
export async function createFullCampaign(input, options = {}) {
  const { onProgress } = options;
  const errors = [];
  const pageId = config.meta?.pageId;
  const accountId = `act_${config.meta?.adAccountId}`;
  const metaObjective = OBJECTIVE_MAP[input.objective] || 'OUTCOME_LEADS';
  const isLeadGen = ['OUTCOME_LEADS'].includes(metaObjective);

  // 1. Create campaign
  onProgress?.({ step: 'create_campaign', detail: `创建广告系列 ${input.name}` });
  let campaignId;
  try {
    const result = await callTool('create_campaign', {
      account_id: accountId,
      name: input.name,
      objective: metaObjective,
      status: 'PAUSED',
      special_ad_categories: [],
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      daily_budget: Math.round(input.daily_budget * 100),
    });
    campaignId = result.id;
  } catch (err) {
    errors.push({ level: 'campaign', name: input.name, error: err.message });
    return { status: 'failed', campaign_id: null, ad_sets: [], errors };
  }

  // 2. Create ad sets with children
  const adSetResults = [];

  for (const planAdSet of input.ad_sets) {
    onProgress?.({ step: 'create_adset', detail: `创建广告组 ${planAdSet.name}` });

    // Build targeting
    const targeting = buildBatchTargeting(planAdSet.targeting);

    // Build adset params
    const adsetParams = {
      account_id: accountId,
      campaign_id: campaignId,
      name: planAdSet.name,
      targeting,
      optimization_goal: isLeadGen ? 'LEAD_GENERATION' : 'LINK_CLICKS',
      billing_event: 'IMPRESSIONS',
      status: 'PAUSED',
    };

    // Lead gen specific
    if (isLeadGen && pageId) {
      adsetParams.promoted_object = { page_id: pageId };
      adsetParams.destination_type = 'ON_AD';
    }

    // Schedule
    if (input.duration_days > 0) {
      const now = new Date();
      adsetParams.start_time = now.toISOString();
      adsetParams.end_time = new Date(now.getTime() + input.duration_days * 24 * 60 * 60 * 1000).toISOString();
    }

    let adsetId;
    try {
      const result = await callTool('create_adset', adsetParams);
      adsetId = result.id;
    } catch (err) {
      errors.push({ level: 'ad_set', name: planAdSet.name, error: err.message });
      for (const ad of planAdSet.ads || []) {
        errors.push({ level: 'ad', name: ad.name, error: `Skipped — parent ad set failed` });
      }
      continue;
    }

    // 3. Create ads within this ad set
    const adResults = [];

    for (const planAd of planAdSet.ads || []) {
      if (!planAd.image_hash) {
        errors.push({ level: 'ad', name: planAd.name, error: 'No image_hash — skipped' });
        continue;
      }

      onProgress?.({ step: 'create_ad', detail: `创建广告 ${planAd.name}` });

      // Build call_to_action
      const callToAction = { type: CTA_MAP[planAd.cta] || 'LEARN_MORE' };
      if (isLeadGen && input.lead_gen_form_id) {
        callToAction.value = { lead_gen_form_id: input.lead_gen_form_id };
      }

      try {
        // Create creative
        const creative = await callTool('create_ad_creative', {
          account_id: accountId,
          name: `Creative - ${planAd.name}`,
          page_id: pageId,
          object_story_spec: {
            page_id: pageId,
            link_data: {
              image_hash: planAd.image_hash,
              link: input.link_url,
              message: planAd.primary_text,
              name: planAd.headline,
              description: planAd.description,
              call_to_action: callToAction,
            },
          },
        });

        // Create ad
        const ad = await callTool('create_ad', {
          account_id: accountId,
          name: planAd.name,
          adset_id: adsetId,
          creative: { creative_id: creative.id },
          status: 'PAUSED',
        });

        adResults.push({ ad_id: ad.id, creative_id: creative.id, name: planAd.name });
      } catch (err) {
        errors.push({ level: 'ad', name: planAd.name, error: err.message });
      }
    }

    adSetResults.push({ id: adsetId, name: planAdSet.name, ads: adResults });
  }

  const hasErrors = errors.length > 0;
  const hasSuccess = adSetResults.some(as => as.ads.length > 0);

  return {
    status: hasErrors ? (hasSuccess ? 'partial' : 'failed') : 'completed',
    campaign_id: campaignId,
    ad_sets: adSetResults,
    errors,
  };
}

/**
 * Build Meta targeting spec from plan targeting.
 */
function buildBatchTargeting(targeting = {}) {
  const countries = targeting.countries || [];
  const ageMin = targeting.age_range?.[0] || targeting.age_min || 18;
  const ageMax = targeting.age_range?.[1] || targeting.age_max || 65;

  const spec = {
    geo_locations: { countries: mapCountriesToISO(countries) },
    age_min: Math.min(ageMin, 18),   // Advantage+ requires ≤ 18
    age_max: Math.max(ageMax, 65),   // Advantage+ requires ≥ 65
    targeting_automation: { advantage_audience: 1 },
  };

  if (targeting.gender === 'male') spec.genders = [1];
  else if (targeting.gender === 'female') spec.genders = [2];

  return spec;
}
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `node --test tests/unit/execution-batch.test.js`
Expected: PASS for all `createFullCampaign` tests.

- [ ] **Step 9: Commit**

```bash
git add src/execution-agent.service.js tests/unit/execution-batch.test.js
git commit -m "feat: add uploadImages and createFullCampaign batch tools for deterministic execution"
```

---

### Task 2: Add `executeMediaPlanBatch` and preserve MCP version

**Files:**
- Modify: `src/execution-agent.service.js`

- [ ] **Step 1: Write failing tests for `executeMediaPlanBatch`**

Append to `tests/unit/execution-batch.test.js`:

```javascript
describe('executeMediaPlanBatch', () => {
  const PLAN = {
    duration_days: 30,
    platforms: [{
      platform: 'meta',
      budget_allocation: 100,
      budget_amount: 500,
      campaigns: [
        {
          name: 'SEA_Lead_Gen',
          objective: 'lead_gen',
          daily_budget: 10,
          ad_sets: [{
            name: 'SEA_EN_Dealers',
            targeting: { countries: ['MY', 'TH'], age_range: [28, 58] },
            optimization_goal: 'lead_generation',
            ads: [
              { name: 'Hero_v1', format: 'image', primary_text: 'Dealer opp', headline: 'BYD', description: 'Apply', cta: 'Learn More' },
              { name: 'Profit_v2', format: 'image', primary_text: 'High margin', headline: 'FCB7', description: 'Sign up', cta: 'Apply Now' },
            ],
          }],
        },
        {
          name: 'UAE_Lead_Gen',
          objective: 'lead_gen',
          daily_budget: 8,
          ad_sets: [{
            name: 'UAE_AR_Luxury',
            targeting: { countries: ['AE'], age_range: [30, 60] },
            optimization_goal: 'lead_generation',
            ads: [
              { name: 'LuxSUV_v1', format: 'image', primary_text: 'Premium', headline: 'FCB7 UAE', description: 'Exclusive', cta: 'Apply Now' },
            ],
          }],
        },
      ],
    }],
  };

  const CREATIVES = {
    'Hero_v1': { url: 'https://cdn.example.com/hero.jpg' },
    'Profit_v2': { url: 'https://cdn.example.com/profit.jpg' },
    'LuxSUV_v1': { url: 'https://cdn.example.com/lux.jpg' },
  };

  it('returns completed with all campaigns created', async () => {
    const result = await executeMediaPlanBatch(PLAN, CREATIVES, { link_url: 'https://example.com' });

    assert.equal(result.status, 'completed');
    assert.equal(result.platform, 'meta');
    assert.equal(result.campaigns.length, 2);
    assert.equal(result.errors.length, 0);
  });

  it('uploads images before creating campaigns', async () => {
    await executeMediaPlanBatch(PLAN, CREATIVES, { link_url: 'https://example.com' });

    const uploadCalls = mcpCalls.filter(c => c.name === 'upload_ad_image');
    const campaignCalls = mcpCalls.filter(c => c.name === 'create_campaign');

    assert.equal(uploadCalls.length, 3);
    const firstCampaignIdx = mcpCalls.findIndex(c => c.name === 'create_campaign');
    const lastUploadIdx = mcpCalls.map((c, i) => c.name === 'upload_ad_image' ? i : -1).filter(i => i >= 0).pop();
    assert.ok(lastUploadIdx < firstCampaignIdx, 'all uploads should complete before campaigns');
  });

  it('creates lead forms for lead_gen campaigns', async () => {
    await executeMediaPlanBatch(PLAN, CREATIVES, { link_url: 'https://example.com' });

    // Lead form is created via direct API (fetch), not MCP
    const fetchCalls = globalThis.fetch.mock.calls;
    const formCall = fetchCalls.find(c => {
      const url = typeof c.arguments[0] === 'string' ? c.arguments[0] : c.arguments[0].toString();
      return url.includes('/leadgen_forms');
    });
    assert.ok(formCall, 'should create lead form');
  });

  it('skips when no Meta platform in plan', async () => {
    const result = await executeMediaPlanBatch({ platforms: [{ platform: 'google' }] });
    assert.equal(result.status, 'skipped');
  });

  it('reports onProgress for all phases', async () => {
    const progress = [];
    await executeMediaPlanBatch(PLAN, CREATIVES, {
      link_url: 'https://example.com',
      onProgress: (p) => progress.push(p),
    });

    const steps = progress.map(p => p.step);
    assert.ok(steps.includes('batch_start'));
    assert.ok(steps.includes('upload_image'));
    assert.ok(steps.includes('create_campaign'));
    assert.ok(steps.includes('batch_done'));
  });

  it('handles creatives passed as image_hash directly (no URL)', async () => {
    const hashCreatives = {
      'Hero_v1': { image_hash: 'pre_hash_1' },
      'Profit_v2': { image_hash: 'pre_hash_2' },
      'LuxSUV_v1': { image_hash: 'pre_hash_3' },
    };

    const result = await executeMediaPlanBatch(PLAN, hashCreatives, { link_url: 'https://example.com' });

    assert.equal(result.status, 'completed');
    // Should NOT upload images — they already have hashes
    const uploadCalls = mcpCalls.filter(c => c.name === 'upload_ad_image');
    assert.equal(uploadCalls.length, 0);
  });

  it('returns partial when some ads have no matching creative', async () => {
    const partialCreatives = { 'Hero_v1': { url: 'https://cdn.example.com/hero.jpg' } };
    const result = await executeMediaPlanBatch(PLAN, partialCreatives, { link_url: 'https://example.com' });

    assert.equal(result.status, 'partial');
    assert.ok(result.errors.length > 0, 'should have errors for missing creatives');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/unit/execution-batch.test.js`
Expected: FAIL — `executeMediaPlanBatch` is not exported.

- [ ] **Step 3: Rename existing `executeMediaPlan` to `executeMediaPlanMCP` and implement `executeMediaPlanBatch`**

In `src/execution-agent.service.js`:

1. Rename `export async function executeMediaPlan(` to `export async function executeMediaPlanMCP(`.
2. Add the new function after it:

```javascript
// ── Batch execution (deterministic, no LLM loop) ─────────────────────

/**
 * Execute a media plan using deterministic batch tools.
 * Replaces the LLM-driven MCP loop with direct MCP calls.
 *
 * @param {Object} plan - MediaPlan from generateMediaPlan()
 * @param {Object} creatives - Map of ad name → { url } or { image_hash }
 * @param {Object} [options]
 * @param {string} [options.link_url] - Default landing page URL
 * @param {Function} [options.onProgress]
 * @param {Object} [options.accountAssets]
 * @returns {Promise<Object>} Execution results matching submit_execution_result schema
 */
export async function executeMediaPlanBatch(plan, creatives = {}, options = {}) {
  const { onProgress } = options;
  const metaPlatform = plan.platforms?.find(p => p.platform === 'meta');
  if (!metaPlatform) {
    return { status: 'skipped', reason: 'No Meta platform in plan', campaigns: [], errors: [] };
  }

  const linkUrl = options.link_url || 'https://revopanda.com';
  const durationDays = plan.duration_days || 30;
  const allErrors = [];

  onProgress?.({ step: 'batch_start', detail: `开始批量执行 Meta 广告投放` });

  // 1. Upload images that have URLs but no hash yet
  const needsUpload = Object.entries(creatives)
    .filter(([, c]) => c.url && !c.image_hash && !c.error)
    .map(([name, c]) => ({ name, url: c.url }));

  let imageHashes = {};
  if (needsUpload.length > 0) {
    imageHashes = await uploadImages(needsUpload, { onProgress });
  }

  // Merge pre-existing hashes
  for (const [name, c] of Object.entries(creatives)) {
    if (c.image_hash) imageHashes[name] = c.image_hash;
  }

  // 2. Create lead forms if needed
  const hasLeadGen = metaPlatform.campaigns?.some(c =>
    (c.objective || '').toLowerCase().includes('lead'));

  let leadFormId = null;
  if (hasLeadGen) {
    onProgress?.({ step: 'create_lead_form', detail: '创建潜客表单' });
    try {
      const { form_id } = await createLeadForm({
        name: `Lead Form — ${plan.summary?.slice(0, 50) || 'Campaign'}`,
        questions: [
          { type: 'FULL_NAME' },
          { type: 'EMAIL' },
          { type: 'PHONE' },
          { type: 'COMPANY_NAME' },
        ],
        privacy_policy_url: linkUrl,
        thank_you_message: 'Thank you for your interest! We will contact you shortly.',
      });
      leadFormId = form_id;
    } catch (err) {
      allErrors.push({ level: 'lead_form', name: 'Lead Form', error: err.message });
    }
  }

  // 3. Create each campaign tree
  const campaignResults = [];

  for (const planCampaign of metaPlatform.campaigns || []) {
    // Attach image_hashes to each ad
    const enrichedAdSets = (planCampaign.ad_sets || []).map(as => ({
      ...as,
      ads: (as.ads || []).map(ad => ({
        ...ad,
        image_hash: imageHashes[ad.name] || ad.image_hash,
      })),
    }));

    const result = await createFullCampaign({
      name: planCampaign.name,
      objective: planCampaign.objective || 'lead_gen',
      daily_budget: planCampaign.daily_budget,
      duration_days: durationDays,
      link_url: linkUrl,
      lead_gen_form_id: leadFormId,
      ad_sets: enrichedAdSets,
    }, { onProgress });

    campaignResults.push({
      id: result.campaign_id,
      name: planCampaign.name,
      ad_sets: result.ad_sets,
    });

    allErrors.push(...result.errors);
  }

  const hasErrors = allErrors.length > 0;
  const hasSuccess = campaignResults.some(c => c.ad_sets?.some(as => as.ads?.length > 0));

  onProgress?.({
    step: 'batch_done',
    detail: `批量执行完成：${campaignResults.length} 个广告系列${hasErrors ? `，${allErrors.length} 个错误` : ''}`,
    campaigns: campaignResults.length,
    errors: allErrors.length,
  });

  return {
    status: hasErrors ? (hasSuccess ? 'partial' : 'failed') : 'completed',
    platform: 'meta',
    campaigns: campaignResults,
    errors: allErrors,
  };
}
```

3. Keep the original `executeMediaPlan` name as an alias pointing to batch:

```javascript
/** Default execution — uses batch (deterministic) mode. */
export const executeMediaPlan = executeMediaPlanBatch;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/execution-batch.test.js`
Expected: PASS for all tests.

- [ ] **Step 5: Run existing tests to ensure MCP version still works**

Run: `node --test tests/unit/execution-agent.test.js`
Expected: Tests may need `executeMediaPlan` → `executeMediaPlanMCP` import adjustment. If so, update the import in the test file from `executeMediaPlan` to `executeMediaPlanMCP`.

Run: `node --test tests/unit/execution-lead-gen.test.js`
Expected: Same — update imports if needed. The old test file imports `createLeadForm`, `createAdSet`, `createCampaign`, `createAd` which still exist.

- [ ] **Step 6: Commit**

```bash
git add src/execution-agent.service.js tests/unit/execution-batch.test.js tests/unit/execution-agent.test.js tests/unit/execution-lead-gen.test.js
git commit -m "feat: add executeMediaPlanBatch as default execution, preserve MCP as executeMediaPlanMCP"
```

---

### Task 3: Wire orchestrator to use batch execution

**Files:**
- Modify: `src/campaign-orchestrator.service.js:18,285`

- [ ] **Step 1: Update the import**

In `src/campaign-orchestrator.service.js` line 18, change:

```javascript
import { executeMediaPlan, previewExecution, activateCampaigns } from './execution-agent.service.js';
```

No change needed — `executeMediaPlan` is now re-exported as an alias to `executeMediaPlanBatch`. The orchestrator continues to call `executeMediaPlan` and gets batch behavior automatically.

Verify by reading the orchestrator's `runExecution` function (line 267-289) — it passes `mediaPlan`, `creatives`, and `{ link_url, onProgress, accountAssets }`. The `executeMediaPlanBatch` function accepts the same signature.

- [ ] **Step 2: Verify orchestrator integration**

Run: `node --test tests/unit/campaign-orchestrator.test.js`
Expected: PASS (orchestrator mocks `executeMediaPlan` so the switch is transparent).

- [ ] **Step 3: Commit**

```bash
git commit --allow-empty -m "chore: verify orchestrator uses batch execution via executeMediaPlan alias"
```

---

### Task 4: Multi-format ad coverage tests

**Files:**
- Modify: `tests/unit/execution-batch.test.js`

Tests covering different Meta ad types: traffic campaigns, brand awareness, WhatsApp CTA, campaigns without lead forms.

- [ ] **Step 1: Add traffic campaign test**

Append to `tests/unit/execution-batch.test.js`:

```javascript
describe('createFullCampaign — ad format variations', () => {
  it('traffic campaign: OUTCOME_TRAFFIC objective, LINK_CLICKS optimization', async () => {
    const result = await createFullCampaign({
      name: 'Traffic Campaign',
      objective: 'traffic',
      daily_budget: 50,
      duration_days: 14,
      link_url: 'https://shop.example.com',
      ad_sets: [{
        name: 'Broad Audience',
        targeting: { countries: ['US'], age_range: [18, 65] },
        optimization_goal: 'link_clicks',
        ads: [{
          name: 'Shop Now Ad',
          primary_text: 'Check out our store',
          headline: 'Big Sale',
          description: '50% off',
          cta: 'Shop Now',
          image_hash: 'hash_shop',
        }],
      }],
    });

    assert.equal(result.status, 'completed');

    const campCall = mcpCalls.find(c => c.name === 'create_campaign');
    assert.equal(campCall.args.objective, 'OUTCOME_TRAFFIC');

    const adsetCall = mcpCalls.find(c => c.name === 'create_adset');
    assert.equal(adsetCall.args.optimization_goal, 'LINK_CLICKS');
    assert.equal(adsetCall.args.promoted_object, undefined, 'traffic campaigns should not have promoted_object');
    assert.equal(adsetCall.args.destination_type, undefined);

    const creativeCall = mcpCalls.find(c => c.name === 'create_ad_creative');
    const cta = creativeCall.args.object_story_spec.link_data.call_to_action;
    assert.equal(cta.type, 'SHOP_NOW');
    assert.equal(cta.value, undefined, 'non-lead-gen should not have form_id');
  });

  it('brand_awareness campaign: OUTCOME_AWARENESS objective', async () => {
    const result = await createFullCampaign({
      name: 'Awareness Campaign',
      objective: 'brand_awareness',
      daily_budget: 30,
      duration_days: 7,
      link_url: 'https://brand.example.com',
      ad_sets: [{
        name: 'Wide Reach',
        targeting: { countries: ['GB'] },
        optimization_goal: 'impressions',
        ads: [{
          name: 'Brand Ad',
          primary_text: 'Discover our brand',
          headline: 'Brand X',
          description: 'Premium quality',
          cta: 'Learn More',
          image_hash: 'hash_brand',
        }],
      }],
    });

    assert.equal(result.status, 'completed');
    const campCall = mcpCalls.find(c => c.name === 'create_campaign');
    assert.equal(campCall.args.objective, 'OUTCOME_AWARENESS');
  });

  it('WhatsApp CTA maps to WHATSAPP_MESSAGE', async () => {
    await createFullCampaign({
      name: 'WhatsApp Campaign',
      objective: 'lead_gen',
      daily_budget: 20,
      duration_days: 30,
      link_url: 'https://wa.me/123',
      lead_gen_form_id: 'form_wa',
      ad_sets: [{
        name: 'WA Audience',
        targeting: { countries: ['IN'] },
        optimization_goal: 'lead_generation',
        ads: [{
          name: 'WA Ad',
          primary_text: 'Chat with us',
          headline: 'WhatsApp Us',
          description: 'Instant reply',
          cta: 'Send WhatsApp',
          image_hash: 'hash_wa',
        }],
      }],
    });

    const creativeCall = mcpCalls.find(c => c.name === 'create_ad_creative');
    assert.equal(creativeCall.args.object_story_spec.link_data.call_to_action.type, 'WHATSAPP_MESSAGE');
  });

  it('multiple ad sets with different targeting in same campaign', async () => {
    const result = await createFullCampaign({
      name: 'Multi AdSet Campaign',
      objective: 'traffic',
      daily_budget: 100,
      duration_days: 30,
      link_url: 'https://example.com',
      ad_sets: [
        {
          name: 'Young Males',
          targeting: { countries: ['NG'], age_range: [18, 35], gender: 'male' },
          optimization_goal: 'link_clicks',
          ads: [{ name: 'Ad A', primary_text: 'a', headline: 'a', description: 'a', cta: 'Learn More', image_hash: 'h1' }],
        },
        {
          name: 'Older Females',
          targeting: { countries: ['NG'], age_range: [35, 65], gender: 'female' },
          optimization_goal: 'link_clicks',
          ads: [{ name: 'Ad B', primary_text: 'b', headline: 'b', description: 'b', cta: 'Learn More', image_hash: 'h2' }],
        },
      ],
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.ad_sets.length, 2);

    const adsetCalls = mcpCalls.filter(c => c.name === 'create_adset');
    assert.equal(adsetCalls.length, 2);
    assert.deepEqual(adsetCalls[0].args.targeting.genders, [1]);
    assert.deepEqual(adsetCalls[1].args.targeting.genders, [2]);
  });

  it('campaign with no ads (all missing image_hash) returns failed', async () => {
    const result = await createFullCampaign({
      name: 'Empty Campaign',
      objective: 'traffic',
      daily_budget: 50,
      duration_days: 14,
      link_url: 'https://example.com',
      ad_sets: [{
        name: 'No Images Set',
        targeting: { countries: ['US'] },
        optimization_goal: 'link_clicks',
        ads: [
          { name: 'No Hash 1', primary_text: 'x', headline: 'x', description: 'x', cta: 'Learn More' },
          { name: 'No Hash 2', primary_text: 'y', headline: 'y', description: 'y', cta: 'Learn More' },
        ],
      }],
    });

    // Ad set was created but no ads succeeded
    assert.equal(result.status, 'partial');
    assert.ok(result.errors.length >= 2);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/unit/execution-batch.test.js`
Expected: PASS for all new tests.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/execution-batch.test.js
git commit -m "test: add multi-format ad coverage for batch execution agent"
```

---

### Task 5: Fix the original force-submit bug

**Files:**
- Modify: `src/execution-agent.service.js` (the MCP version's force-submit path)

This was the original bug that caused infinite retries — already identified but needs a test.

- [ ] **Step 1: Verify the fix is already applied**

Read `src/execution-agent.service.js` around lines 360-396 and confirm the `pendingToolUse` fix from earlier in this conversation is present.

- [ ] **Step 2: Commit if not already committed**

```bash
git add src/execution-agent.service.js
git commit -m "fix: provide tool_result for pending tool_use blocks in MCP force-submit path"
```

---

### Task 6: Run full test suite and verify

- [ ] **Step 1: Run all execution tests**

```bash
node --test tests/unit/execution-batch.test.js tests/unit/execution-agent.test.js tests/unit/execution-lead-gen.test.js
```

Expected: All PASS.

- [ ] **Step 2: Run orchestrator tests**

```bash
node --test tests/unit/campaign-orchestrator.test.js
```

Expected: PASS.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "chore: batch execution agent — all tests passing"
```
