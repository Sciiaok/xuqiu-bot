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

// ── Mock config ───────────────────────────────────────────────────────
const configModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/config.js')).href;
mock.module(configModuleUrl, {
  namedExports: {
    config: {
      meta: { accessToken: 'test-meta-token', adAccountId: '123456789', pageId: '9988776655', apiVersion: 'v21.0' },
    },
  },
});

// ── Mock LLM client (unused but imported by the module) ───────────────
const llmModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/llm-client.js')).href;
mock.module(llmModuleUrl, {
  namedExports: {
    anthropic: { messages: { create: mock.fn(async () => ({ stop_reason: 'end_turn', content: [] })) } },
    MODELS: { SONNET: 'claude-sonnet-4-6' },
  },
});

// ── Import module under test ──────────────────────────────────────────
const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/execution-agent.service.js')).href;
const { uploadImages, createFullCampaign } = await import(moduleUrl);

// ── Helper to get callTool mock fn ────────────────────────────────────
const { callTool } = await import(mcpModuleUrl);

beforeEach(() => {
  mcpCalls = [];
  callTool.mock.resetCalls();
});

// ── uploadImages tests ────────────────────────────────────────────────
describe('uploadImages', () => {
  it('uploads multiple images via MCP and returns hash map', async () => {
    const images = [
      { name: 'hero', url: 'https://cdn.example.com/hero.jpg' },
      { name: 'banner', url: 'https://cdn.example.com/banner.png' },
    ];
    const result = await uploadImages(images);

    assert.equal(result.hero, 'hash_hero.jpg');
    assert.equal(result.banner, 'hash_banner.png');
    assert.equal(callTool.mock.callCount(), 2);
    assert.equal(callTool.mock.calls[0].arguments[0], 'upload_ad_image');
    assert.equal(callTool.mock.calls[0].arguments[1].image_url, 'https://cdn.example.com/hero.jpg');
  });

  it('reports onProgress for each image', async () => {
    const progressEvents = [];
    const images = [
      { name: 'img1', url: 'https://cdn.example.com/img1.jpg' },
      { name: 'img2', url: 'https://cdn.example.com/img2.jpg' },
    ];
    await uploadImages(images, { onProgress: e => progressEvents.push(e) });

    assert.equal(progressEvents.length, 2);
    assert.equal(progressEvents[0].step, 'upload_image');
    assert.equal(progressEvents[0].name, 'img1');
    assert.ok(progressEvents[0].image_hash);
    assert.equal(progressEvents[1].step, 'upload_image');
    assert.equal(progressEvents[1].name, 'img2');
  });

  it('records errors without stopping other uploads', async () => {
    // Make the first call throw, second succeed using a call counter
    let uploadCallCount = 0;
    callTool.mock.mockImplementation(async (name, args) => {
      if (name === 'upload_ad_image') {
        uploadCallCount++;
        if (uploadCallCount === 1) throw new Error('Network error');
        return { image_hash: 'hash_ok.jpg' };
      }
      throw new Error(`Unknown: ${name}`);
    });

    const progressEvents = [];
    const images = [
      { name: 'fail', url: 'https://cdn.example.com/fail.jpg' },
      { name: 'ok', url: 'https://cdn.example.com/ok.jpg' },
    ];
    const result = await uploadImages(images, { onProgress: e => progressEvents.push(e) });

    // Restore default implementation
    callTool.mock.mockImplementation(async (name, args) => {
      mcpCalls.push({ name, args });
      switch (name) {
        case 'upload_ad_image': return { image_hash: `hash_${args.image_url.split('/').pop()}` };
        case 'create_campaign': return { id: `camp_${mcpCalls.length}` };
        case 'create_adset': return { id: `adset_${mcpCalls.length}` };
        case 'create_ad_creative': return { id: `creative_${mcpCalls.length}` };
        case 'create_ad': return { id: `ad_${mcpCalls.length}` };
        default: throw new Error(`Unknown tool: ${name}`);
      }
    });

    // Second image should still succeed
    assert.equal(result.ok, 'hash_ok.jpg');
    // First image should not be in result
    assert.equal(result.fail, undefined);

    // Progress should record error for first
    const failEvent = progressEvents.find(e => e.name === 'fail');
    assert.ok(failEvent.error);
  });
});

// ── createFullCampaign tests ──────────────────────────────────────────
describe('createFullCampaign', () => {
  const baseCampaign = {
    name: 'Test Campaign',
    objective: 'traffic',
    daily_budget: 50,
    ad_sets: [{
      name: 'Set A',
      targeting: { countries: ['NG'], age_range: [25, 55] },
      ads: [{
        name: 'Ad 1',
        image_hash: 'hash_abc',
        primary_text: 'Click now',
        headline: 'Great deal',
        cta: 'Learn More',
        link_url: 'https://example.com',
      }],
    }],
  };

  it('creates campaign → adset → creative → ad in correct order', async () => {
    await createFullCampaign(baseCampaign);

    const toolNames = callTool.mock.calls.map(c => c.arguments[0]);
    assert.deepEqual(toolNames, ['create_campaign', 'create_adset', 'create_ad_creative', 'create_ad']);
  });

  it('reports onProgress for each entity', async () => {
    const events = [];
    await createFullCampaign(baseCampaign, { onProgress: e => events.push(e) });

    const steps = events.map(e => e.step);
    assert.ok(steps.includes('create_campaign'));
    assert.ok(steps.includes('create_adset'));
    assert.ok(steps.includes('create_ad'));
  });

  it('maps objective to Meta enum (lead_gen → OUTCOME_LEADS)', async () => {
    const input = { ...baseCampaign, objective: 'lead_gen' };
    await createFullCampaign(input);

    const campaignCall = callTool.mock.calls.find(c => c.arguments[0] === 'create_campaign');
    assert.equal(campaignCall.arguments[1].objective, 'OUTCOME_LEADS');
  });

  it('converts daily_budget to cents', async () => {
    const input = { ...baseCampaign, daily_budget: 75 };
    await createFullCampaign(input);

    const campaignCall = callTool.mock.calls.find(c => c.arguments[0] === 'create_campaign');
    assert.equal(campaignCall.arguments[1].daily_budget, 7500);
  });

  it('sets Advantage+ targeting on adset', async () => {
    await createFullCampaign(baseCampaign);

    const adsetCall = callTool.mock.calls.find(c => c.arguments[0] === 'create_adset');
    assert.deepEqual(adsetCall.arguments[1].targeting.targeting_automation, { advantage_audience: 1 });
  });

  it('clamps age for Advantage+ (min ≤ 18, max ≥ 65)', async () => {
    const input = {
      ...baseCampaign,
      ad_sets: [{
        ...baseCampaign.ad_sets[0],
        targeting: { countries: ['NG'], age_range: [25, 55] },
      }],
    };
    await createFullCampaign(input);

    const adsetCall = callTool.mock.calls.find(c => c.arguments[0] === 'create_adset');
    assert.ok(adsetCall.arguments[1].targeting.age_min <= 18, 'age_min should be ≤ 18');
    assert.ok(adsetCall.arguments[1].targeting.age_max >= 65, 'age_max should be ≥ 65');
  });

  it('sets promoted_object and destination_type for lead_gen', async () => {
    const input = {
      ...baseCampaign,
      objective: 'lead_gen',
      ad_sets: [{
        ...baseCampaign.ad_sets[0],
        ads: [{ ...baseCampaign.ad_sets[0].ads[0], lead_gen_form_id: 'form_123' }],
      }],
    };
    await createFullCampaign(input);

    const adsetCall = callTool.mock.calls.find(c => c.arguments[0] === 'create_adset');
    assert.deepEqual(adsetCall.arguments[1].promoted_object, { page_id: '9988776655' });
    assert.equal(adsetCall.arguments[1].destination_type, 'ON_AD');
  });

  it('passes lead_gen_form_id to ad creative call_to_action', async () => {
    const input = {
      ...baseCampaign,
      objective: 'lead_gen',
      ad_sets: [{
        ...baseCampaign.ad_sets[0],
        ads: [{ ...baseCampaign.ad_sets[0].ads[0], lead_gen_form_id: 'form_456' }],
      }],
    };
    await createFullCampaign(input);

    const creativeCall = callTool.mock.calls.find(c => c.arguments[0] === 'create_ad_creative');
    assert.equal(creativeCall.arguments[1].call_to_action.value.lead_gen_form_id, 'form_456');
  });

  it('skips adset children when adset creation fails', async () => {
    // Make create_adset throw
    callTool.mock.mockImplementation(async (name, args) => {
      mcpCalls.push({ name, args });
      if (name === 'create_adset') throw new Error('Adset error');
      if (name === 'create_campaign') return { id: 'camp_test' };
      if (name === 'create_ad_creative') return { id: 'creative_test' };
      if (name === 'create_ad') return { id: 'ad_test' };
      throw new Error(`Unknown: ${name}`);
    });

    const result = await createFullCampaign(baseCampaign);

    // Restore default implementation
    callTool.mock.mockImplementation(async (name, args) => {
      mcpCalls.push({ name, args });
      switch (name) {
        case 'upload_ad_image': return { image_hash: `hash_${args.image_url.split('/').pop()}` };
        case 'create_campaign': return { id: `camp_${mcpCalls.length}` };
        case 'create_adset': return { id: `adset_${mcpCalls.length}` };
        case 'create_ad_creative': return { id: `creative_${mcpCalls.length}` };
        case 'create_ad': return { id: `ad_${mcpCalls.length}` };
        default: throw new Error(`Unknown tool: ${name}`);
      }
    });

    assert.equal(result.ad_sets.length, 0);
    assert.ok(result.errors.some(e => e.level === 'adset'));
    // create_ad should NOT have been called
    assert.ok(!callTool.mock.calls.some(c => c.arguments[0] === 'create_ad'));
  });

  it('skips all children when campaign creation fails', async () => {
    callTool.mock.mockImplementation(async (name, args) => {
      mcpCalls.push({ name, args });
      if (name === 'create_campaign') throw new Error('Campaign error');
      throw new Error(`Should not reach: ${name}`);
    });

    const result = await createFullCampaign(baseCampaign);

    // Restore default
    callTool.mock.mockImplementation(async (name, args) => {
      mcpCalls.push({ name, args });
      switch (name) {
        case 'upload_ad_image': return { image_hash: `hash_${args.image_url.split('/').pop()}` };
        case 'create_campaign': return { id: `camp_${mcpCalls.length}` };
        case 'create_adset': return { id: `adset_${mcpCalls.length}` };
        case 'create_ad_creative': return { id: `creative_${mcpCalls.length}` };
        case 'create_ad': return { id: `ad_${mcpCalls.length}` };
        default: throw new Error(`Unknown tool: ${name}`);
      }
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.campaign_id, null);
    assert.equal(result.ad_sets.length, 0);
    assert.ok(result.errors.some(e => e.level === 'campaign'));
    // Only create_campaign should have been called
    assert.equal(callTool.mock.callCount(), 1);
  });

  it('continues other ads when one ad has no image_hash', async () => {
    const input = {
      ...baseCampaign,
      ad_sets: [{
        name: 'Set A',
        targeting: { countries: ['NG'] },
        ads: [
          { name: 'Ad No Image' /* no image_hash */ },
          { name: 'Ad With Image', image_hash: 'hash_abc', primary_text: 'x', headline: 'y', cta: 'Learn More', link_url: 'https://x.com' },
        ],
      }],
    };
    const result = await createFullCampaign(input);

    // Second ad should succeed
    assert.ok(result.ad_sets[0].ads.some(a => a.name === 'Ad With Image'));
    // First ad should be recorded as error
    assert.ok(result.errors.some(e => e.name === 'Ad No Image'));
  });
});
