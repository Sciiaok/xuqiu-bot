import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { mapCountriesToISO } from '../lib/country-codes.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL && { baseURL: config.anthropic.baseURL }),
});

const FETCH_TIMEOUT = 30_000;
const META_GRAPH_URL = 'https://graph.facebook.com';
const MAX_TOOL_ITERATIONS = 8;

// ── Tool definitions ───────────────────────────────────────────────────

const RESEARCH_TOOLS = [
  {
    name: 'search_meta_ad_library',
    description: 'Search the Meta Ad Library for competitor ads in specific industries and countries. Returns ad creative text, page names, and start dates. Requires META_ACCESS_TOKEN — returns null if unavailable.',
    input_schema: {
      type: 'object',
      required: ['search_terms', 'countries'],
      properties: {
        search_terms: { type: 'string', description: 'Keywords to search (e.g. "solar panel energy storage")' },
        countries: {
          type: 'array',
          items: { type: 'string' },
          description: 'Target country names (e.g. ["Nigeria", "Kenya"])',
        },
      },
    },
  },
  {
    name: 'search_google_trends',
    description: 'Query Google Trends for keyword interest over time and related rising queries. Requires SERPAPI_KEY — returns null if unavailable.',
    input_schema: {
      type: 'object',
      required: ['keywords'],
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Keywords to check trends for (max 3)',
        },
      },
    },
  },
  {
    name: 'submit_report',
    description: 'Submit the final research report. Call this after gathering all needed data.',
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

const RESEARCH_SYSTEM_PROMPT = `You are a digital advertising market research analyst.

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

// ── Tool execution ─────────────────────────────────────────────────────

async function executeTool(toolName, toolInput) {
  switch (toolName) {
    case 'search_meta_ad_library':
      return await fetchMetaAdLibrary(toolInput);
    case 'search_google_trends':
      return await fetchGoogleTrends(toolInput);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Conduct market research using Claude tool_use.
 * Claude decides which tools to call, gathers data, and submits a structured report.
 *
 * @param {Object} brief - CampaignBrief object
 * @returns {Promise<Object>} Research report
 */
export async function conductResearch(brief, instructions) {
  const systemPrompt = instructions
    ? `${RESEARCH_SYSTEM_PROMPT}\n\n═══ 额外指令 ═══\n${instructions}`
    : RESEARCH_SYSTEM_PROMPT;

  const messages = [{
    role: 'user',
    content: `Conduct market research for this campaign brief and submit your report.\n\nCAMPAIGN BRIEF:\n${JSON.stringify(brief, null, 2)}`,
  }];

  let response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
    tools: RESEARCH_TOOLS,
    tool_choice: { type: 'auto' },
  });

  // Tool-use loop
  let iterations = 0;
  while (iterations < MAX_TOOL_ITERATIONS) {
    if (response.stop_reason !== 'tool_use') break;
    iterations++;

    const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');

    // Check for submit_report
    const submitBlock = toolUseBlocks.find(t => t.name === 'submit_report');
    if (submitBlock) {
      const report = submitBlock.input;
      if (report && Object.keys(report).length > 0) return report;
      console.warn('[research] submit_report received empty input, retrying...');
    }

    // Execute all non-submit tools (skip submit_report — it's handled above)
    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      if (toolUse.name === 'submit_report') {
        // Return acknowledgment for submit_report so Claude doesn't get confused
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify({ status: 'rejected', reason: 'Report was empty or missing required fields. Please gather more data and try again.' }),
        });
        continue;
      }
      const result = await executeTool(toolUse.name, toolUse.input);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages,
      tools: RESEARCH_TOOLS,
      tool_choice: { type: 'auto' },
    });
  }

  // Final check: Claude may have called submit_report in the last response
  const finalSubmit = response.content.find(c => c.type === 'tool_use' && c.name === 'submit_report');
  if (finalSubmit?.input && Object.keys(finalSubmit.input).length > 0) {
    return finalSubmit.input;
  }

  // Force submit_report if Claude didn't call it or submitted empty
  messages.push({ role: 'assistant', content: response.content });
  messages.push({ role: 'user', content: 'You MUST now call submit_report with a complete research report. Include market_overview, competitor_ads, keyword_trends, audience_insights, platform_recommendations, benchmark_metrics, and recommendations. Do NOT submit empty fields.' });

  response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
    tools: RESEARCH_TOOLS,
    tool_choice: { type: 'tool', name: 'submit_report' },
  });

  const forced = response.content.find(c => c.type === 'tool_use' && c.name === 'submit_report');
  if (forced) return forced.input;

  throw new Error('Research agent did not produce a report');
}

// ── External API implementations ───────────────────────────────────────

/**
 * Query Meta Ad Library for competitor ads.
 */
export async function fetchMetaAdLibrary({ search_terms, countries }) {
  const token = config.meta?.accessToken;
  if (!token) return { available: false, reason: 'META_ACCESS_TOKEN not configured' };

  const isoCodes = mapCountriesToISO(countries || []);

  const params = new URLSearchParams({
    access_token: token,
    ad_type: 'ALL',
    search_terms: search_terms || '',
    ad_reached_countries: JSON.stringify(isoCodes.slice(0, 5)),
    fields: 'id,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_captions,page_name,spend,impressions,ad_delivery_start_time',
    limit: '25',
  });

  const url = `${META_GRAPH_URL}/${config.meta.apiVersion}/ads_archive?${params}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  const data = await res.json();

  if (data.error) {
    return { available: true, error: data.error.message, ads: [] };
  }

  return {
    available: true,
    total: (data.data || []).length,
    ads: (data.data || []).map(ad => ({
      page_name: ad.page_name,
      bodies: ad.ad_creative_bodies || [],
      titles: ad.ad_creative_link_titles || [],
      captions: ad.ad_creative_link_captions || [],
      start_date: ad.ad_delivery_start_time,
    })),
  };
}

/**
 * Query Google Trends via SerpAPI.
 */
export async function fetchGoogleTrends({ keywords }) {
  const apiKey = config.serpapi?.apiKey;
  if (!apiKey) return { available: false, reason: 'SERPAPI_KEY not configured' };

  const results = [];
  for (const keyword of (keywords || []).slice(0, 3)) {
    const params = new URLSearchParams({
      engine: 'google_trends',
      q: keyword,
      api_key: apiKey,
      data_type: 'TIMESERIES',
    });

    const res = await fetch(`https://serpapi.com/search?${params}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    const data = await res.json();

    if (data.error) {
      results.push({ keyword, error: data.error });
      continue;
    }

    results.push({
      keyword,
      interest_over_time: data.interest_over_time?.timeline_data?.slice(-12) || [],
      related_queries: data.related_queries?.rising?.slice(0, 5) || [],
    });
  }

  return { available: true, trends: results };
}

// ── Utilities ──────────────────────────────────────────────────────────

