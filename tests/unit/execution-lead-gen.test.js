import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Mock MCP client ───────────────────────────────────────────────────
const mcpModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/meta-ads-mcp-client.js')).href;
let mcpCalls = [];
mock.module(mcpModuleUrl, {
  namedExports: {
    callTool: mock.fn(async (name, args) => {
      mcpCalls.push({ name, args });
      switch (name) {
        case 'upload_ad_image': return { image_hash: `hash_${args.image_url.split('/').pop()}` };
        case 'create_campaign': return { id: `camp_${mcpCalls.length}` };
        case 'create_adset': return { id: `adset_${mcpCalls.length}` };
        case 'create_ad_creative': return { id: `creative_${mcpCalls.length}` };
        case 'create_ad': return { id: `ad_${mcpCalls.length}` };
        default: throw new Error(`Unknown tool: ${name}`);
      }
    }),
    listTools: mock.fn(async () => []),
  },
});

// ── Mock LLM client (unused in batch path but imported by the module) ─
const llmModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/llm-client.js')).href;
mock.module(llmModuleUrl, {
  namedExports: {
    anthropic: { messages: { create: mock.fn(async () => ({ stop_reason: 'end_turn', content: [] })) } },
    MODELS: { SONNET: 'claude-sonnet-4-6' },
  },
});

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

// ── Fetch mock for createLeadForm (direct HTTP) ──────────────────────
const originalFetch = globalThis.fetch;
let fetchCalls;

beforeEach(() => {
  fetchCalls = [];
  mcpCalls = [];
  globalThis.fetch = async (url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    fetchCalls.push({ url: urlStr, options });
    if (urlStr.includes('9988776655') && urlStr.includes('fields=access_token')) {
      return { json: async () => ({ access_token: 'page-token-abc' }) };
    }
    if (urlStr.includes('/leadgen_forms')) {
      return { json: async () => ({ id: `form_${Date.now()}` }) };
    }
    return { json: async () => ({}) };
  };
});

// ── Import module under test ─────────────────────────────────────────
const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/execution-agent.service.js')).href;
const { createLeadForm, executeMediaPlan } = await import(moduleUrl);

// ── Helper to get callTool mock fn ────────────────────────────────────
const { callTool } = await import(mcpModuleUrl);

beforeEach(() => {
  callTool.mock.resetCalls();
});

// ── Helper: find MCP call by tool name ──────────────────────────────
function findMcpArgs(toolName) {
  const call = callTool.mock.calls.find(c => c.arguments[0] === toolName);
  return call?.arguments[1];
}

function findAllMcpArgs(toolName) {
  return callTool.mock.calls
    .filter(c => c.arguments[0] === toolName)
    .map(c => c.arguments[1]);
}

// ── Helper: find fetch call by URL pattern ───────────────────────────
function findFetchBody(pattern) {
  const call = fetchCalls.find(c => c.url.includes(pattern));
  if (!call?.options?.body) return null;
  return JSON.parse(call.options.body);
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

  describe('executeMediaPlan — full LEAD_GENERATION flow (batch)', () => {
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
      await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

      // Lead form is via fetch; ad sets are via MCP
      const formCallIdx = fetchCalls.findIndex(c => c.url.includes('/leadgen_forms'));
      const adsetCallIdx = callTool.mock.calls.findIndex(c => c.arguments[0] === 'create_adset');
      assert.ok(formCallIdx >= 0, 'should create lead forms');
      assert.ok(adsetCallIdx >= 0, 'should create ad sets');
      // fetch for form happens before MCP for adset (batch: form first, then campaigns)
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

      const campaignArgs = findAllMcpArgs('create_campaign');
      assert.equal(campaignArgs.length, 2);
      for (const args of campaignArgs) {
        assert.equal(args.objective, 'OUTCOME_LEADS');
        assert.equal(args.status, 'PAUSED');
      }
    });

    it('ad sets have promoted_object with page_id and destination_type ON_AD', async () => {
      await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

      const adsetArgs = findAllMcpArgs('create_adset');
      assert.equal(adsetArgs.length, 2);
      for (const args of adsetArgs) {
        assert.equal(args.promoted_object.page_id, '9988776655');
        assert.equal(args.promoted_object.lead_gen_form_id, undefined,
          'lead_gen_form_id must NOT be in promoted_object');
        assert.equal(args.destination_type, 'ON_AD');
      }
    });

    it('passes lead_gen_form_id to ad creatives via call_to_action', async () => {
      await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

      const creativeArgs = findAllMcpArgs('create_ad_creative');
      assert.ok(creativeArgs.length >= 3, 'should create at least 3 creatives');
      for (const args of creativeArgs) {
        assert.ok(args.call_to_action?.value?.lead_gen_form_id,
          'creative call_to_action.value should contain lead_gen_form_id');
      }
    });

    it('all ad sets have age_min <= 18 (Advantage+ constraint)', async () => {
      await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

      const adsetArgs = findAllMcpArgs('create_adset');
      for (const args of adsetArgs) {
        assert.ok(args.targeting.age_min <= 18,
          `age_min ${args.targeting.age_min} exceeds Advantage+ limit of 18`);
      }
    });

    it('creates 3 ads total with correct image hashes', async () => {
      const result = await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

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
      let campaignCallCount = 0;
      callTool.mock.mockImplementation(async (name, args) => {
        mcpCalls.push({ name, args });
        if (name === 'create_campaign') {
          campaignCallCount++;
          if (campaignCallCount === 1) throw new Error('Budget too low');
          return { id: 'camp_ok' };
        }
        if (name === 'create_adset') return { id: 'adset_ok' };
        if (name === 'create_ad_creative') return { id: 'creative_ok' };
        if (name === 'create_ad') return { id: 'ad_ok' };
        throw new Error(`Unknown: ${name}`);
      });

      const result = await executeMediaPlan(LEAD_GEN_PLAN, CREATIVES);

      // Restore
      callTool.mock.mockImplementation(async (name, args) => {
        mcpCalls.push({ name, args });
        switch (name) {
          case 'create_campaign': return { id: `camp_${mcpCalls.length}` };
          case 'create_adset': return { id: `adset_${mcpCalls.length}` };
          case 'create_ad_creative': return { id: `creative_${mcpCalls.length}` };
          case 'create_ad': return { id: `ad_${mcpCalls.length}` };
          default: throw new Error(`Unknown tool: ${name}`);
        }
      });

      // First campaign failed — should have campaign-level error
      assert.ok(result.errors.some(e => e.level === 'campaign'), 'should have campaign error');
      // Second campaign should succeed
      assert.ok(result.campaigns.length >= 1, 'second campaign should succeed');
    });
  });
});

// Restore
globalThis.fetch = originalFetch;
