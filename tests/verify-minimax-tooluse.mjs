/**
 * Verify MiniMax M2.7 forced tool_choice via OpenRouter (OpenAI-compatible API)
 *
 * Tests:
 * 1. tool_choice: 'auto' — basic tool calling
 * 2. tool_choice: { type: 'function', function: { name: 'X' } } — forced specific tool
 * 3. Multi-turn tool loop — agent calls tool, gets result, calls next tool
 * 4. Forced complex schema — strategy-agent pattern with nested objects
 */
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const MODEL = 'minimax/minimax-m2.7';
const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

// ── Tool definitions (OpenAI format) ──────────────────────────────

const SUBMIT_TOOL = {
  type: 'function',
  function: {
    name: 'submit_report',
    description: 'Submit the final analysis report.',
    parameters: {
      type: 'object',
      required: ['summary', 'score'],
      properties: {
        summary: { type: 'string', description: 'Brief summary of findings' },
        score: { type: 'number', description: 'Quality score 0-100' },
        recommendations: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of recommendations',
        },
      },
    },
  },
};

const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'search_data',
    description: 'Search for market data by keyword.',
    parameters: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
      },
    },
  },
};

// ── Helpers ──────────────────────────────────────────────────────────

function printResult(label, response) {
  const choice = response.choices[0];
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${label}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`finish_reason: ${choice.finish_reason}`);
  console.log(`model: ${response.model}`);
  console.log(`usage: ${JSON.stringify(response.usage)}`);

  if (choice.message.content) {
    console.log(`[content] ${choice.message.content.slice(0, 200)}`);
  }
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      console.log(`[tool_call] id=${tc.id} name=${tc.function.name}`);
      console.log(`  arguments: ${tc.function.arguments.slice(0, 300)}`);
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────

async function test1_autoToolChoice() {
  console.log('\n>>> Test 1: tool_choice auto');
  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: 'You are a market analyst. Always use tools to submit your findings.' },
      { role: 'user', content: 'Analyze the electric vehicle market in Southeast Asia and submit a report.' },
    ],
    tools: [SUBMIT_TOOL],
    tool_choice: 'auto',
  });
  printResult('tool_choice: auto', response);
  return response.choices[0].finish_reason === 'tool_calls';
}

async function test2_forcedToolChoice() {
  console.log('\n>>> Test 2: tool_choice forced');
  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: 'You are a market analyst.' },
      { role: 'user', content: 'Analyze the electric vehicle market in Southeast Asia and submit a report.' },
    ],
    tools: [SUBMIT_TOOL],
    tool_choice: { type: 'function', function: { name: 'submit_report' } },
  });
  printResult('tool_choice: forced (submit_report)', response);

  const tc = response.choices[0].message.tool_calls;
  const hasSubmit = tc?.some(t => t.function.name === 'submit_report');

  // Validate JSON parseable
  if (hasSubmit) {
    const args = JSON.parse(tc.find(t => t.function.name === 'submit_report').function.arguments);
    console.log(`\nParsed args: summary=${!!args.summary}, score=${args.score}, recs=${args.recommendations?.length || 0}`);
  }
  return hasSubmit;
}

async function test3_multiTurnToolLoop() {
  console.log('\n>>> Test 3: Multi-turn tool loop');
  const messages = [
    { role: 'system', content: 'You are a market analyst. First search for data, then submit a report.' },
    { role: 'user', content: 'Search for EV market data, then submit a report based on findings.' },
  ];

  // Turn 1: expect search_data call
  const r1 = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 2048,
    messages,
    tools: [SEARCH_TOOL, SUBMIT_TOOL],
    tool_choice: 'auto',
  });
  printResult('Multi-turn: Turn 1', r1);

  const tc1 = r1.choices[0].message.tool_calls;
  if (!tc1?.length) {
    console.log('WARN: Model did not call any tool in turn 1');
    return false;
  }

  // Turn 2: provide tool result, expect submit_report
  messages.push(r1.choices[0].message);
  for (const tc of tc1) {
    messages.push({
      role: 'tool',
      tool_call_id: tc.id,
      content: JSON.stringify({
        results: [
          { country: 'Thailand', ev_share: '12%', growth: '+45% YoY' },
          { country: 'Indonesia', ev_share: '5%', growth: '+120% YoY' },
        ],
      }),
    });
  }

  const r2 = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 2048,
    messages,
    tools: [SEARCH_TOOL, SUBMIT_TOOL],
    tool_choice: 'auto',
  });
  printResult('Multi-turn: Turn 2', r2);

  const tc2 = r2.choices[0].message.tool_calls;
  return tc2?.some(t => t.function.name === 'submit_report');
}

async function test4_forcedWithComplexSchema() {
  console.log('\n>>> Test 4: Forced tool with complex nested schema (strategy-agent pattern)');

  const STRATEGY_SUBMIT = {
    type: 'function',
    function: {
      name: 'submit_media_plan',
      description: 'Submit the complete media plan.',
      parameters: {
        type: 'object',
        required: ['total_budget', 'duration_days', 'platforms'],
        properties: {
          total_budget: { type: 'number' },
          duration_days: { type: 'number' },
          platforms: {
            type: 'array',
            items: {
              type: 'object',
              required: ['platform', 'budget_allocation', 'campaigns'],
              properties: {
                platform: { type: 'string' },
                budget_allocation: { type: 'number' },
                budget_amount: { type: 'number' },
                campaigns: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['name', 'objective', 'daily_budget'],
                    properties: {
                      name: { type: 'string' },
                      objective: { type: 'string' },
                      daily_budget: { type: 'number' },
                      ad_sets: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name: { type: 'string' },
                            targeting: {
                              type: 'object',
                              properties: {
                                countries: { type: 'array', items: { type: 'string' } },
                                age_range: { type: 'array', items: { type: 'number' } },
                              },
                            },
                            ads: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  name: { type: 'string' },
                                  headline: { type: 'string' },
                                  format: { type: 'string' },
                                  cta: { type: 'string' },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      { role: 'system', content: 'You are a media planning expert. Create a campaign plan and submit it.' },
      {
        role: 'user',
        content: `Create a media plan for an agricultural machinery company targeting East Africa.
Budget: $3000, Duration: 30 days, Platform: Meta only.
Create 2 campaigns: one for Kenya (lead gen), one for Tanzania (traffic).`,
      },
    ],
    tools: [STRATEGY_SUBMIT],
    tool_choice: { type: 'function', function: { name: 'submit_media_plan' } },
  });

  printResult('Forced complex schema (submit_media_plan)', response);

  const tc = response.choices[0].message.tool_calls;
  const submitCall = tc?.find(t => t.function.name === 'submit_media_plan');
  if (!submitCall) return false;

  const plan = JSON.parse(submitCall.function.arguments);
  const checks = [
    ['has total_budget', typeof plan.total_budget === 'number'],
    ['has duration_days', typeof plan.duration_days === 'number'],
    ['has platforms array', Array.isArray(plan.platforms)],
    ['has campaigns', plan.platforms?.[0]?.campaigns?.length > 0],
    ['campaign has name', !!plan.platforms?.[0]?.campaigns?.[0]?.name],
    ['campaign has objective', !!plan.platforms?.[0]?.campaigns?.[0]?.objective],
    ['campaign has daily_budget', typeof plan.platforms?.[0]?.campaigns?.[0]?.daily_budget === 'number'],
    ['has ad_sets', plan.platforms?.[0]?.campaigns?.[0]?.ad_sets?.length > 0],
    ['2 campaigns (Kenya + Tanzania)', plan.platforms?.[0]?.campaigns?.length === 2],
  ];

  console.log('\nSchema validation:');
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  }

  return checks.every(([, ok]) => ok);
}

// ── Run all tests ──────────────────────────────────────────────────
async function main() {
  const results = {};

  for (const [name, fn] of [
    ['1. auto tool_choice', test1_autoToolChoice],
    ['2. forced tool_choice', test2_forcedToolChoice],
    ['3. multi-turn tool loop', test3_multiTurnToolLoop],
    ['4. forced complex schema', test4_forcedWithComplexSchema],
  ]) {
    try {
      results[name] = await fn();
    } catch (err) {
      console.error(`\n❌ ${name} THREW: ${err.message}`);
      if (err.status) console.error(`  HTTP ${err.status}: ${JSON.stringify(err.error || err.body || '')}`);
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
