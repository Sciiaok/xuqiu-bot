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

// ── Mock MCP client ───────────────────────────────────────────────────
const mcpModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/meta-ads-mcp-client.js')).href;
let mcpCalls = [];
mock.module(mcpModuleUrl, {
  namedExports: {
    callTool: mock.fn(async (name, args) => {
      mcpCalls.push({ name, args });
      switch (name) {
        case 'upload_ad_image': return { image_hash: 'abc123hash' };
        case 'create_campaign': return { id: 'campaign_001' };
        case 'create_adset': return { id: 'adset_001' };
        case 'create_ad_creative': return { id: 'creative_001' };
        case 'create_ad': return { id: 'ad_001' };
        default: throw new Error(`Unknown tool: ${name}`);
      }
    }),
    listTools: mock.fn(async () => [
      { name: 'meta_create_campaign', description: 'Create campaign', inputSchema: { type: 'object', properties: {} } },
      { name: 'meta_create_adset', description: 'Create adset', inputSchema: { type: 'object', properties: {} } },
      { name: 'meta_create_ad', description: 'Create ad', inputSchema: { type: 'object', properties: {} } },
    ]),
  },
});

const MOCK_EXECUTION_RESULT = {
  status: 'completed',
  platform: 'meta',
  campaigns: [{ id: 'campaign_001', name: 'Lead Gen', ad_sets: [{ id: 'adset_001', name: 'Nigeria', ads: [{ ad_id: 'ad_001', name: 'Ad 1' }] }] }],
  errors: [],
};

// Claude tool_use mock — returns submit on first call to keep tests fast
let createCallCount = 0;

const mockCreate = mock.fn(async (params) => {
  createCallCount++;

  // If forced submit
  if (params.tool_choice?.name === 'submit_execution_result') {
    return {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 'tu_submit', name: 'submit_execution_result', input: MOCK_EXECUTION_RESULT }],
    };
  }

  // Return submit immediately to keep test fast
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'tu_submit', name: 'submit_execution_result', input: MOCK_EXECUTION_RESULT }],
  };
});

// Mock llm-client directly (the module exports an anthropicProxy, not raw Anthropic class)
const llmModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/llm-client.js')).href;
mock.module(llmModuleUrl, {
  namedExports: {
    anthropic: { messages: { create: mockCreate } },
    MODELS: { SONNET: 'claude-sonnet-4-6' },
  },
});

beforeEach(() => {
  mockCreate.mock.resetCalls();
  createCallCount = 0;
  mcpCalls = [];
});

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/execution-agent.service.js')).href;
const {
  executeMediaPlanMCP,
  previewExecution,
} = await import(moduleUrl);

describe('Execution Agent (MCP tool_use)', () => {
  describe('executeMediaPlanMCP (tool_use)', () => {
    it('Claude orchestrates campaign creation via tools', async () => {
      const plan = {
        platforms: [{
          platform: 'meta',
          budget_allocation: 100, budget_amount: 3000, rationale: 'MVP',
          campaigns: [{
            name: 'Lead Gen', objective: 'lead_gen', daily_budget: 100,
            ad_sets: [{
              name: 'Nigeria', targeting: { countries: ['NG'] },
              ads: [{ name: 'Ad 1', format: 'image', primary_text: 'Test', headline: 'Test', description: 'Test', cta: 'Learn More' }],
            }],
          }],
        }],
      };

      const result = await executeMediaPlanMCP(plan, { 'Ad 1': { image_hash: 'hash1' } });

      assert.equal(result.status, 'completed');
      assert.ok(result.campaigns.length > 0);

      // Claude should have been called at least once
      assert.ok(mockCreate.mock.callCount() >= 1);

      // First call should include submit_execution_result tool
      const firstCall = mockCreate.mock.calls[0].arguments[0];
      const toolNames = firstCall.tools.map(t => t.name);
      assert.ok(toolNames.includes('submit_execution_result'));
    });

    it('returns skipped when no Meta platform', async () => {
      const result = await executeMediaPlanMCP({ platforms: [{ platform: 'google', campaigns: [] }] });
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
