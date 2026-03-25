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
        adAccountId: '123456',
        apiVersion: 'v21.0',
      },
      serpapi: {
        apiKey: 'test-serpapi-key',
      },
    },
  },
});

// Track Claude API calls
const MOCK_REPORT = {
  market_overview: { market_size_estimate: '$5B', growth_trend: 'growing', key_players: ['A'], market_characteristics: ['price-sensitive'] },
  competitor_ads: { summary: 'Competitors focus on price', common_formats: ['video'], common_messaging: ['affordable'], gaps_and_opportunities: ['no WhatsApp CTA'] },
  keyword_trends: { high_volume_keywords: ['solar panel price'], rising_keywords: ['home battery'], seasonal_patterns: 'Peak Q4' },
  audience_insights: { primary_segments: [{ name: 'Homeowners' }], platform_preferences: { meta: 'strong' }, content_preferences: ['video'] },
  platform_recommendations: [{ platform: 'meta', fit_score: 9, rationale: 'Strong in Africa' }],
  benchmark_metrics: { estimated_cpm: '$3-8', estimated_cpc: '$0.15', estimated_ctr: '2%', estimated_cpl: '$3' },
  recommendations: ['Start with Meta'],
};

let createCallCount = 0;
const mockCreate = mock.fn(async (params) => {
  createCallCount++;
  const messages = params.messages || [];
  const lastMsg = messages[messages.length - 1];

  // If forced to call submit_report
  if (params.tool_choice?.name === 'submit_report') {
    return {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_submit', name: 'submit_report', input: MOCK_REPORT }],
    };
  }

  // First call: Claude calls search tools
  if (createCallCount === 1) {
    return {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'search_meta_ad_library', input: { search_terms: 'energy storage', countries: ['Nigeria'] } },
        { type: 'tool_use', id: 'tu_2', name: 'search_google_trends', input: { keywords: ['solar panel', 'home battery'] } },
      ],
    };
  }

  // Second call: Claude has tool results, submits report
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tu_submit', name: 'submit_report', input: MOCK_REPORT }],
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

// Mock fetch for external APIs
const originalFetch = globalThis.fetch;
let fetchMock;

beforeEach(() => {
  mockCreate.mock.resetCalls();
  createCallCount = 0;
  fetchMock = mock.fn(async (url) => {
    if (typeof url === 'string' && url.includes('graph.facebook.com')) {
      return {
        json: async () => ({
          data: [{ page_name: 'SolarCo', ad_creative_bodies: ['Best solar panels'], ad_delivery_start_time: '2026-01-15' }],
        }),
      };
    }
    if (typeof url === 'string' && url.includes('serpapi.com')) {
      return {
        json: async () => ({
          interest_over_time: { timeline_data: [{ date: '2026-01' }] },
          related_queries: { rising: [{ query: 'home battery' }] },
        }),
      };
    }
    return { json: async () => ({}) };
  });
  globalThis.fetch = fetchMock;
});

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/research-agent.service.js')).href;
const { conductResearch, fetchMetaAdLibrary, fetchGoogleTrends } = await import(moduleUrl);

describe('Research Agent (tool_use)', () => {
  describe('conductResearch', () => {
    it('uses Claude tool_use loop: calls search tools then submits report', async () => {
      const brief = {
        company_name: 'CF Energy',
        industry: 'energy storage',
        products: [{ model: 'CFE-5', category: 'Residential ESS' }],
        target_countries: ['Nigeria'],
      };

      const report = await conductResearch(brief);

      // Should return the submitted report
      assert.ok(report.market_overview);
      assert.ok(report.recommendations);
      assert.deepEqual(report.recommendations, ['Start with Meta']);

      // Claude should have been called at least twice (tools call + submit)
      assert.ok(mockCreate.mock.callCount() >= 2, `Expected >= 2 Claude calls, got ${mockCreate.mock.callCount()}`);

      // First call should include tools
      const firstCall = mockCreate.mock.calls[0].arguments[0];
      assert.ok(firstCall.tools.length >= 3, 'Should have search_meta_ad_library, search_google_trends, submit_report tools');
      assert.equal(firstCall.tools[0].name, 'search_meta_ad_library');
      assert.equal(firstCall.tools[1].name, 'search_google_trends');
      assert.equal(firstCall.tools[2].name, 'submit_report');

      // Second call should include tool results
      const secondCall = mockCreate.mock.calls[1].arguments[0];
      const toolResultMsg = secondCall.messages.find(m =>
        Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
      );
      assert.ok(toolResultMsg, 'Should pass tool results back to Claude');
    });
  });

  describe('fetchMetaAdLibrary', () => {
    it('queries Meta Ad Library API with tool input format', async () => {
      const result = await fetchMetaAdLibrary({
        search_terms: 'solar energy',
        countries: ['Nigeria', 'Kenya'],
      });

      assert.ok(result.available);
      assert.ok(result.ads.length > 0);
      assert.equal(result.ads[0].page_name, 'SolarCo');
    });

    it('returns unavailable when API errors', async () => {
      globalThis.fetch = mock.fn(async () => ({
        json: async () => ({ error: { message: 'Invalid token' } }),
      }));

      const result = await fetchMetaAdLibrary({
        search_terms: 'test',
        countries: ['US'],
      });

      assert.ok(result.available);
      assert.ok(result.error);
    });
  });

  describe('fetchGoogleTrends', () => {
    it('queries SerpAPI with tool input format', async () => {
      const result = await fetchGoogleTrends({
        keywords: ['solar panel', 'home battery'],
      });

      assert.ok(result.available);
      assert.ok(result.trends.length > 0);
      assert.equal(result.trends[0].keyword, 'solar panel');
    });
  });
});

globalThis.fetch = originalFetch;
