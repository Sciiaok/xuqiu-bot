/**
 * Verify MiniMax M2.7 JSON structured output (simulating forced tool_use)
 *
 * Tests:
 * 1. Simple schema — submit_report pattern
 * 2. Complex nested schema — submit_media_plan pattern
 * 3. Multi-turn context — tool_result in history then JSON output
 * 4. Chinese system prompt — orchestrator pattern
 */
import OpenAI from 'openai';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const MODEL = 'minimax/minimax-m2.7';
const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: 'https://openrouter.ai/api/v1',
});

function printResult(label, response, parsed) {
  const choice = response.choices[0];
  console.log(`\n${'='.repeat(60)}`);
  console.log(`TEST: ${label}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`finish_reason: ${choice.finish_reason}`);
  console.log(`model: ${response.model}`);
  console.log(`usage: in=${response.usage.prompt_tokens} out=${response.usage.completion_tokens}`);
  console.log(`raw content (first 500): ${choice.message.content?.slice(0, 500)}`);
  if (parsed) console.log(`parsed keys: ${Object.keys(parsed).join(', ')}`);
}

// ── Test 1: Simple schema ───────────────────────────────────────────
async function test1_simpleJson() {
  console.log('\n>>> Test 1: Simple JSON (submit_report pattern)');

  const schema = {
    type: 'object',
    required: ['summary', 'score', 'recommendations'],
    properties: {
      summary: { type: 'string' },
      score: { type: 'number', description: '0-100' },
      recommendations: { type: 'array', items: { type: 'string' } },
    },
  };

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: 'system',
        content: `You are a market analyst. Respond with a JSON object matching this schema:\n${JSON.stringify(schema, null, 2)}\n\nDo NOT include any text outside the JSON.`,
      },
      { role: 'user', content: 'Analyze the electric vehicle market in Southeast Asia.' },
    ],
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0].message.content;
  const parsed = JSON.parse(raw);
  printResult('Simple JSON', response, parsed);

  const checks = [
    ['has summary (string)', typeof parsed.summary === 'string' && parsed.summary.length > 0],
    ['has score (number 0-100)', typeof parsed.score === 'number' && parsed.score >= 0 && parsed.score <= 100],
    ['has recommendations (array)', Array.isArray(parsed.recommendations) && parsed.recommendations.length > 0],
  ];
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);
  return checks.every(([, ok]) => ok);
}

// ── Test 2: Complex nested schema (strategy agent) ──────────────────
async function test2_complexJson() {
  console.log('\n>>> Test 2: Complex nested JSON (submit_media_plan pattern)');

  const schema = {
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
  };

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: 'system',
        content: `You are a media planning expert. Respond with a JSON object matching this schema:\n${JSON.stringify(schema, null, 2)}\n\nDo NOT include any text outside the JSON.`,
      },
      {
        role: 'user',
        content: `Create a media plan for an agricultural machinery company targeting East Africa.
Budget: $3000, Duration: 30 days, Platform: Meta only.
Create 2 campaigns: one for Kenya (lead gen, OUTCOME_LEADS), one for Tanzania (traffic, OUTCOME_TRAFFIC).
Each campaign needs 1 ad set with 2 ads.`,
      },
    ],
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0].message.content;
  const parsed = JSON.parse(raw);
  printResult('Complex nested JSON', response, parsed);

  const checks = [
    ['total_budget is number', typeof parsed.total_budget === 'number'],
    ['duration_days is number', typeof parsed.duration_days === 'number'],
    ['platforms is array', Array.isArray(parsed.platforms)],
    ['has campaigns', parsed.platforms?.[0]?.campaigns?.length > 0],
    ['2 campaigns', parsed.platforms?.[0]?.campaigns?.length === 2],
    ['campaign has name', !!parsed.platforms?.[0]?.campaigns?.[0]?.name],
    ['campaign has objective', !!parsed.platforms?.[0]?.campaigns?.[0]?.objective],
    ['campaign has daily_budget', typeof parsed.platforms?.[0]?.campaigns?.[0]?.daily_budget === 'number'],
    ['has ad_sets', parsed.platforms?.[0]?.campaigns?.[0]?.ad_sets?.length > 0],
    ['ad_set has targeting.countries', parsed.platforms?.[0]?.campaigns?.[0]?.ad_sets?.[0]?.targeting?.countries?.length > 0],
    ['ad_set has ads', parsed.platforms?.[0]?.campaigns?.[0]?.ad_sets?.[0]?.ads?.length > 0],
  ];
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);
  return checks.every(([, ok]) => ok);
}

// ── Test 3: Chinese prompt + research context (orchestrator pattern) ─
async function test3_chinesePrompt() {
  console.log('\n>>> Test 3: Chinese system prompt (research agent pattern)');

  const schema = {
    type: 'object',
    required: ['market_overview', 'competitor_ads', 'recommendations', 'platform_recommendations'],
    properties: {
      market_overview: { type: 'string' },
      competitor_ads: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          top_themes: { type: 'array', items: { type: 'string' } },
        },
      },
      recommendations: {
        type: 'array',
        items: { type: 'string' },
      },
      platform_recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            platform: { type: 'string' },
            reason: { type: 'string' },
            budget_share: { type: 'number' },
          },
        },
      },
    },
  };

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: 'system',
        content: `你是市场调研分析师。根据给定的竞品广告数据和市场趋势，输出结构化的调研报告。
请严格按照以下 JSON Schema 输出，不要输出 JSON 以外的任何文字：
${JSON.stringify(schema, null, 2)}`,
      },
      {
        role: 'user',
        content: `分析以下广告投放数据：

CAMPAIGN BRIEF:
{"company_name": "绿色农机", "industry": "agricultural_machinery", "products": ["拖拉机", "收割机"], "target_countries": ["KE", "TZ", "ET"], "budget": 5000}

COMPETITOR ADS (from Meta Ad Library):
[{"page_name": "John Deere Africa", "body": "Powerful tractors for African farms", "title": "JD 5E Series"},
 {"page_name": "TAFE Motors", "body": "Affordable farming solutions", "title": "Eicher Tractor 380"}]

GOOGLE TRENDS:
{"keywords": ["tractor Kenya", "farming equipment Tanzania"], "trend": "rising"}`,
      },
    ],
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0].message.content;
  const parsed = JSON.parse(raw);
  printResult('Chinese prompt', response, parsed);

  const checks = [
    ['has market_overview', typeof parsed.market_overview === 'string' && parsed.market_overview.length > 0],
    ['has competitor_ads.summary', typeof parsed.competitor_ads?.summary === 'string'],
    ['has competitor_ads.top_themes', Array.isArray(parsed.competitor_ads?.top_themes)],
    ['has recommendations', Array.isArray(parsed.recommendations) && parsed.recommendations.length > 0],
    ['has platform_recommendations', Array.isArray(parsed.platform_recommendations) && parsed.platform_recommendations.length > 0],
    ['platform_rec has budget_share', typeof parsed.platform_recommendations?.[0]?.budget_share === 'number'],
  ];
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);
  return checks.every(([, ok]) => ok);
}

// ── Test 4: Creative plan schema ────────────────────────────────────
async function test4_creativePlan() {
  console.log('\n>>> Test 4: Creative plan (submit_creative_plan pattern)');

  const schema = {
    type: 'object',
    required: ['creative_tasks'],
    properties: {
      creative_tasks: {
        type: 'array',
        items: {
          type: 'object',
          required: ['task_id', 'target_market', 'creative_type', 'concept', 'copy', 'image_prompt'],
          properties: {
            task_id: { type: 'string' },
            target_market: { type: 'string' },
            creative_type: { type: 'string' },
            strategy_category: { type: 'string' },
            concept: { type: 'string' },
            copy: { type: 'object', properties: { headline: { type: 'string' }, body: { type: 'string' }, cta: { type: 'string' } } },
            image_prompt: { type: 'string' },
            dimensions: { type: 'string' },
            linked_ads: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  };

  const response = await client.chat.completions.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: 'system',
        content: `You are a creative director. Generate creative production tasks. Output JSON matching this schema:\n${JSON.stringify(schema, null, 2)}\n\nDo NOT output anything outside JSON.`,
      },
      {
        role: 'user',
        content: `Create 3 creative tasks for agricultural machinery ads targeting Kenya and Tanzania.
Products: Tractors (Model T-500), Harvesters (Model H-200).
Each task needs a detailed image_prompt suitable for AI image generation (English, descriptive).
Copy should be in English.`,
      },
    ],
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0].message.content;
  const parsed = JSON.parse(raw);
  printResult('Creative plan', response, parsed);

  const tasks = parsed.creative_tasks || [];
  const checks = [
    ['has creative_tasks array', tasks.length > 0],
    ['3 tasks', tasks.length === 3],
    ['task has task_id', !!tasks[0]?.task_id],
    ['task has target_market', !!tasks[0]?.target_market],
    ['task has concept', !!tasks[0]?.concept],
    ['task has copy.headline', !!tasks[0]?.copy?.headline],
    ['task has copy.body', !!tasks[0]?.copy?.body],
    ['task has image_prompt (>50 chars)', tasks[0]?.image_prompt?.length > 50],
    ['task has linked_ads', Array.isArray(tasks[0]?.linked_ads)],
  ];
  for (const [l, ok] of checks) console.log(`  ${ok ? '✅' : '❌'} ${l}`);
  return checks.every(([, ok]) => ok);
}

// ── Run all ─────────────────────────────────────────────────────────
async function main() {
  const results = {};
  for (const [name, fn] of [
    ['1. simple JSON (submit_report)', test1_simpleJson],
    ['2. complex nested JSON (submit_media_plan)', test2_complexJson],
    ['3. Chinese prompt (research agent)', test3_chinesePrompt],
    ['4. creative plan (submit_creative_plan)', test4_creativePlan],
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
