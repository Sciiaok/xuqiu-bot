import { anthropic, MODELS } from './llm-client.js';
import { config } from './config.js';
import { mapCountriesToISO } from '../lib/country-codes.js';

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

Your job: analyze a campaign brief and pre-fetched external data, then produce a structured research report by calling submit_report.

The user message includes pre-fetched Meta Ad Library and Google Trends data. Synthesize this with your training knowledge to produce a comprehensive report.

Rules:
- Analyze all provided external data carefully — it is real-time data
- If external data is unavailable or empty, supplement with your training knowledge
- Be specific with numbers, benchmarks, and actionable insights
- Focus on the target markets and platforms relevant to the brief
- You MUST call submit_report with all required fields filled`;

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
export async function conductResearch(brief, instructions, onProgress) {
  const systemPrompt = instructions
    ? `${RESEARCH_SYSTEM_PROMPT}\n\n═══ 额外指令 ═══\n${instructions}`
    : RESEARCH_SYSTEM_PROMPT;

  // Pre-fetch external data in parallel (skip tool_use loop)
  // brief.products can be a string or array depending on how intake saved it
  const productsArr = Array.isArray(brief.products) ? brief.products : [];
  const productsStr = typeof brief.products === 'string' ? brief.products : '';
  const productNames = productsArr.map(p => p.model || p.name).filter(Boolean);
  const searchTerms = [brief.industry, ...productNames, productsStr].filter(Boolean).join(' ').trim();
  const countries = brief.target_countries || [];
  const keywords = [brief.industry, ...productNames, productsStr].filter(Boolean).slice(0, 3);

  onProgress?.({ step: 'fetching_data', detail: '获取 Meta 广告库和 Google Trends 数据' });
  const [adLibraryResult, trendsResult] = await Promise.all([
    fetchMetaAdLibrary({ search_terms: searchTerms, countries }).catch(err => ({ available: false, error: err.message })),
    fetchGoogleTrends({ keywords }).catch(err => ({ available: false, error: err.message })),
  ]);
  onProgress?.({ step: 'analyzing', detail: '分析市场数据，生成调研报告' });

  const rawAds = adLibraryResult?.ads || [];

  // Single LLM call with pre-fetched data — force submit_report
  const messages = [{
    role: 'user',
    content: `Conduct market research for this campaign brief and submit your report via submit_report.

CAMPAIGN BRIEF:
${JSON.stringify(brief)}

EXTERNAL DATA (pre-fetched):

=== Meta Ad Library Results ===
${JSON.stringify(adLibraryResult)}

=== Google Trends Results ===
${JSON.stringify(trendsResult)}

Analyze the brief and external data above, then call submit_report with your complete research report.`,
  }];

  const model = MODELS.MINIMAX;

  const response = await anthropic.messages.create({
    model,
    max_tokens: 16384,
    system: systemPrompt,
    messages,
    tools: RESEARCH_TOOLS,
    tool_choice: { type: 'tool', name: 'submit_report' },
  });

  const submitBlock = response.content.find(c => c.type === 'tool_use' && c.name === 'submit_report');
  if (submitBlock?.input && Object.keys(submitBlock.input).length > 0) {
    submitBlock.input.competitor_ads_raw = rawAds;
    return submitBlock.input;
  }

  // Log response for debugging
  const textBlock = response.content.find(c => c.type === 'text');
  console.error('[research] No valid submit_report. stop_reason:', response.stop_reason,
    'content_types:', response.content.map(c => c.type),
    'text_preview:', textBlock?.text?.slice(0, 200));

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
    fields: 'id,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_captions,page_name,spend,impressions,ad_delivery_start_time,ad_snapshot_url',
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
      snapshot_url: ad.ad_snapshot_url || null,
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

