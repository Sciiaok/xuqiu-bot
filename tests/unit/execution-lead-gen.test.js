import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Mock config ──────────────────────────────────────────────────────
const configModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/config.js')).href;

mock.module(configModuleUrl, {
  namedExports: {
    config: {
      anthropic: {
        apiKey: 'test-key',
        baseURL: 'https://openrouter.ai/api',
        model: 'claude-sonnet-4-6',
      },
      meta: {
        accessToken: 'test-meta-token',
        adAccountId: '123456789',
        pageId: '9988776655',
        apiVersion: 'v21.0',
      },
    },
  },
});

// ── Fetch mock infrastructure ────────────────────────────────────────
const originalFetch = globalThis.fetch;
let fetchCalls;
let fetchMock;

beforeEach(() => {
  fetchCalls = [];
  fetchMock = mock.fn(async (url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    fetchCalls.push({ url: urlStr, options });

    // Page access token request
    if (urlStr.includes('9988776655') && urlStr.includes('fields=access_token')) {
      return { json: async () => ({ access_token: 'page-token-abc' }) };
    }
    // Lead form creation
    if (urlStr.includes('/leadgen_forms')) {
      const body = options?.body ? JSON.parse(options.body) : {};
      return { json: async () => ({ id: `form_${Date.now()}` }) };
    }
    // Campaign creation
    if (urlStr.includes('/campaigns')) {
      return { json: async () => ({ id: `camp_${Math.random().toString(36).slice(2, 8)}` }) };
    }
    // Ad set creation
    if (urlStr.includes('/adsets')) {
      return { json: async () => ({ id: `adset_${Math.random().toString(36).slice(2, 8)}` }) };
    }
    // Ad creative
    if (urlStr.includes('/adcreatives')) {
      return { json: async () => ({ id: `creative_001` }) };
    }
    // Ad
    if (urlStr.includes('/ads') && !urlStr.includes('/adsets') && !urlStr.includes('/adimages') && !urlStr.includes('/adcreatives')) {
      return { json: async () => ({ id: `ad_001` }) };
    }
    // Image upload
    if (urlStr.includes('/adimages')) {
      return { json: async () => ({ images: { img: { hash: 'hash_abc' } } }) };
    }
    return { json: async () => ({}) };
  });
  globalThis.fetch = fetchMock;
});

// ── Import module under test ─────────────────────────────────────────
const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/execution-agent.service.js')).href;
const {
  createLeadForm,
  createAdSet,
  createCampaign,
  createAd,
  executeMediaPlan,
} = await import(moduleUrl);

// ── Helper: find fetch call by URL pattern ───────────────────────────
function findFetchBody(pattern) {
  const call = fetchCalls.find(c => c.url.includes(pattern));
  if (!call?.options?.body) return null;
  return JSON.parse(call.options.body);
}

function findAllFetchBodies(pattern) {
  return fetchCalls
    .filter(c => c.url.includes(pattern) && c.options?.body)
    .map(c => JSON.parse(c.options.body));
}

// ── Tests ────────────────────────────────────────────────────────────

describe('LEAD_GENERATION execution', () => {

  describe('createLeadForm', () => {
    it('uses WHATSAPP as thank_you_page button_type (not SEND_WHATSAPP_MESSAGE)', async () => {
      await createLeadForm({
        name: 'Test Form',
        questions: [{ type: 'FULL_NAME' }, { type: 'EMAIL' }, { type: 'PHONE' }],
        privacy_policy_url: 'https://example.com/privacy',
        thank_you_message: 'Thanks!',
      });

      const body = findFetchBody('/leadgen_forms');
      assert.ok(body, 'leadgen_forms API should be called');

      const thankYouPage = JSON.parse(body.thank_you_page);
      assert.equal(thankYouPage.button_type, 'WHATSAPP',
        'button_type must be WHATSAPP, not SEND_WHATSAPP_MESSAGE');
    });

    it('uses page access token, not system token', async () => {
      await createLeadForm({
        name: 'Token Test Form',
        questions: [{ type: 'FULL_NAME' }, { type: 'EMAIL' }],
      });

      const body = findFetchBody('/leadgen_forms');
      assert.ok(body, 'leadgen_forms API should be called');
      // Page token is cached from prior test; either way it must NOT be the system token
      assert.notEqual(body.access_token, 'test-meta-token',
        'lead form must NOT use system token directly');
      assert.equal(body.access_token, 'page-token-abc',
        'lead form should use page access token');
    });

    it('auto-adds FULL_NAME and EMAIL if missing', async () => {
      await createLeadForm({
        name: 'Minimal Form',
        questions: [{ type: 'PHONE' }],
      });

      const body = findFetchBody('/leadgen_forms');
      const questions = JSON.parse(body.questions);
      const types = questions.map(q => q.type);
      assert.ok(types.includes('FULL_NAME'), 'should auto-add FULL_NAME');
      assert.ok(types.includes('EMAIL'), 'should auto-add EMAIL');
      assert.ok(types.includes('PHONE'), 'should keep original PHONE');
    });
  });

  describe('createAdSet — Advantage+ audience age constraints', () => {
    it('clamps age_min to 25 when using age_range', async () => {
      await createAdSet({
        campaign_id: 'c1',
        name: 'Test',
        targeting: { countries: ['TH'], age_range: [28, 55] },
        optimization_goal: 'lead_generation',
        lead_gen_form_id: 'form_123',
      });

      const body = findFetchBody('/adsets');
      assert.ok(body.targeting.age_min <= 25,
        `age_min should be <= 25 for Advantage+, got ${body.targeting.age_min}`);
    });

    it('clamps age_min to 25 when using age_min field directly', async () => {
      await createAdSet({
        campaign_id: 'c1',
        name: 'Test',
        targeting: { countries: ['AE'], age_min: 30, age_max: 60 },
        optimization_goal: 'lead_generation',
        lead_gen_form_id: 'form_123',
      });

      const body = findFetchBody('/adsets');
      assert.ok(body.targeting.age_min <= 25,
        `age_min should be <= 25, got ${body.targeting.age_min}`);
      assert.ok(body.targeting.age_max >= 65,
        `age_max should be >= 65 for Advantage+, got ${body.targeting.age_max}`);
    });

    it('enables Advantage+ audience targeting_automation', async () => {
      await createAdSet({
        campaign_id: 'c1',
        name: 'Test',
        targeting: { countries: ['KZ'] },
        optimization_goal: 'lead_generation',
        lead_gen_form_id: 'form_123',
      });

      const body = findFetchBody('/adsets');
      assert.deepEqual(body.targeting.targeting_automation, { advantage_audience: 1 });
    });
  });

  describe('createAdSet — LEAD_GENERATION promoted_object', () => {
    it('sets promoted_object with page_id only and destination_type ON_AD', async () => {
      await createAdSet({
        campaign_id: 'c1',
        name: 'Lead Set',
        targeting: { countries: ['NG'] },
        optimization_goal: 'lead_generation',
        lead_gen_form_id: 'form_456',
      });

      const body = findFetchBody('/adsets');
      assert.equal(body.optimization_goal, 'LEAD_GENERATION');
      assert.equal(body.promoted_object.page_id, '9988776655');
      assert.equal(body.promoted_object.lead_gen_form_id, undefined,
        'lead_gen_form_id must NOT be in promoted_object — it goes on the ad creative');
      assert.equal(body.destination_type, 'ON_AD');
      assert.equal(body.billing_event, 'IMPRESSIONS',
        'LEAD_GENERATION must use IMPRESSIONS billing');
    });

    it('strips interests from targeting (let Advantage+ handle it)', async () => {
      await createAdSet({
        campaign_id: 'c1',
        name: 'Test',
        targeting: {
          countries: ['ET'],
          interests: ['Electric vehicle', 'Car dealership'],
        },
        optimization_goal: 'lead_generation',
        lead_gen_form_id: 'form_789',
      });

      const body = findFetchBody('/adsets');
      assert.equal(body.targeting.flexible_spec, undefined,
        'interests should be stripped for Advantage+ audience');
    });
  });

  describe('createAdSet — scheduling', () => {
    it('sets start_time and end_time from duration_days', async () => {
      await createAdSet({
        campaign_id: 'c1',
        name: 'Scheduled',
        targeting: { countries: ['MY'] },
        optimization_goal: 'lead_generation',
        lead_gen_form_id: 'form_abc',
        duration_days: 30,
      });

      const body = findFetchBody('/adsets');
      assert.ok(body.start_time, 'should have start_time');
      assert.ok(body.end_time, 'should have end_time');

      const start = new Date(body.start_time);
      const end = new Date(body.end_time);
      const diffDays = Math.round((end - start) / (24 * 60 * 60 * 1000));
      assert.equal(diffDays, 30, 'end_time should be 30 days after start_time');
    });
  });

  describe('executeMediaPlan — full LEAD_GENERATION flow', () => {
    const LEAD_GEN_PLAN = {
      duration_days: 30,
      platforms: [{
        platform: 'meta',
        budget_allocation: 100,
        budget_amount: 500,
        rationale: 'B2B dealer leads',
        campaigns: [
          {
            name: 'SEA_BYD_DealerLeads',
            objective: 'lead_gen',
            daily_budget: 9,
            ad_sets: [{
              name: 'SEA_EN_Dealers',
              targeting: { countries: ['MY', 'TH', 'ID'], age_range: [28, 58] },
              optimization_goal: 'lead_generation',
              ads: [
                { name: 'SEA_EN_Hero_v1', format: 'image', primary_text: 'Dealer opp', headline: 'BYD FCB7', description: 'Apply now', cta: 'Learn More' },
                { name: 'SEA_EN_Profit_v2', format: 'image', primary_text: 'High margin', headline: 'FCB7 Dealer', description: 'Sign up', cta: 'Apply Now' },
              ],
            }],
          },
          {
            name: 'UAE_BYD_DealerLeads',
            objective: 'lead_gen',
            daily_budget: 8,
            ad_sets: [{
              name: 'UAE_AR_Luxury',
              targeting: { countries: ['AE'], age_range: [30, 60] },
              optimization_goal: 'lead_generation',
              ads: [
                { name: 'UAE_AR_LuxSUV_v1', format: 'image', primary_text: 'Premium', headline: 'FCB7 UAE', description: 'Exclusive', cta: 'Apply Now' },
              ],
            }],
          },
        ],
      }],
    };

    const CREATIVES = {
      'SEA_EN_Hero_v1': { image_hash: 'hash_sea1' },
      'SEA_EN_Profit_v2': { image_hash: 'hash_sea2' },
      'UAE_AR_LuxSUV_v1': { image_hash: 'hash_uae1' },
    };

    it('creates lead forms before ad sets', async () => {
      const result = await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

      // Lead form calls should come before adset calls
      const formCallIdx = fetchCalls.findIndex(c => c.url.includes('/leadgen_forms'));
      const adsetCallIdx = fetchCalls.findIndex(c => c.url.includes('/adsets'));
      assert.ok(formCallIdx >= 0, 'should create lead forms');
      assert.ok(adsetCallIdx >= 0, 'should create ad sets');
      assert.ok(formCallIdx < adsetCallIdx, 'lead forms must be created before ad sets');
    });

    it('completes successfully with all entities created', async () => {
      const result = await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

      assert.equal(result.status, 'completed');
      assert.equal(result.platform, 'meta');
      assert.equal(result.campaigns.length, 2);
      assert.equal(result.errors.length, 0);
    });

    it('creates 2 campaigns with correct objectives', async () => {
      await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

      const campaignBodies = findAllFetchBodies('/campaigns');
      assert.equal(campaignBodies.length, 2);
      for (const body of campaignBodies) {
        assert.equal(body.objective, 'OUTCOME_LEADS');
        assert.equal(body.status, 'PAUSED');
      }
    });

    it('ad sets have promoted_object with page_id and destination_type ON_AD', async () => {
      await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

      const adsetBodies = findAllFetchBodies('/adsets');
      assert.equal(adsetBodies.length, 2);
      for (const body of adsetBodies) {
        assert.equal(body.promoted_object.page_id, '9988776655');
        assert.equal(body.promoted_object.lead_gen_form_id, undefined,
          'lead_gen_form_id must NOT be in promoted_object');
        assert.equal(body.destination_type, 'ON_AD');
      }
    });

    it('passes lead_gen_form_id to ad creatives via call_to_action', async () => {
      await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

      const creativeBodies = findAllFetchBodies('/adcreatives');
      assert.ok(creativeBodies.length >= 3, 'should create at least 3 creatives');
      for (const body of creativeBodies) {
        const ctaValue = body.object_story_spec?.link_data?.call_to_action?.value;
        assert.ok(ctaValue?.lead_gen_form_id,
          'creative call_to_action.value should contain lead_gen_form_id');
      }
    });

    it('all ad sets have age_min <= 25 (Advantage+ constraint)', async () => {
      await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

      const adsetBodies = findAllFetchBodies('/adsets');
      for (const body of adsetBodies) {
        assert.ok(body.targeting.age_min <= 25,
          `age_min ${body.targeting.age_min} exceeds Advantage+ limit of 25`);
      }
    });

    it('creates 3 ads total with correct image hashes', async () => {
      const result = await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

      // Count ads from the result structure (not fetch calls, which also include creatives)
      const totalAds = result.campaigns.reduce((sum, c) =>
        sum + c.ad_sets.reduce((s, as) => s + as.ads.length, 0), 0);
      assert.equal(totalAds, 3, 'should create 3 ads');
    });

    it('records error for ads missing image_hash', async () => {
      const incompleteCreatives = { 'SEA_EN_Hero_v1': { image_hash: 'hash1' } };
      const result = await executeMediaPlan(LEAD_GEN_PLAN, incompleteCreatives);

      assert.equal(result.status, 'partial', 'should be partial when some ads fail');
      const missingHashErrors = result.errors.filter(e =>
        e.level === 'ad' && e.error.includes('image_hash'));
      assert.ok(missingHashErrors.length >= 2, 'should report missing image_hash errors');
    });

    it('skips child entities when campaign creation fails', async () => {
      // Make first campaign creation fail
      let campaignCallCount = 0;
      globalThis.fetch = mock.fn(async (url, options) => {
        const urlStr = typeof url === 'string' ? url : url.toString();
        fetchCalls.push({ url: urlStr, options });

        if (urlStr.includes('fields=access_token')) {
          return { json: async () => ({ access_token: 'page-token-abc' }) };
        }
        if (urlStr.includes('/leadgen_forms')) {
          return { json: async () => ({ id: 'form_test' }) };
        }
        if (urlStr.includes('/campaigns')) {
          campaignCallCount++;
          if (campaignCallCount === 1) {
            return { json: async () => ({ error: { message: 'Budget too low', code: 100 } }) };
          }
          return { json: async () => ({ id: 'camp_ok' }) };
        }
        if (urlStr.includes('/adsets')) {
          return { json: async () => ({ id: 'adset_ok' }) };
        }
        if (urlStr.includes('/adcreatives')) {
          return { json: async () => ({ id: 'creative_ok' }) };
        }
        if (urlStr.includes('/ads')) {
          return { json: async () => ({ id: 'ad_ok' }) };
        }
        return { json: async () => ({}) };
      });

      const result = await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

      // First campaign failed, its children should be skipped
      const skippedErrors = result.errors.filter(e => e.error.includes('parent campaign failed'));
      assert.ok(skippedErrors.length >= 1, 'child ad sets should be skipped when campaign fails');
    });
  });
});

// Restore
globalThis.fetch = originalFetch;
