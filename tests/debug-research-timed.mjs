import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });

import Anthropic from '@anthropic-ai/sdk';
import { mapCountriesToISO } from '../lib/country-codes.js';

const apiKey = process.env.OPENROUTER_API_KEY;
const baseURL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api';
const model = process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4-6';
const metaToken = process.env.META_SYSTEM_TOKEN || process.env.META_ACCESS_TOKEN;
const serpapiKey = process.env.SERPAPI_KEY;

console.log('Model:', model);
console.log('BaseURL:', baseURL);
console.log('META token:', metaToken ? '✅' : '❌');
console.log('SERPAPI key:', serpapiKey ? '✅' : '❌');

const anthropic = new Anthropic({ apiKey, baseURL });

// ── Real tool implementations ──
async function fetchMetaAdLibrary({ search_terms, countries }) {
  if (!metaToken) return { available: false, reason: 'META_ACCESS_TOKEN not configured' };
  const isoCodes = mapCountriesToISO(countries || []);
  const params = new URLSearchParams({
    access_token: metaToken, ad_type: 'ALL', search_terms: search_terms || '',
    ad_reached_countries: JSON.stringify(isoCodes.slice(0, 5)),
    fields: 'id,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_captions,page_name,spend,impressions,ad_delivery_start_time',
    limit: '25',
  });
  const url = `https://graph.facebook.com/v21.0/ads_archive?${params}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const data = await res.json();
  if (data.error) return { available: true, error: data.error.message, ads: [] };
  return {
    available: true, total: (data.data || []).length,
    ads: (data.data || []).map(ad => ({
      page_name: ad.page_name, bodies: ad.ad_creative_bodies || [],
      titles: ad.ad_creative_link_titles || [], start_date: ad.ad_delivery_start_time,
    })),
  };
}

async function fetchGoogleTrends({ keywords }) {
  if (!serpapiKey) return { available: false, reason: 'SERPAPI_KEY not configured' };
  const results = [];
  for (const keyword of (keywords || []).slice(0, 3)) {
    const params = new URLSearchParams({ engine: 'google_trends', q: keyword, api_key: serpapiKey, data_type: 'TIMESERIES' });
    const res = await fetch(`https://serpapi.com/search?${params}`, { signal: AbortSignal.timeout(30000) });
    const data = await res.json();
    if (data.error) { results.push({ keyword, error: data.error }); continue; }
    results.push({
      keyword,
      interest_over_time: data.interest_over_time?.timeline_data?.slice(-12) || [],
      related_queries: data.related_queries?.rising?.slice(0, 5) || [],
    });
  }
  return { available: true, trends: results };
}

async function executeTool(name, input) {
  if (name === 'search_meta_ad_library') return fetchMetaAdLibrary(input);
  if (name === 'search_google_trends') return fetchGoogleTrends(input);
  return { error: `Unknown tool: ${name}` };
}

// ── Tool schema (exact copy from research-agent.service.js) ──
const RESEARCH_TOOLS = [
  {
    name: 'search_meta_ad_library',
    description: 'Search the Meta Ad Library for competitor ads in specific industries and countries. Returns ad creative text, page names, and start dates. Requires META_ACCESS_TOKEN — returns null if unavailable.',
    input_schema: { type: 'object', required: ['search_terms', 'countries'], properties: { search_terms: { type: 'string', description: 'Keywords to search (e.g. "solar panel energy storage")' }, countries: { type: 'array', items: { type: 'string' }, description: 'Target country names (e.g. ["Nigeria", "Kenya"])' } } },
  },
  {
    name: 'search_google_trends',
    description: 'Query Google Trends for keyword interest over time and related rising queries. Requires SERPAPI_KEY — returns null if unavailable.',
    input_schema: { type: 'object', required: ['keywords'], properties: { keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to check trends for (max 3)' } } },
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
- You MUST call submit_report as your final action`;

const brief = {
  company_name: 'CF Energy', industry: 'energy storage',
  products: [{ model: 'CFE-5', category: 'Residential ESS', key_specs: { capacity: '5kWh' } }],
  target_countries: ['Nigeria', 'Kenya'], budget: 3000, currency: 'USD',
};

const messages = [{ role: 'user', content: `Conduct market research for this campaign brief and submit your report.\n\nCAMPAIGN BRIEF:\n${JSON.stringify(brief, null, 2)}` }];

console.log('\n========== FULL TIMED RUN ==========\n');
const t0 = Date.now();

for (let i = 0; i < 8; i++) {
  const tIter = Date.now();
  console.log(`--- Iteration ${i + 1} ---`);

  const response = await anthropic.messages.create({
    model, max_tokens: 8192, system: SYSTEM, messages,
    tools: RESEARCH_TOOLS, tool_choice: { type: 'auto' },
  });

  const llmMs = Date.now() - tIter;
  console.log(`  LLM call: ${llmMs}ms | stop_reason: ${response.stop_reason} | usage: in=${response.usage?.input_tokens} out=${response.usage?.output_tokens}`);

  if (response.stop_reason !== 'tool_use') {
    console.log('  Claude stopped (no tool_use).');
    break;
  }

  const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');
  console.log('  Tools called:', toolUseBlocks.map(t => t.name).join(', '));

  const submitBlock = toolUseBlocks.find(t => t.name === 'submit_report');
  if (submitBlock) {
    const report = submitBlock.input;
    const keys = Object.keys(report || {});
    const len = JSON.stringify(report).length;
    console.log(`  submit_report: ${keys.length} keys, ${len} chars`);
    if (keys.length > 0) {
      console.log(`  ✅ Valid report!`);
      // Print each top-level field status
      for (const k of keys) {
        const v = report[k];
        const empty = v == null || (typeof v === 'object' && Object.keys(v).length === 0) || (Array.isArray(v) && v.length === 0);
        console.log(`    ${k}: ${empty ? '⚠️  EMPTY' : '✅'} (${JSON.stringify(v).length} chars)`);
      }
      const totalMs = Date.now() - t0;
      console.log(`\n  ⏱️  Total time: ${(totalMs / 1000).toFixed(1)}s`);
      break;
    } else {
      console.log('  ⚠️  EMPTY REPORT');
    }
  }

  // Execute real tools
  messages.push({ role: 'assistant', content: response.content });
  const toolResults = [];
  for (const toolUse of toolUseBlocks) {
    if (toolUse.name === 'submit_report') {
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ status: 'rejected', reason: 'Report was empty.' }) });
      continue;
    }
    const tTool = Date.now();
    const result = await executeTool(toolUse.name, toolUse.input);
    const toolMs = Date.now() - tTool;
    console.log(`  Tool ${toolUse.name}: ${toolMs}ms → ${JSON.stringify(result).length} chars`);
    toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
  }
  messages.push({ role: 'user', content: toolResults });
}

console.log('\n========== DONE ==========');
