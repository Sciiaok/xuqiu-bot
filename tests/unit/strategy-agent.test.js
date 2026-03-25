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
    },
  },
});

const SAMPLE_MEDIA_PLAN = {
  summary: 'Meta-focused lead generation campaign targeting Nigerian homeowners',
  total_budget: 5000,
  currency: 'USD',
  duration_days: 30,
  platforms: [{
    platform: 'meta',
    budget_allocation: 80,
    budget_amount: 4000,
    rationale: 'Strong presence in target market',
    campaigns: [{
      name: 'Lead Gen - Nigeria',
      objective: 'lead_gen',
      daily_budget: 100,
      ad_sets: [{
        name: 'Homeowners 25-55',
        targeting: { countries: ['NG'], age_range: [25, 55], interests: ['solar energy'] },
        optimization_goal: 'lead_generation',
        ads: [{
          name: 'Product Demo',
          format: 'image',
          primary_text: 'Power your home with CFE-5',
          headline: 'Never Lose Power Again',
          description: '5.12kWh home battery',
          cta: 'Learn More',
          media_requirements: { type: 'image', specs: '1080x1080' },
        }],
      }],
    }],
  }],
};

let createCallCount = 0;
const mockCreate = mock.fn(async (params) => {
  createCallCount++;

  // If forced to call submit_media_plan
  if (params.tool_choice?.name === 'submit_media_plan') {
    return {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_submit', name: 'submit_media_plan', input: SAMPLE_MEDIA_PLAN }],
    };
  }

  // First call: Claude calls data-gathering tools
  if (createCallCount === 1) {
    return {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use', id: 'tu_1', name: 'allocate_budget',
          input: { total_budget: 5000, currency: 'USD', duration_days: 30, objectives: ['lead_gen'], platforms: ['meta'] },
        },
        {
          type: 'tool_use', id: 'tu_2', name: 'generate_audience_segments',
          input: { industry: 'energy storage', target_countries: ['Nigeria'], target_audience: { age_range: [25, 55] } },
        },
      ],
    };
  }

  // Second call: Claude submits the plan
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tu_submit', name: 'submit_media_plan', input: SAMPLE_MEDIA_PLAN }],
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
});

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/strategy-agent.service.js')).href;
const { generateMediaPlan, allocateBudget, generateKeywords, generateAudienceSegments } = await import(moduleUrl);

const BRIEF = {
  company_name: 'CF Energy',
  industry: 'energy storage',
  products: [{ model: 'CFE-5', category: 'Residential ESS' }],
  target_countries: ['Nigeria'],
  target_audience: { age_range: [25, 55], gender: 'all', interests: ['solar energy'] },
  budget_total: 5000,
  budget_currency: 'USD',
  campaign_duration_days: 30,
  objectives: ['lead_gen'],
  preferred_platforms: ['meta'],
};

const RESEARCH = {
  platform_recommendations: [{ platform: 'meta', fit_score: 9 }],
  keyword_trends: { high_volume_keywords: ['solar panel price'] },
  audience_insights: { primary_segments: [{ name: 'Homeowners' }] },
};

describe('Strategy Agent (tool_use)', () => {
  describe('generateMediaPlan', () => {
    it('uses Claude tool_use loop: calls tools then submits plan', async () => {
      const plan = await generateMediaPlan(BRIEF, RESEARCH);

      assert.ok(plan.summary);
      assert.ok(Array.isArray(plan.platforms));
      assert.equal(plan.platforms[0].platform, 'meta');
      assert.ok(plan.platforms[0].campaigns.length > 0);

      // Claude should have been called at least twice
      assert.ok(mockCreate.mock.callCount() >= 2);

      // First call should include strategy tools
      const firstCall = mockCreate.mock.calls[0].arguments[0];
      const toolNames = firstCall.tools.map(t => t.name);
      assert.ok(toolNames.includes('allocate_budget'));
      assert.ok(toolNames.includes('generate_keywords'));
      assert.ok(toolNames.includes('generate_audience_segments'));
      assert.ok(toolNames.includes('submit_media_plan'));

      // Prompt should include both brief and research
      assert.ok(firstCall.messages[0].content.includes('CF Energy'));
      assert.ok(firstCall.messages[0].content.includes('MARKET RESEARCH REPORT'));
    });

    it('throws on invalid plan (missing platforms)', async () => {
      const badPlan = { summary: 'test' };
      mockCreate.mock.mockImplementationOnce(async () => ({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'tu_1', name: 'submit_media_plan', input: badPlan }],
      }));
      createCallCount = 99; // Skip normal flow

      await assert.rejects(() => generateMediaPlan(BRIEF, RESEARCH), /missing platforms/i);
    });
  });

  describe('allocateBudget (standalone)', () => {
    it('computes budget allocation based on platform fit scores', () => {
      const result = allocateBudget({
        total_budget: 5000,
        currency: 'USD',
        duration_days: 30,
        objectives: ['lead_gen'],
        platforms: ['meta', 'google'],
        platform_fit_scores: [{ platform: 'meta', fit_score: 9 }, { platform: 'google', fit_score: 3 }],
      });

      assert.ok(result.allocations.length === 2);
      // Meta should get higher allocation due to higher fit score
      const meta = result.allocations.find(a => a.platform === 'meta');
      const google = result.allocations.find(a => a.platform === 'google');
      assert.ok(meta.percentage > google.percentage);
    });
  });

  describe('generateKeywords (standalone)', () => {
    it('returns keyword groups for products', () => {
      const result = generateKeywords({
        industry: 'energy storage',
        products: ['CFE-5'],
        target_countries: ['Nigeria'],
        trending_keywords: ['home battery 2026'],
      });

      assert.ok(result.keyword_groups.length >= 2);
      const productGroup = result.keyword_groups.find(g => g.theme === 'product');
      assert.ok(productGroup.keywords.length > 0);
    });
  });

  describe('generateAudienceSegments (standalone)', () => {
    it('returns audience segments', () => {
      const result = generateAudienceSegments({
        industry: 'energy storage',
        target_countries: ['Nigeria'],
        target_audience: { age_range: [25, 55], interests: ['solar'] },
      });

      assert.ok(result.segments.length >= 1);
      assert.equal(result.segments[0].priority, 'primary');
    });
  });
});
