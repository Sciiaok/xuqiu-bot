import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

import Anthropic from '@anthropic-ai/sdk';

const apiKey = process.env.OPENROUTER_API_KEY;
const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api';
const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-6';

const anthropic = new Anthropic({ apiKey, baseURL });

// Copy exact tools from research-agent.service.js
const RESEARCH_TOOLS = [
  {
    name: 'search_meta_ad_library',
    description: 'Search the Meta Ad Library for competitor ads in specific industries and countries. Returns ad creative text, page names, and start dates. Requires META_ACCESS_TOKEN — returns null if unavailable.',
    input_schema: {
      type: 'object', required: ['search_terms', 'countries'],
      properties: {
        search_terms: { type: 'string', description: 'Keywords to search' },
        countries: { type: 'array', items: { type: 'string' }, description: 'Target country names' },
      },
    },
  },
  {
    name: 'search_google_trends',
    description: 'Query Google Trends for keyword interest over time and related rising queries. Requires SERPAPI_KEY — returns null if unavailable.',
    input_schema: {
      type: 'object', required: ['keywords'],
      properties: { keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords (max 3)' } },
    },
  },
  {
    name: 'submit_report',
    description: 'Submit the final research report. Call this after gathering all needed data.',
    input_schema: {
      type: 'object',
      required: ['market_overview', 'competitor_ads', 'keyword_trends', 'audience_insights', 'platform_recommendations', 'benchmark_metrics', 'recommendations'],
      properties: {
        market_overview: { type: 'object', properties: { market_size_estimate: { type: 'string' }, growth_trend: { type: 'string' }, key_players: { type: 'array', items: { type: 'string' } }, market_characteristics: { type: 'array', items: { type: 'string' } } } },
        competitor_ads: { type: 'object', properties: { summary: { type: 'string' }, common_formats: { type: 'array', items: { type: 'string' } }, common_messaging: { type: 'array', items: { type: 'string' } }, gaps_and_opportunities: { type: 'array', items: { type: 'string' } } } },
        keyword_trends: { type: 'object', properties: { high_volume_keywords: { type: 'array', items: { type: 'string' } }, rising_keywords: { type: 'array', items: { type: 'string' } }, seasonal_patterns: { type: 'string' } } },
        audience_insights: { type: 'object', properties: { primary_segments: { type: 'array', items: { type: 'object' } }, platform_preferences: { type: 'object' }, content_preferences: { type: 'array', items: { type: 'string' } } } },
        platform_recommendations: { type: 'array', items: { type: 'object', properties: { platform: { type: 'string' }, fit_score: { type: 'number' }, rationale: { type: 'string' } } } },
        benchmark_metrics: { type: 'object', properties: { estimated_cpm: { type: 'string' }, estimated_cpc: { type: 'string' }, estimated_ctr: { type: 'string' }, estimated_cpl: { type: 'string' } } },
        recommendations: { type: 'array', items: { type: 'string' } },
      },
    },
  },
];

const SYSTEM = `You are a digital advertising market research analyst.

Your job: analyze a campaign brief, gather external data using tools, and produce a structured research report.

Workflow:
1. Read the brief carefully
2. Call search_meta_ad_library to find competitor ads (if relevant)
3. Call search_google_trends to check keyword interest (if relevant)
4. Synthesize all data (external + your training knowledge) into a comprehensive report
5. Call submit_report with the final structured report

Rules:
- Always try external tools first — they provide real-time data
- If a tool returns null (API key not configured), supplement with your training knowledge
- Be specific with numbers, benchmarks, and actionable insights
- Focus on the target markets and platforms relevant to the brief
- You MUST call submit_report as your final action`;

const brief = {
  company_name: 'CF Energy',
  industry: 'energy storage',
  products: [{ model: 'CFE-5', category: 'Residential ESS' }],
  target_countries: ['Nigeria'],
  budget: 3000,
  currency: 'USD',
};

const messages = [{ role: 'user', content: `Conduct market research for this campaign brief and submit your report.\n\nCAMPAIGN BRIEF:\n${JSON.stringify(brief, null, 2)}` }];

console.log('=== Simulating both tools returning UNAVAILABLE ===\n');

let emptySubmitCount = 0;

for (let i = 0; i < 10; i++) {
  console.log(`--- Iteration ${i + 1} ---`);
  const response = await anthropic.messages.create({
    model, max_tokens: 4096, system: SYSTEM, messages,
    tools: RESEARCH_TOOLS, tool_choice: { type: 'auto' },
  });

  console.log('stop_reason:', response.stop_reason);
  const blocks = response.content.map(c => ({ type: c.type, name: c.name, inputKeys: c.input ? Object.keys(c.input) : undefined, inputLen: c.input ? JSON.stringify(c.input).length : undefined }));
  console.log('blocks:', JSON.stringify(blocks));

  if (response.stop_reason !== 'tool_use') {
    console.log('Claude stopped without tool_use');
    break;
  }

  const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');
  const submitBlock = toolUseBlocks.find(t => t.name === 'submit_report');
  
  if (submitBlock) {
    const report = submitBlock.input;
    const keys = Object.keys(report || {});
    console.log('submit_report keys:', keys, 'length:', JSON.stringify(report).length);
    if (keys.length > 0) {
      console.log('✅ Got valid report!');
      break;
    } else {
      emptySubmitCount++;
      console.log(`⚠️  EMPTY REPORT (${emptySubmitCount}x)`);
    }
  }

  messages.push({ role: 'assistant', content: response.content });
  const toolResults = [];
  for (const toolUse of toolUseBlocks) {
    let result;
    if (toolUse.name === 'submit_report') {
      result = { status: 'rejected', reason: 'Report was empty or missing required fields. Please gather more data and try again.' };
    } else if (toolUse.name === 'search_meta_ad_library') {
      result = { available: false, reason: 'META_ACCESS_TOKEN not configured' };
    } else if (toolUse.name === 'search_google_trends') {
      result = { available: false, reason: 'SERPAPI_KEY not configured' };
    }
    toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
  }
  messages.push({ role: 'user', content: toolResults });
}

console.log(`\nTotal empty submits: ${emptySubmitCount}`);
