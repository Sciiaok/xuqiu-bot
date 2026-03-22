import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/product-knowledge.service.js')).href;
const configModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/config.js')).href;
const supabaseModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/supabase.js')).href;

// Mock dependencies
mock.module(configModuleUrl, {
  namedExports: {
    config: {
      openai: { apiKey: 'test-key' },
      anthropic: { apiKey: 'test-key', model: 'test' },
    },
  },
});

mock.module(supabaseModuleUrl, {
  defaultExport: {
    from: () => ({ insert: async () => ({ data: [], error: null }), update: () => ({ eq: () => ({ data: null, error: null }) }), select: () => ({ eq: () => ({ data: [], error: null }) }) }),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
    rpc: async () => ({ data: [], error: null }),
  },
});

mock.module('openai', {
  defaultExport: class FakeOpenAI {
    constructor() {
      this.embeddings = { create: async () => ({ data: [{ embedding: new Array(1536).fill(0) }] }) };
      this.chat = { completions: { create: async () => ({ choices: [{ message: { content: '{}' } }] }) } };
    }
  },
});

const { createChunks } = await import(`${moduleUrl}?test=${Date.now()}`);

describe('createChunks', () => {
  it('creates a spec chunk with model prefix for each spec', () => {
    const specs = [
      { model: 'DF2004E', brand: 'Dongfeng', nominal_power_kw: 147, fuel_tank_l: 400 },
    ];
    const chunks = createChunks('', specs);

    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].text.startsWith('[DF2004E]'));
    assert.ok(chunks[0].text.includes('nominal_power_kw: 147'));
    assert.ok(chunks[0].text.includes('fuel_tank_l: 400'));
    assert.equal(chunks[0].metadata.model, 'DF2004E');
    assert.equal(chunks[0].metadata.type, 'spec_sheet');
  });

  it('creates multiple spec chunks for multiple specs', () => {
    const specs = [
      { model: 'DF2004E', brand: 'Dongfeng', nominal_power_kw: 147 },
      { model: 'DF2204E', brand: 'Dongfeng', nominal_power_kw: 162 },
    ];
    const chunks = createChunks('', specs);

    assert.equal(chunks.length, 2);
    assert.ok(chunks[0].text.includes('DF2004E'));
    assert.ok(chunks[1].text.includes('DF2204E'));
  });

  it('splits long markdown into document chunks', () => {
    const longParagraph = 'This is a detailed product description. '.repeat(50);
    const markdown = `${longParagraph}\n\n${longParagraph}`;
    const chunks = createChunks(markdown, []);

    assert.ok(chunks.length >= 2);
    assert.equal(chunks[0].metadata.type, 'document');
  });

  it('skips short markdown sections (< 50 chars)', () => {
    const markdown = 'Short.';
    const chunks = createChunks(markdown, []);
    assert.equal(chunks.length, 0);
  });

  it('combines specs and markdown chunks', () => {
    const specs = [{ model: 'DF2004E', brand: 'Dongfeng', power_kw: 147 }];
    const longMarkdown = 'This is a detailed product manual section with enough content to be useful as a chunk for retrieval purposes and embedding generation.';
    const chunks = createChunks(longMarkdown, specs);

    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].metadata.type, 'spec_sheet');
    assert.equal(chunks[1].metadata.type, 'document');
  });

  it('excludes model and brand from spec chunk body', () => {
    const specs = [{ model: 'DF2004E', brand: 'Dongfeng', power_kw: 147 }];
    const chunks = createChunks('', specs);

    const lines = chunks[0].text.split('\n');
    const kvLines = lines.slice(2); // skip header lines
    const kvKeys = kvLines.map(l => l.split(':')[0].trim());
    assert.ok(!kvKeys.includes('model'));
    assert.ok(!kvKeys.includes('brand'));
  });
});
