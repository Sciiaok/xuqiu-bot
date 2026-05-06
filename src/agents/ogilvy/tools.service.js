/**
 * Autopilot web tools — web_search + read_webpage.
 *
 * Uses Anthropic's native web_search / web_fetch tools via OpenRouter. Kept
 * deliberately small: each function returns a plain JSON-serializable object
 * that can go directly into tool_result.
 *
 * Simplified for the single-agent autopilot loop (no brief_id, no phase tracking).
 */
import { openrouter, MODELS } from '../../llm-client.js';

// ── Helpers ─────────────────────────────────────────────────────────────
// OpenRouter returns Anthropic tool calls wrapped in OpenAI format:
//   response.choices[0].message.content is a plain string (often with ```json
//   fencing). We extract the JSON we asked for and fall back to URL scraping.

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
  // Find the first {...} block — model often wraps the JSON in prose.
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
 * Search the web. Returns a compact summary + up to 5 source links that the
 * Agent can then follow up on with read_webpage if needed.
 */
export async function webSearch({ query }, { tenantId } = {}) {
  if (!query || typeof query !== 'string') {
    return { error: 'query is required' };
  }
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
    }, { tenantId, callSite: 'ogilvy.web_search' });

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

/**
 * Fetch and summarize a specific URL. Use this after web_search finds a
 * promising link (product page, competitor site) that warrants a deeper read.
 */
export async function readWebpage({ url }, { tenantId } = {}) {
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
        allowed_domains: [hostname],   // Anthropic requires explicit domain allowlisting
        max_content_tokens: 12000,
      }],
    }, { tenantId, callSite: 'ogilvy.read_webpage' });

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
