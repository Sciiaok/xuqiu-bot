/**
 * Ogilvy web tools — web_search + read_webpage.
 *
 * Primary path is Tavily REST API: single fetch, no LLM round-trip, ~$0.001-
 * 0.005 per query. Returns the same `{query, summary, results[]}` shape as the
 * legacy Anthropic-web_search path so downstream history reconstruction is
 * unchanged. Tool descriptions exposed to the agent also stay identical.
 *
 * Fallback path uses Anthropic's native web_search / web_fetch tools via
 * OpenRouter — kept around for environments without TAVILY_API_KEY (and so the
 * change is non-breaking on first deploy). Fallback is materially more
 * expensive (~$0.02 per query due to Haiku middleman re-ingesting 19k input
 * tokens of search-result content); the per-call log makes it obvious if a
 * deployment is still hitting the slow path.
 */
import { config } from '../../config.js';
import { openrouter, MODELS } from '../../llm-client.js';

const TAVILY_TIMEOUT_MS = 30_000;

// ── Session-scope search cache ──────────────────────────────────────────
// Real Ogilvy traffic (last 30d, 9 active sessions, 624 web_search calls)
// shows ~25–35% of searches within a session are near-duplicates: the agent
// re-queries the same market in slightly different wording while iterating
// through stages. Caching by normalized query within a session returns the
// same result instead of paying for redundant searches. TTL is generous
// (3h) because real sessions span hours.
//
// Module-level Map is fine: Next.js routes the SSE stream for a session to a
// single worker for the duration. Across-restart misses are acceptable.
const SEARCH_CACHE = new Map();
const SEARCH_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 10_000;

function normalizeQuery(q) {
  return String(q || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function searchCacheKey(sessionId, query) {
  return `${sessionId || '_none'}::${normalizeQuery(query)}`;
}

function searchCacheGet(sessionId, query) {
  if (!sessionId) return null;
  const key = searchCacheKey(sessionId, query);
  const entry = SEARCH_CACHE.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    SEARCH_CACHE.delete(key);
    return null;
  }
  return entry.result;
}

function searchCacheSet(sessionId, query, result) {
  if (!sessionId) return;
  SEARCH_CACHE.set(searchCacheKey(sessionId, query), {
    result,
    expires: Date.now() + SEARCH_CACHE_TTL_MS,
  });
  // Cheap bound: when oversized, drop the 10% with earliest expiry.
  if (SEARCH_CACHE.size > SEARCH_CACHE_MAX_ENTRIES) {
    const cutoff = Math.floor(SEARCH_CACHE_MAX_ENTRIES * 0.1);
    const toDrop = [...SEARCH_CACHE.entries()]
      .sort((a, b) => a[1].expires - b[1].expires)
      .slice(0, cutoff);
    for (const [k] of toDrop) SEARCH_CACHE.delete(k);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function getMessageText(response) {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function stripCodeFence(text = '') {
  return text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function tryParseJson(text = '') {
  if (!text) return null;
  try { return JSON.parse(stripCodeFence(text)); } catch { /* fall through */ }
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function extractUrls(text = '') {
  const re = /\bhttps?:\/\/[^\s<>"')]+/gi;
  return Array.from(new Set((text.match(re) || []).map(u => u.replace(/[.,;:!?)]+$/, ''))));
}

// ── Tools ───────────────────────────────────────────────────────────────

/**
 * Search the web. Returns a compact summary + up to 5 source links the Agent
 * can follow up on with read_webpage. Cost-sensitive: Tavily path is preferred,
 * Anthropic fallback exists for compat.
 *
 * Session-level dedupe: if the same normalized query was issued earlier in
 * this session (within the TTL window), the cached result is returned
 * verbatim. The agent sees the same shape — only `cached: true` is added so
 * the route layer / logs can distinguish.
 */
export async function webSearch({ query }, { tenantId, sessionId } = {}) {
  if (!query || typeof query !== 'string') {
    return { error: 'query is required' };
  }

  const cached = searchCacheGet(sessionId, query);
  if (cached) return { ...cached, cached: true };

  let result;
  if (config.tavily?.apiKey) {
    try {
      result = await tavilySearch(query);
    } catch (err) {
      // Don't silently regress to the expensive path — log the reason so it
      // shows up when the cheap one breaks (rate-limit, key invalidated, etc).
      console.warn(`[ogilvy/tools] tavily search failed, falling back to anthropic: ${err.message}`);
      result = await anthropicWebSearch(query, { tenantId, sessionId });
    }
  } else {
    result = await anthropicWebSearch(query, { tenantId, sessionId });
  }

  // Don't pollute the cache with error results.
  if (result && !result.error) searchCacheSet(sessionId, query, result);
  return result;
}

/**
 * Fetch and summarize a specific URL. Use after web_search finds a promising
 * link (product page, competitor site) that warrants a deeper read.
 *
 * Note: this path stays on Anthropic web_fetch + Haiku for now. Tavily's
 * /extract endpoint covers the same use case but isn't wired here yet — the
 * call volume is materially lower than web_search (last 30d: 20 read_webpage
 * vs 624 web_search per the usage log), so the ROI is in the search path.
 */
export async function readWebpage({ url }, { tenantId, sessionId } = {}) {
  if (!url || typeof url !== 'string') {
    return { error: 'url is required' };
  }
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { error: `Invalid URL: ${url}` };
  }
  try {
    const response = await openrouter.messages.create({
      models: [MODELS.HAIKU],
      max_tokens: 1800,
      messages: [{
        role: 'user',
        content:
          `你必须使用 web_fetch 读取这个网页：${url}\n` +
          '完成后在回复最后返回一个 JSON 对象（用 ```json 包起来），格式：' +
          '{"url":"页面URL","title":"页面标题","content":"保留关键信息的正文摘要，最多3000字"}',
      }],
      tools: [{
        type: 'web_fetch_20250910',
        name: 'web_fetch',
        max_uses: 1,
        allowed_domains: [hostname],
        max_content_tokens: 12000,
      }],
    }, { tenantId, callSite: 'ogilvy.read_webpage', sessionId });

    const text = getMessageText(response);
    const parsed = tryParseJson(text);

    return {
      url: parsed?.url || url,
      title: parsed?.title || null,
      content: (parsed?.content || text || '').slice(0, 6000),
    };
  } catch (err) {
    return { error: `Read error: ${err.message}`, content: '' };
  }
}

// ── Tavily REST path ────────────────────────────────────────────────────

/**
 * Call Tavily's /search endpoint. Doc: https://docs.tavily.com/docs/rest-api/api-reference
 *
 * Tuning rationale:
 *   - search_depth: 'advanced' — basic mode returns shallow snippets and a
 *     weak Tavily-LLM answer; advanced does deeper crawl, content-quality
 *     re-ranking, and a far stronger answer. ~2× the price ($0.008 vs $0.004)
 *     but still ~10× cheaper than the Anthropic-Haiku path and the answer
 *     quality is closer to (sometimes exceeds) what Haiku produced.
 *   - include_answer: true gives a Tavily-LLM-generated answer string we
 *     use directly as `summary`, so we don't need a Haiku middleman.
 *   - max_results: 5 matches the legacy contract.
 *   - Each result keeps its `content` field (Tavily returns ~500-1500 char
 *     summary per source in advanced mode). Stripping it — as a previous
 *     iteration did — turned this from "5 mini-summaries" into "5 bare URLs"
 *     and forced the agent into a needless `read_webpage` for any followup.
 *     Capped at 1500 chars/result to keep tool_result history reasonable.
 */
async function tavilySearch(query) {
  const url = `${config.tavily.baseURL}/search`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.tavily.apiKey,
      query,
      search_depth: 'advanced',
      include_answer: true,
      max_results: 5,
    }),
    signal: AbortSignal.timeout(TAVILY_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Tavily ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const results = Array.isArray(data.results)
    ? data.results.slice(0, 5).map(r => ({
        title: r.title || r.url,
        url: r.url,
        content: typeof r.content === 'string' ? r.content.slice(0, 1500) : '',
      }))
    : [];
  const summary = (data.answer || '').slice(0, 2000);
  return { query, summary, results };
}

// ── Anthropic native fallback (legacy path) ─────────────────────────────

async function anthropicWebSearch(query, { tenantId, sessionId }) {
  try {
    const response = await openrouter.messages.create({
      models: [MODELS.HAIKU],
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content:
          `你必须使用 web_search 搜索这个查询：${query}\n` +
          '完成后，在回复的最后返回一个 JSON 对象（用 ```json 包起来），格式：' +
          '{"query":"原查询","summary":"200字内中文摘要","results":[{"title":"标题","url":"https://..."}]}\n' +
          'results 最多 5 条，优先保留官网、产品页、权威资料链接。',
      }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
    }, { tenantId, callSite: 'ogilvy.web_search', sessionId });

    const text = getMessageText(response);
    const parsed = tryParseJson(text);
    const parsedResults = Array.isArray(parsed?.results)
      ? parsed.results.filter(r => r?.url).map(r => ({ title: r.title || r.url, url: r.url }))
      : [];
    const results = parsedResults.length
      ? parsedResults.slice(0, 5)
      : extractUrls(text).slice(0, 5).map(url => ({ title: url, url }));

    return {
      query,
      summary: (parsed?.summary || text.slice(0, 2000)).slice(0, 2000),
      results,
    };
  } catch (err) {
    return { error: `Search error: ${err.message}`, results: [] };
  }
}
