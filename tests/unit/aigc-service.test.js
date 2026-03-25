import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/aigc.service.js')).href;
const configModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/config.js')).href;
const supabaseModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/supabase.js')).href;

// Mock config
mock.module(configModuleUrl, {
  namedExports: {
    config: {
      aigc: {
        apiKey: 'test-key',
        baseURL: 'https://openrouter.ai/api',
        imageModel: 'openai/gpt-5-image',
        storageBucket: 'aigc-assets',
      },
      anthropic: {
        apiKey: 'test-key',
        model: 'claude-sonnet-4-6',
      },
    },
  },
});

// Chainable query builder mock — tracks filter calls and returns canned data
function createQueryMock(cannedData = [], cannedCount = 0) {
  const state = { eqCalls: [] };
  const chain = {
    select: () => chain,
    eq: (col, val) => { state.eqCalls.push({ col, val }); return chain; },
    order: () => chain,
    range: () => chain,
    single: async () => ({ data: cannedData[0] || null, error: null }),
    then: (resolve) => resolve({ data: cannedData, error: null, count: cannedCount }),
    _state: state,
  };
  // Make chain thenable so `await query` works
  chain[Symbol.for('nodejs.util.promisify.custom')] = undefined;
  return chain;
}

let lastQueryMock = null;

mock.module(supabaseModuleUrl, {
  defaultExport: {
    from: (table) => {
      if (table === 'aigc_assets') {
        lastQueryMock = createQueryMock(
          [
            { id: 'asset-1', conversation_id: 'conv-1', user_id: 'user-1', model: 'gemini', storage_path: 'generated/1.png', metadata: {}, created_at: '2026-03-23T00:00:00Z' },
            { id: 'asset-2', conversation_id: 'conv-1', user_id: 'user-1', model: 'gpt5', storage_path: 'generated/2.png', metadata: {}, created_at: '2026-03-22T00:00:00Z' },
          ],
          2
        );
        return { select: () => lastQueryMock, insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'test-uuid' }, error: null }) }) }) };
      }
      return { insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'test-uuid' }, error: null }) }) }) };
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: (path) => ({ data: { publicUrl: `https://storage.test/${path}` } }),
      }),
    },
  },
});

const mod = await import(`${moduleUrl}?test=${Date.now()}`);
const { buildAdPrompt, extractBase64Image, saveGeneratedAsset, getAssets } = mod;

// ─── extractBase64Image ───

describe('extractBase64Image', () => {
  it('extracts from GPT-5 images[] format', () => {
    const msg = { images: [{ image_url: { url: 'data:image/png;base64,AAAA' } }] };
    assert.equal(extractBase64Image(msg), 'AAAA');
  });

  it('extracts from GPT-5 images[] raw string format', () => {
    const msg = { images: ['data:image/png;base64,RAW_B64'] };
    assert.equal(extractBase64Image(msg), 'RAW_B64');
  });

  it('extracts from Gemini multimodal content[] format', () => {
    const msg = { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }] };
    assert.equal(extractBase64Image(msg), 'BBBB');
  });

  it('skips text parts in Gemini content[]', () => {
    const msg = { content: [
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,CCCC' } },
    ]};
    assert.equal(extractBase64Image(msg), 'CCCC');
  });

  it('returns null when no image present', () => {
    assert.equal(extractBase64Image({ content: 'just text' }), null);
    assert.equal(extractBase64Image({}), null);
  });

  it('returns null for empty images array', () => {
    assert.equal(extractBase64Image({ images: [] }), null);
  });

  it('returns null for empty content array', () => {
    assert.equal(extractBase64Image({ content: [] }), null);
  });
});

// ─── buildAdPrompt ───

describe('buildAdPrompt', () => {
  it('builds prompt with full product info', () => {
    const result = buildAdPrompt({
      productInfo: {
        company_name: 'CF Energy',
        products: [{
          model: 'CFE-5',
          category: 'Residential ESS',
          key_specs: { capacity: '5.12kWh', voltage: '51.2V' },
          selling_points: ['6000 cycles', 'WiFi enabled', 'LFP chemistry'],
        }],
      },
      userPrompt: 'Target African market',
      format: '1080x1080',
    });

    assert.ok(result.includes('CF Energy'));
    assert.ok(result.includes('CFE-5'));
    assert.ok(result.includes('Residential ESS'));
    assert.ok(result.includes('5.12kWh'));
    assert.ok(result.includes('6000 cycles'));
    assert.ok(result.includes('Target African market'));
    assert.ok(result.includes('1080x1080'));
    assert.ok(result.includes('WhatsApp'));
  });

  it('handles null product info gracefully', () => {
    const result = buildAdPrompt({
      productInfo: null,
      userPrompt: 'Generic ad',
    });

    assert.ok(result.includes('Our Company'));
    assert.ok(result.includes('Generic ad'));
    assert.ok(result.includes('1080x1080'));
  });

  it('handles product with no specs or selling points', () => {
    const result = buildAdPrompt({
      productInfo: {
        company_name: 'TestCo',
        products: [{ model: 'X1', category: 'Widget' }],
      },
      userPrompt: 'Make it pop',
    });

    assert.ok(result.includes('TestCo'));
    assert.ok(result.includes('X1'));
    assert.ok(result.includes('Widget'));
  });

  it('uses default format when not specified', () => {
    const result = buildAdPrompt({ productInfo: null, userPrompt: 'test' });
    assert.ok(result.includes('1080x1080'));
  });

  it('handles empty products array', () => {
    const result = buildAdPrompt({
      productInfo: { company_name: 'Acme', products: [] },
      userPrompt: 'ad',
    });
    assert.ok(result.includes('Acme'));
    assert.ok(result.includes('Product'));
  });

  it('limits selling points to 3', () => {
    const result = buildAdPrompt({
      productInfo: {
        company_name: 'Co',
        products: [{
          model: 'M1',
          selling_points: ['point1', 'point2', 'point3', 'point4', 'point5'],
        }],
      },
      userPrompt: 'test',
    });
    assert.ok(result.includes('point1'));
    assert.ok(result.includes('point3'));
    assert.ok(!result.includes('point4'));
  });
});

// ─── saveGeneratedAsset ───

describe('saveGeneratedAsset', () => {
  it('saves image and returns asset record with url', async () => {
    const result = await saveGeneratedAsset({
      imageBuffer: Buffer.from('fake-png-data'),
      prompt: 'test prompt',
      model: 'openai/gpt-5-image',
      sourceFilename: 'brochure.pdf',
      productInfo: { company_name: 'Test' },
    });

    assert.equal(result.id, 'test-uuid');
    assert.ok(result.url.startsWith('https://storage.test/'));
    assert.ok(result.storage_path.startsWith('generated/'));
    assert.ok(result.storage_path.endsWith('.png'));
  });

  it('stores conversation_id and user_id when provided', async () => {
    const result = await saveGeneratedAsset({
      imageBuffer: Buffer.from('data'),
      prompt: 'p',
      model: 'test/model',
      conversationId: 'conv-123',
      userId: 'user-456',
    });

    assert.equal(result.id, 'test-uuid');
    assert.ok(result.storage_path.includes('test-model'));
  });

  it('sanitizes model name with slashes in filename', async () => {
    const result = await saveGeneratedAsset({
      imageBuffer: Buffer.from('data'),
      prompt: 'p',
      model: 'google/gemini-3.1-flash-image-preview',
    });

    assert.ok(!result.storage_path.includes('/gemini'));
    assert.ok(result.storage_path.includes('google-gemini'));
  });
});

// ─── getAssets ───

describe('getAssets', () => {
  it('returns assets for conversation scope', async () => {
    const result = await getAssets({
      scope: 'conversation',
      conversationId: 'conv-1',
    });

    assert.equal(result.total, 2);
    assert.equal(result.data.length, 2);
    assert.equal(result.data[0].id, 'asset-1');
    assert.ok(result.data[0].url.includes('storage.test'));
    assert.ok(result.data[0].url.includes('generated/1.png'));
  });

  it('returns assets for user scope', async () => {
    const result = await getAssets({
      scope: 'user',
      userId: 'user-1',
    });

    assert.equal(result.total, 2);
    assert.equal(result.data.length, 2);
    // Each asset should have a url attached
    for (const asset of result.data) {
      assert.ok(asset.url, 'each asset must have a url');
      assert.ok(asset.url.includes(asset.storage_path));
    }
  });

  it('throws when conversation scope has no conversationId', async () => {
    await assert.rejects(
      () => getAssets({ scope: 'conversation' }),
      { message: 'conversationId is required for conversation scope' }
    );
  });

  it('throws when user scope has no userId', async () => {
    await assert.rejects(
      () => getAssets({ scope: 'user' }),
      { message: 'userId is required for user scope' }
    );
  });

  it('uses default limit and offset', async () => {
    const result = await getAssets({
      scope: 'conversation',
      conversationId: 'conv-1',
    });
    // Should not throw, defaults applied
    assert.ok(result.data);
  });
});
