import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../src/config.js';

console.log('=== Config ===');
console.log('Model:', config.anthropic.model);
console.log('BaseURL:', config.anthropic.baseURL || 'direct Anthropic');
console.log('Has META token:', !!config.meta.accessToken);
console.log('Has SERPAPI key:', !!config.serpapi?.apiKey);

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL && { baseURL: config.anthropic.baseURL }),
});

// Minimal version of RESEARCH_TOOLS from research-agent.service.js
const RESEARCH_TOOLS = [
  {
    name: 'search_meta_ad_library',
    description: 'Search Meta Ad Library for competitor ads. Returns null if unavailable.',
    input_schema: {
      type: 'object',
      required: ['search_terms', 'countries'],
      properties: {
        search_terms: { type: 'string' },
        countries: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'search_google_trends',
    description: 'Query Google Trends. Returns null if unavailable.',
    input_schema: {
      type: 'object',
      required: ['keywords'],
      properties: {
        keywords: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'submit_report',
    description: 'Submit the final research report.',
    input_schema: {
      type: 'object',
      required: ['market_overview', 'competitor_ads', 'keyword_trends', 'audience_insights', 'platform_recommendations', 'benchmark_metrics', 'recommendations'],
      properties: {
        market_overview: {
          type: 'object',
          properties: {
            market_size_estimate: { type: 'string' },
            growth_trend: { type: 'string' },
            key_players: { type: 'array', items: { type: 'string' } },
            market_characteristics: { type: 'array', items: { type: 'string' } },
          },
        },
        competitor_ads: {
          type: 'object',
          properties: {
            summary: { type: 'string' },
            common_formats: { type: 'array', items: { type: 'string' } },
            common_messaging: { type: 'array', items: { type: 'string' } },
            gaps_and_opportunities: { type: 'array', items: { type: 'string' } },
          },
        },
        keyword_trends: {
          type: 'object',
          properties: {
            high_volume_keywords: { type: 'array', items: { type: 'string' } },
            rising_keywords: { type: 'array', items: { type: 'string' } },
            seasonal_patterns: { type: 'string' },
          },
        },
        audience_insights: {
          type: 'object',
          properties: {
            primary_segments: { type: 'array', items: { type: 'object' } },
            platform_preferences: { type: 'object' },
            content_preferences: { type: 'array', items: { type: 'string' } },
          },
        },
        platform_recommendations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              platform: { type: 'string' },
              fit_score: { type: 'number' },
              rationale: { type: 'string' },
            },
          },
        },
        benchmark_metrics: {
          type: 'object',
          properties: {
            estimated_cpm: { type: 'string' },
            estimated_cpc: { type: 'string' },
            estimated_ctr: { type: 'string' },
            estimated_cpl: { type: 'string' },
          },
        },
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
  products: [{ model: 'CFE-5', category: 'Residential ESS', key_specs: { capacity: '5kWh' } }],
  target_countries: ['Nigeria', 'Kenya'],
  budget: 3000,
  currency: 'USD',
};

const messages = [{
  role: 'user',
  content: `Conduct market research for this campaign brief and submit your report.\n\nCAMPAIGN BRIEF:\n${JSON.stringify(brief, null, 2)}`,
}];

console.log('\n=== Starting tool-use loop ===\n');

for (let i = 0; i < 8; i++) {
  console.log(`--- Iteration ${i + 1} ---`);
  const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: SYSTEM,
    messages,
    tools: RESEARCH_TOOLS,
    tool_choice: { type: 'auto' },
  });

  console.log('stop_reason:', response.stop_reason);
  console.log('content blocks:', response.content.map(c => ({ type: c.type, name: c.name, inputKeys: c.input ? Object.keys(c.input) : undefined, inputLength: c.input ? JSON.stringify(c.input).length : undefined })));

  if (response.stop_reason !== 'tool_use') {
    // Claude finished with text
    const text = response.content.filter(c => c.type === 'text').map(c => c.text).join('');
    console.log('Final text (truncated):', text.slice(0, 200));
    break;
  }

  const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');

  // Check submit_report
  const submitBlock = toolUseBlocks.find(t => t.name === 'submit_report');
  if (submitBlock) {
    const report = submitBlock.input;
    const keys = Object.keys(report || {});
    console.log('>>> submit_report input keys:', keys);
    console.log('>>> submit_report input length:', JSON.stringify(report).length);
    if (keys.length === 0) {
      console.log('>>> EMPTY REPORT! Full input:', JSON.stringify(report));
    } else {
      console.log('>>> Report looks valid! Keys:', keys.join(', '));
      // Print a snippet
      console.log('>>> recommendations:', JSON.stringify(report.recommendations)?.slice(0, 200));
      break;
    }
  }

  // Build tool results
  messages.push({ role: 'assistant', content: response.content });
  const toolResults = [];
  for (const toolUse of toolUseBlocks) {
    if (toolUse.name === 'submit_report') {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify({ status: 'rejected', reason: 'Report was empty. Please gather more data and try again.' }),
      });
      continue;
    }
    // Mock tool responses (skip real API calls for now)
    let result;
    if (toolUse.name === 'search_meta_ad_library') {
      result = { available: true, total: 3, ads: [
        { page_name: 'SolarMax NG', bodies: ['Best solar storage system'], titles: ['Save on energy'], start_date: '2026-01-10' },
        { page_name: 'GreenPower KE', bodies: ['Home battery backup'], titles: ['Never lose power'], start_date: '2026-02-05' },
      ]};
    } else if (toolUse.name === 'search_google_trends') {
      result = { available: true, trends: [
        { keyword: 'energy storage', interest_over_time: [{ date: '2026-01', value: 78 }], related_queries: [{ query: 'home battery' }] },
      ]};
    } else {
      result = { error: `Unknown tool: ${toolUse.name}` };
    }
    console.log(`  Tool ${toolUse.name} → responded`);
    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: JSON.stringify(result),
    });
  }
  messages.push({ role: 'user', content: toolResults });
}

console.log('\n=== Done ===');
