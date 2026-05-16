/**
 * Shared helper for generating short AI summaries with a MINIMAX → HAIKU fallback.
 *
 * Background: OpenRouter's MiniMax endpoint occasionally returns empty `choices`
 * (triggers `[llm-client] Empty response from provider`), especially on inputs
 * that contain raw conversation messages (possible content-filter trip) or under
 * rate-limit. HAIKU via Anthropic Direct is the safer second attempt.
 *
 * Both `/api/contacts/[id]/profile` (AI 客户画像) and
 * `/api/inquiry-dashboard/summary` (询盘看板总结) use this.
 */
import { openrouter, MODELS } from '../src/llm-client.js';

function extractText(response) {
  return response?.choices?.[0]?.message?.content?.trim() || '';
}

async function callModel(model, { system, userPrompt, maxTokens, tenantId, callSite, productLine }) {
  const response = await openrouter.messages.create({
    models: [model],
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: maxTokens,
  }, { tenantId, callSite, productLine });
  return extractText(response);
}

/**
 * Try MiniMax first; if it fails or returns empty, fall back to Haiku.
 *
 * @param {Object} opts
 * @param {string} opts.system - system prompt
 * @param {string} opts.userPrompt - user message content
 * @param {number} [opts.maxTokens=500]
 * @param {string} [opts.logTag='ai-summary'] - log prefix, e.g. 'contacts/profile'
 * @returns {Promise<string>} the generated text (non-empty). Throws if both fail.
 */
export async function generateSummaryWithFallback({ system, userPrompt, maxTokens = 500, logTag = 'ai-summary', tenantId = null, callSite = 'ai-summary', productLine = null }) {
  try {
    const text = await callModel(MODELS.MINIMAX, { system, userPrompt, maxTokens, tenantId, callSite, productLine });
    if (text) return text;
    console.warn(`[${logTag}] MINIMAX returned empty text, falling back to HAIKU`);
  } catch (err) {
    console.warn(`[${logTag}] MINIMAX failed, falling back to HAIKU:`, err.message);
  }

  const text = await callModel(MODELS.HAIKU, { system, userPrompt, maxTokens, tenantId, callSite, productLine });
  if (!text) throw new Error('Both MINIMAX and HAIKU returned empty responses');
  return text;
}
