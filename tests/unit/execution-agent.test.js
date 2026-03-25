import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const configModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/config.js')).href;

mock.module(configModuleUrl, {
  namedExports: {
    config: {
      anthropic: {
        apiKey: 'test-openrouter-key',
        baseURL: 'https://openrouter.ai/api',
        model: 'claude-sonnet-4-6',
      },
      meta: {
        accessToken: 'test-meta-token',
        adAccountId: '123456789',
        apiVersion: 'v21.0',
      },
      whatsapp: {
        phoneNumberId: '999888777',
      },
    },
  },
});

const originalFetch = globalThis.fetch;
let fetchMock;
let fetchCalls;

// Claude tool_use mock
let createCallCount = 0;

const MOCK_EXECUTION_RESULT = {
  status: 'completed',
  platform: 'meta',
  campaigns: [{ id: 'campaign_001', name: 'Lead Gen', ad_sets: [{ id: 'adset_001', name: 'Nigeria', ads: [{ ad_id: 'ad_001', name: 'Ad 1' }] }] }],
  errors: [],
};

const mockCreate = mock.fn(async (params) => {
  createCallCount++;

  // If forced submit
  if (params.tool_choice?.name === 'submit_execution_result') {
    return {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_submit', name: 'submit_execution_result', input: MOCK_EXECUTION_RESULT }],
    };
  }

  // First call: Claude creates campaign
  if (createCallCount === 1) {
    return {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'tu_1', name: 'meta_create_campaign',
        input: { name: 'Lead Gen', objective: 'lead_gen', daily_budget: 100 },
      }],
    };
  }

  // Second call: Claude creates ad set
  if (createCallCount === 2) {
    return {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'tu_2', name: 'meta_create_adset',
        input: {
          campaign_id: 'campaign_001', name: 'Nigeria', daily_budget: 100,
          targeting: { countries: ['NG'], age_range: [25, 55] },
          optimization_goal: 'lead_generation',
        },
      }],
    };
  }

  // Third call: Claude creates ad
  if (createCallCount === 3) {
    return {
      stop_reason: 'tool_use',
      content: [{
        type: 'tool_use', id: 'tu_3', name: 'meta_create_ad',
        input: {
          adset_id: 'adset_001', name: 'Ad 1',
          primary_text: 'Power up', headline: 'Battery', description: 'Reliable',
          cta: 'Learn More', image_hash: 'hash1', link_url: 'https://example.com',
        },
      }],
    };
  }

  // Fourth call: Claude submits results
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tu_submit', name: 'submit_execution_result', input: MOCK_EXECUTION_RESULT }],
  };
});

const anthropicModuleUrl = pathToFileURL(resolve(process.cwd(), 'node_modules/@anthropic-ai/sdk/index.mjs')).href;
mock.module(anthropicModuleUrl, {
  defaultExport: class Anthropic {
    constructor() {
      this.messages = { create: mockCreate };
    }
  },
});

beforeEach(() => {
  mockCreate.mock.resetCalls();
  createCallCount = 0;
  fetchCalls = [];
  fetchMock = mock.fn(async (url, options) => {
    fetchCalls.push({ url: typeof url === 'string' ? url : url.toString(), options });

    if (typeof url === 'string') {
      if (url.includes('/adimages')) {
        return { json: async () => ({ images: { 'ad_image.png': { hash: 'abc123hash' } } }) };
      }
      if (url.includes('/campaigns')) {
        return { json: async () => ({ id: 'campaign_001' }) };
      }
      if (url.includes('/adsets')) {
        return { json: async () => ({ id: 'adset_001' }) };
      }
      if (url.includes('/adcreatives')) {
        return { json: async () => ({ id: 'creative_001' }) };
      }
      if (url.includes('/ads') && !url.includes('/adsets') && !url.includes('/adimages') && !url.includes('/adcreatives')) {
        return { json: async () => ({ id: 'ad_001' }) };
      }
    }
    return { json: async () => ({}) };
  });
  globalThis.fetch = fetchMock;
});

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/execution-agent.service.js')).href;
const {
  uploadMedia,
  createCampaign,
  createAdSet,
  createAd,
  executeMediaPlan,
  previewExecution,
} = await import(moduleUrl);

describe('Execution Agent (tool_use)', () => {
  describe('low-level Meta API functions', () => {
    it('uploadMedia — uploads image and returns hash', async () => {
      const result = await uploadMedia(Buffer.from('fake'), 'test.png');
      assert.equal(result.image_hash, 'abc123hash');
    });

    it('createCampaign — maps objective and sends cents', async () => {
      const result = await createCampaign({ name: 'Test', objective: 'lead_gen', daily_budget: 100 });
      assert.equal(result.id, 'campaign_001');

      const call = fetchCalls.find(c => c.url.includes('/campaigns'));
      const body = JSON.parse(call.options.body);
      assert.equal(body.objective, 'OUTCOME_LEADS');
      assert.equal(body.daily_budget, 10000);
      assert.equal(body.status, 'PAUSED');
    });

    it('createAdSet — builds Meta targeting spec', async () => {
      await createAdSet({
        campaign_id: 'c1', name: 'Test', daily_budget: 50,
        targeting: { countries: ['NG'], age_range: [25, 55], gender: 'male', interests: ['solar'] },
        optimization_goal: 'lead_generation',
      });

      const call = fetchCalls.find(c => c.url.includes('/adsets'));
      const body = JSON.parse(call.options.body);
      assert.deepEqual(body.targeting.geo_locations.countries, ['NG']);
      assert.equal(body.targeting.age_min, 25);
      assert.deepEqual(body.targeting.genders, [1]);
    });

    it('createAd — creates creative + ad in two calls', async () => {
      const result = await createAd({
        adset_id: 'as1', name: 'Ad 1',
        primary_text: 'Power up', headline: 'Battery', description: 'Reliable',
        cta: 'Send WhatsApp', image_hash: 'hash1', link_url: 'https://wa.me/123',
      });

      assert.equal(result.creative_id, 'creative_001');
      assert.equal(result.ad_id, 'ad_001');

      const creativeCall = fetchCalls.find(c => c.url.includes('/adcreatives'));
      const body = JSON.parse(creativeCall.options.body);
      assert.equal(body.object_story_spec.link_data.call_to_action.type, 'WHATSAPP_MESSAGE');
    });
  });

  describe('executeMediaPlan (tool_use)', () => {
    it('Claude orchestrates campaign creation via tools', async () => {
      const plan = {
        platforms: [{
          platform: 'meta',
          budget_allocation: 100, budget_amount: 3000, rationale: 'MVP',
          campaigns: [{
            name: 'Lead Gen', objective: 'lead_gen', daily_budget: 100,
            ad_sets: [{
              name: 'Nigeria', targeting: { countries: ['NG'] },
              optimization_goal: 'lead_generation',
              ads: [{ name: 'Ad 1', format: 'image', primary_text: 'Test', headline: 'Test', description: 'Test', cta: 'Learn More' }],
            }],
          }],
        }],
      };

      const result = await executeMediaPlan(plan, { 'Ad 1': { image_hash: 'hash1' } });

      assert.equal(result.status, 'completed');
      assert.ok(result.campaigns.length > 0);

      // Claude should have been called multiple times (campaign + adset + ad + submit)
      assert.ok(mockCreate.mock.callCount() >= 3);

      // First call should include execution tools
      const firstCall = mockCreate.mock.calls[0].arguments[0];
      const toolNames = firstCall.tools.map(t => t.name);
      assert.ok(toolNames.includes('meta_create_campaign'));
      assert.ok(toolNames.includes('meta_create_adset'));
      assert.ok(toolNames.includes('meta_create_ad'));
      assert.ok(toolNames.includes('submit_execution_result'));
    });

    it('returns skipped when no Meta platform', async () => {
      const result = await executeMediaPlan({ platforms: [{ platform: 'google', campaigns: [] }] });
      assert.equal(result.status, 'skipped');
    });
  });

  describe('previewExecution', () => {
    it('generates human-readable preview', () => {
      const plan = {
        platforms: [{
          platform: 'meta', budget_allocation: 100, budget_amount: 3000, rationale: 'MVP',
          campaigns: [{
            name: 'Test Campaign', objective: 'lead_gen', daily_budget: 100,
            ad_sets: [{
              name: 'Nigeria', targeting: { countries: ['NG'], age_range: [25, 55], interests: ['solar'] },
              ads: [{ name: 'Ad 1', format: 'image', headline: 'Test', cta: 'Learn More' }],
            }],
          }],
        }],
      };

      const { preview, entity_counts } = previewExecution(plan);
      assert.ok(preview.includes('Test Campaign'));
      assert.equal(entity_counts.campaigns, 1);
      assert.equal(entity_counts.ad_sets, 1);
      assert.equal(entity_counts.ads, 1);
    });
  });
});

globalThis.fetch = originalFetch;
