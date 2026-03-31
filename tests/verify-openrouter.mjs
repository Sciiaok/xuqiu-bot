/**
 * Quick verification: OpenRouter chat completions + embeddings endpoints
 * Usage: node tests/verify-openrouter.mjs
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import OpenAI from 'openai';

const IS_OPENROUTER = !process.env.OPENAI_API_KEY && !!process.env.OPENROUTER_API_KEY;
const API_KEY = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY;
const BASE_URL = IS_OPENROUTER
  ? (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api') + '/v1'
  : undefined;

const GPT_MODEL = IS_OPENROUTER ? 'openai/gpt-4o-mini' : 'gpt-4o-mini';
const EMBED_MODEL = IS_OPENROUTER ? 'openai/text-embedding-3-small' : 'text-embedding-3-small';

console.log(`Provider: ${IS_OPENROUTER ? 'OpenRouter' : 'OpenAI Direct'}`);
console.log(`Base URL: ${BASE_URL || '(OpenAI default)'}`);
console.log(`API Key:  ${API_KEY ? API_KEY.slice(0, 8) + '...' : 'MISSING'}\n`);

if (!API_KEY) {
  console.error('❌ No API key found. Set OPENROUTER_API_KEY or OPENAI_API_KEY.');
  process.exit(1);
}

const client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL, timeout: 30000 });

// ── Test 1: Chat Completions (GPT-4o-mini with JSON mode) ──────────
async function testChatCompletions() {
  const t0 = Date.now();
  try {
    const res = await client.chat.completions.create({
      model: GPT_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return a JSON object with key "status" and value "ok".' },
        { role: 'user', content: 'ping' },
      ],
    });
    const content = res.choices[0].message.content;
    const parsed = JSON.parse(content);
    const ms = Date.now() - t0;
    if (parsed.status === 'ok') {
      console.log(`✅ Chat Completions (${GPT_MODEL}) — ${ms}ms`);
      console.log(`   Model returned: ${res.model}, tokens: ${res.usage?.total_tokens}`);
    } else {
      console.log(`⚠️  Chat Completions returned unexpected JSON: ${content}`);
    }
    return true;
  } catch (err) {
    console.error(`❌ Chat Completions FAILED (${Date.now() - t0}ms): ${err.message}`);
    return false;
  }
}

// ── Test 2: Embeddings ─────────────────────────────────────────────
async function testEmbeddings() {
  const t0 = Date.now();
  try {
    const res = await client.embeddings.create({
      model: EMBED_MODEL,
      input: ['test product specification'],
    });
    const vec = res.data[0].embedding;
    const ms = Date.now() - t0;
    console.log(`✅ Embeddings (${EMBED_MODEL}) — ${ms}ms`);
    console.log(`   Dimensions: ${vec.length}, first 3: [${vec.slice(0, 3).map(v => v.toFixed(6)).join(', ')}]`);
    return true;
  } catch (err) {
    console.error(`❌ Embeddings FAILED (${Date.now() - t0}ms): ${err.message}`);
    return false;
  }
}

// ── Run ────────────────────────────────────────────────────────────
const [chat, embed] = await Promise.all([testChatCompletions(), testEmbeddings()]);
console.log(`\n${chat && embed ? '✅ All checks passed' : '❌ Some checks failed'}`);
process.exit(chat && embed ? 0 : 1);
