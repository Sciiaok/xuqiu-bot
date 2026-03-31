/**
 * Verify the unified llm-client with MiniMax routing.
 * Callers use Anthropic format → llm-client translates internally.
 *
 * Tests:
 * 1. Forced tool_choice → JSON mode (strategy-agent pattern)
 * 2. Auto tool_choice → OpenAI tool calling (orchestrator pattern)
 * 3. Multi-turn tool loop → tool_result handling (execution-agent pattern)
 * 4. Claude still works unchanged
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

// Dynamic import AFTER dotenv so env vars are available at module init
const { anthropic, MODELS } = await import('../src/llm-client.js');

function printResult(label, response) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${label}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`stop_reason: ${response.stop_reason}`);
  console.log(`model: ${response.model}`);
  console.log(`usage: ${JSON.stringify(response.usage)}`);
  for (const block of response.content) {
    if (block.type === 'text') {
      console.log(`[text] ${block.text.slice(0, 200)}`);
    } else if (block.type === 'tool_use') {
      console.log(`[tool_use] name=${block.name} id=${block.id}`);
      console.log(`  input keys: ${Object.keys(block.input).join(', ')}`);
      console.log(`  input preview: ${JSON.stringify(block.input).slice(0, 300)}`);
    }
  }
}

const SUBMIT_TOOL = {
  name: 'submit_report',
  description: 'Submit the final analysis report.',
  input_schema: {
    type: 'object',
    required: ['summary', 'score'],
    properties: {
      summary: { type: 'string' },
      score: { type: 'number' },
      recommendations: { type: 'array', items: { type: 'string' } },
    },
  },
};

const SEARCH_TOOL = {
  name: 'search_data',
  description: 'Search for market data.',
  input_schema: {
    type: 'object',
    required: ['query'],
    properties: { query: { type: 'string' } },
  },
};

// ── Test 1: Forced tool_choice (Anthropic format, routed to MiniMax JSON mode)
async function test1_forcedTool() {
  console.log('\n>>> Test 1: MiniMax forced tool_choice (via JSON mode)');

  const response = await anthropic.messages.create({
    model: MODELS.MINIMAX,
    max_tokens: 2048,
    system: 'You are a market analyst.',
    messages: [{ role: 'user', content: 'Analyze the EV market in Southeast Asia.' }],
    tools: [SUBMIT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_report' },
  });

  printResult('MiniMax forced tool → JSON mode', response);

  // Verify Anthropic format
  const toolBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_report');
  const checks = [
    ['stop_reason is tool_use', response.stop_reason === 'tool_use'],
    ['has tool_use block', !!toolBlock],
    ['tool name is submit_report', toolBlock?.name === 'submit_report'],
    ['has id', !!toolBlock?.id],
    ['input.summary is string', typeof toolBlock?.input?.summary === 'string'],
    ['input.score is number', typeof toolBlock?.input?.score === 'number'],
    ['has usage.input_tokens', response.usage?.input_tokens > 0],
  ];
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);
  return checks.every(([, ok]) => ok);
}

// ── Test 2: Auto tool_choice
async function test2_autoTool() {
  console.log('\n>>> Test 2: MiniMax auto tool_choice');

  const response = await anthropic.messages.create({
    model: MODELS.MINIMAX,
    max_tokens: 2048,
    system: 'You are a market analyst. You MUST use the search_data tool to search before answering.',
    messages: [{ role: 'user', content: 'Search for EV market data in Thailand.' }],
    tools: [SEARCH_TOOL, SUBMIT_TOOL],
    tool_choice: { type: 'auto' },
  });

  printResult('MiniMax auto tool', response);

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
  }
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);
  return checks.every(([, ok]) => ok);
}

// ── Test 3: Multi-turn with tool_result (Anthropic format)
async function test3_multiTurn() {
  console.log('\n>>> Test 3: MiniMax multi-turn tool loop (Anthropic format)');

  // Turn 1
  const r1 = await anthropic.messages.create({
    model: MODELS.MINIMAX,
    max_tokens: 2048,
    system: 'You are a market analyst. First search for data, then submit a report.',
    messages: [{ role: 'user', content: 'Search for EV market data, then submit a report.' }],
    tools: [SEARCH_TOOL, SUBMIT_TOOL],
    tool_choice: { type: 'auto' },
  });
  printResult('Multi-turn: Turn 1', r1);

  if (r1.stop_reason !== 'tool_use') {
    console.log('WARN: No tool call in turn 1, cannot test multi-turn');
    return false;
  }

  const toolBlocks = r1.content.filter(b => b.type === 'tool_use');

  // Turn 2: reply to ALL tool_results in Anthropic format, then force submit
  const toolResultContent = toolBlocks.map(tb => ({
    type: 'tool_result',
    tool_use_id: tb.id,
    content: JSON.stringify({ results: [{ country: 'Thailand', ev_share: '12%' }] }),
  }));

  const r2 = await anthropic.messages.create({
    model: MODELS.MINIMAX,
    max_tokens: 2048,
    system: 'You are a market analyst. You already searched. Now submit your report.',
    messages: [
      { role: 'user', content: 'Search for EV market data, then submit a report.' },
      { role: 'assistant', content: r1.content },
      { role: 'user', content: toolResultContent },
    ],
    tools: [SEARCH_TOOL, SUBMIT_TOOL],
    // Force submit on turn 2 to verify forced + multi-turn
    tool_choice: { type: 'tool', name: 'submit_report' },
  });
  printResult('Multi-turn: Turn 2 (forced submit)', r2);

  const submitBlock = r2.content.find(b => b.type === 'tool_use' && b.name === 'submit_report');
  const checks = [
    ['turn 2 stop_reason is tool_use', r2.stop_reason === 'tool_use'],
    ['has submit_report block', !!submitBlock],
    ['input has summary', typeof submitBlock?.input?.summary === 'string'],
  ];
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);
  return checks.every(([, ok]) => ok);
}

// ── Test 4: Claude still works
async function test4_claudeUnchanged() {
  console.log('\n>>> Test 4: Claude forced tool_choice (unchanged path)');

  const response = await anthropic.messages.create({
    model: MODELS.SONNET,
    max_tokens: 1024,
    system: 'You are a market analyst.',
    messages: [{ role: 'user', content: 'Analyze the EV market. Be brief.' }],
    tools: [SUBMIT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_report' },
  });

  printResult('Claude forced tool (native)', response);

  const toolBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_report');
  const checks = [
    ['stop_reason is tool_use', response.stop_reason === 'tool_use'],
    ['has submit_report', !!toolBlock],
    ['input.summary is string', typeof toolBlock?.input?.summary === 'string'],
  ];
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);
  return checks.every(([, ok]) => ok);
}

// ── Run all ─────────────────────────────────────────────────────────
async function main() {
  const results = {};
  for (const [name, fn] of [
    ['1. MiniMax forced tool_choice', test1_forcedTool],
    ['2. MiniMax auto tool_choice', test2_autoTool],
    ['3. MiniMax multi-turn + forced', test3_multiTurn],
    ['4. Claude unchanged', test4_claudeUnchanged],
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
