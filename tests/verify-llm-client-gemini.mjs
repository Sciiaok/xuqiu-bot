/**
 * Verify the unified llm-client with Gemini routing via MixAI.
 * Callers use Anthropic format → llm-client translates to OpenAI format internally.
 *
 * Tests:
 * 1. Gemini basic text response
 * 2. Gemini auto tool_choice
 * 3. Claude still works unchanged
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const { anthropic, MODELS, isGeminiModel } = await import('../src/llm-client.js');

function printResult(label, response) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${label}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`stop_reason: ${response.stop_reason}`);
  console.log(`model: ${response.model}`);
  console.log(`usage: ${JSON.stringify(response.usage)}`);
  for (const block of response.content) {
    if (block.type === 'text') {
      console.log(`[text] ${block.text.slice(0, 300)}`);
    } else if (block.type === 'tool_use') {
      console.log(`[tool_use] name=${block.name} id=${block.id}`);
      console.log(`  input preview: ${JSON.stringify(block.input).slice(0, 300)}`);
    }
  }
}

const SEARCH_TOOL = {
  name: 'search_data',
  description: 'Search for market data by query.',
  input_schema: {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' } },
  },
};

// ── Test 0: isGeminiModel helper
function test0_isGeminiModel() {
  console.log('\n>>> Test 0: isGeminiModel helper');
  const checks = [
    ['gemini-2.5-flash', true],
    ['gemini-3.1-flash-image-preview', true],
    ['google/gemini-2.0-flash-exp:free', true],
    ['claude-sonnet-4-6', false],
    ['minimax/minimax-m2.7', false],
    [undefined, false],
    [null, false],
  ];
  let allPass = true;
  for (const [model, expected] of checks) {
    const result = isGeminiModel(model);
    const ok = result === expected;
    if (!ok) allPass = false;
    console.log(`  ${ok ? '✅' : '❌'} isGeminiModel(${JSON.stringify(model)}) = ${result} (expected ${expected})`);
  }
  return allPass;
}

// ── Test 1: Gemini basic text
async function test1_geminiBasic() {
  console.log('\n>>> Test 1: Gemini basic text response');

  const response = await anthropic.messages.create({
    model: MODELS.GEMINI_FLASH,
    max_tokens: 256,
    messages: [{ role: 'user', content: 'What is 2+2? Reply in one word.' }],
  });

  printResult('Gemini basic text', response);

  const textBlock = response.content.find(b => b.type === 'text');
  const checks = [
    ['stop_reason is end_turn', response.stop_reason === 'end_turn'],
    ['has text block', !!textBlock],
    ['text is non-empty', !!textBlock?.text?.trim()],
    ['has usage.input_tokens', response.usage?.input_tokens > 0],
    ['has usage.output_tokens', response.usage?.output_tokens > 0],
  ];
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);
  return checks.every(([, ok]) => ok);
}

// ── Test 2: Gemini auto tool_choice
async function test2_geminiTool() {
  console.log('\n>>> Test 2: Gemini auto tool_choice');

  const response = await anthropic.messages.create({
    model: MODELS.GEMINI_FLASH,
    max_tokens: 1024,
    system: 'You are a market analyst. Always use the search_data tool before answering any question.',
    messages: [{ role: 'user', content: 'Search for EV market data in Kenya.' }],
    tools: [SEARCH_TOOL],
  });

  printResult('Gemini auto tool', response);

  const hasToolUse = response.content.some(b => b.type === 'tool_use');
  const checks = [
    ['response has content', response.content.length > 0],
    ['has stop_reason', !!response.stop_reason],
    ['has usage', !!response.usage],
  ];
  if (hasToolUse) {
    checks.push(['stop_reason is tool_use', response.stop_reason === 'tool_use']);
    const tb = response.content.find(b => b.type === 'tool_use');
    checks.push(['tool_use has id', !!tb.id]);
    checks.push(['tool_use has input', !!tb.input]);
    checks.push(['tool name is search_data', tb.name === 'search_data']);
  } else {
    console.log('  ⚠️  No tool_use in response (Gemini may not always call tools)');
  }
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);
  return checks.every(([, ok]) => ok);
}

// ── Test 3: Claude still works
async function test3_claudeUnchanged() {
  console.log('\n>>> Test 3: Claude still works (unchanged path)');

  const response = await anthropic.messages.create({
    model: MODELS.SONNET,
    max_tokens: 256,
    messages: [{ role: 'user', content: 'What is 2+2? Reply in one word.' }],
  });

  printResult('Claude basic text', response);

  const textBlock = response.content.find(b => b.type === 'text');
  const checks = [
    ['stop_reason is end_turn', response.stop_reason === 'end_turn'],
    ['has text block', !!textBlock],
    ['text is non-empty', !!textBlock?.text?.trim()],
  ];
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);
  return checks.every(([, ok]) => ok);
}

// ── Run all ─────────────────────────────────────────────────────────
async function main() {
  const results = {};
  for (const [name, fn] of [
    ['0. isGeminiModel helper', test0_isGeminiModel],
    ['1. Gemini basic text', test1_geminiBasic],
    ['2. Gemini auto tool_choice', test2_geminiTool],
    ['3. Claude unchanged', test3_claudeUnchanged],
  ]) {
    try {
      results[name] = await fn();
    } catch (err) {
      console.error(`\n❌ ${name} THREW: ${err.message}`);
      if (err.status) console.error(`  HTTP ${err.status}`);
      results[name] = `ERROR: ${err.message}`;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  for (const [name, ok] of Object.entries(results)) {
    const status = ok === true ? '✅ PASS' : typeof ok === 'string' ? `❌ ${ok}` : '❌ FAIL';
    console.log(`  ${status}  ${name}`);
  }
}

main().catch(console.error);
