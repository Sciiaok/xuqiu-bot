/**
 * LLM Client — single source for all model API calls.
 *
 * Uses raw `fetch` — zero SDK dependencies.
 * All LLM calls go through OpenRouter /chat/completions (OpenAI format).
 *
 * Exposes two clients:
 *   - `openrouter`   → OpenRouter
 *                       .messages.create / .messages.stream  (/chat/completions, OpenAI format)
 *                       .embeddings.create                   (/embeddings)
 *                       .chat.completions.create             (/chat/completions, raw passthrough)
 *   - `openai`       → OpenAI Direct (Whisper only)
 *
 * Every business file imports its client from here — no other file may
 * read LLM API keys from process.env.
 */
import { config } from './config.js';
import { calcCostUsd } from './llm-pricing.js';
import { getSupabaseAdmin } from '../lib/supabase-admin.js';

// ── Model Registry ───────────────────────────────────────────────────
export const MODELS = {
  SONNET: 'anthropic/claude-sonnet-4.6',
  HAIKU: 'anthropic/claude-haiku-4.5',
  GPT54: 'openai/gpt-5.4',
  GPT54MINI:  'openai/gpt-5.4-mini',
  MINIMAX: 'minimax/minimax-m2.7',
  EMBEDDING: 'text-embedding-3-small',
  WHISPER: 'whisper-1',
};

// ══════════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════════

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Headers & SSE ────────────────────────────────────────────────────

function openrouterHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.openrouter.apiKey}`,
  };
}

function parseSSELine(line) {
  if (!line || line.startsWith(':')) return null;
  if (line.startsWith('data: ')) {
    const data = line.slice(6);
    if (data === '[DONE]') return null;
    try { return JSON.parse(data); } catch { return null; }
  }
  return null;
}

// ── Logging ──────────────────────────────────────────────────────────

function logLlmCall({ method, provider, models, responseModel, tools, toolChoice, finishReason, promptTokens, completionTokens, durationMs, tenantId, callSite }) {
  const model = responseModel || models?.[0];
  const costUsd = calcCostUsd({ model, promptTokens, completionTokens });

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    level: 'info',
    event: 'llm.call',
    component: 'llm-client',
    method,
    provider,
    base_url: config.openrouter.baseURL,
    models,
    response_model: model,
    tools: tools || 0,
    tool_choice: toolChoice || null,
    finish_reason: finishReason || null,
    prompt_tokens: promptTokens || 0,
    completion_tokens: completionTokens || 0,
    cost_usd: costUsd,
    duration_ms: durationMs,
    tenant_id: tenantId || null,
    call_site: callSite || null,
  }));

  // Fire-and-forget 落表，不 await、不抛错 —— 写不进去也不应该影响 LLM 返回。
  // callSite 缺失时仍记一行，便于发现哪些调用点没埋点。
  try {
    getSupabaseAdmin()
      .from('llm_usage_logs')
      .insert({
        tenant_id: tenantId || null,
        call_site: callSite || 'unknown',
        provider,
        model: model || null,
        prompt_tokens: promptTokens || 0,
        completion_tokens: completionTokens || 0,
        cost_usd: costUsd,
        duration_ms: durationMs ?? null,
        finish_reason: finishReason || null,
      })
      .then(({ error }) => {
        if (error) console.error('[llm-client] persist usage failed:', error.message);
      });
  } catch (err) {
    console.error('[llm-client] persist usage threw:', err?.message);
  }
}

// ══════════════════════════════════════════════════════════════════════
// Streaming — yields raw OpenAI SSE chunks, assembles finalMessage()
// ══════════════════════════════════════════════════════════════════════

// Stream health thresholds — kill the connection rather than wait forever
// when OpenRouter routes us to a slow/stalled provider.
const STREAM_IDLE_TIMEOUT_MS  = 30_000;   // no bytes for 30s → abort
const STREAM_TOTAL_TIMEOUT_MS = 180_000;  // total stream > 3min → abort

function createStream(params) {
  let _finalResolve, _finalReject;
  const _finalPromise = new Promise((resolve, reject) => {
    _finalResolve = resolve;
    _finalReject = reject;
  });

  // Single abort controller covers both the initial fetch and the SSE read
  // loop. Firing it cleanly terminates the response.body.getReader().read()
  // with an AbortError on the next await.
  const abortController = new AbortController();
  const startedAt = Date.now();
  let lastChunkAt = Date.now();
  let aborted = false;

  const abortWith = (reason) => {
    if (aborted) return;
    aborted = true;
    try { abortController.abort(new Error(reason)); } catch {}
  };

  // Watchdog: every second, check if stream has stalled or blown the budget.
  const watchdog = setInterval(() => {
    if (aborted) return;
    const now = Date.now();
    if (now - startedAt > STREAM_TOTAL_TIMEOUT_MS) {
      abortWith(`stream_total_timeout (${STREAM_TOTAL_TIMEOUT_MS / 1000}s)`);
    } else if (now - lastChunkAt > STREAM_IDLE_TIMEOUT_MS) {
      abortWith(`stream_idle_timeout (${STREAM_IDLE_TIMEOUT_MS / 1000}s)`);
    }
  }, 1000);

  const fetchPromise = fetchWithTimeout(
    `${config.openrouter.baseURL}/chat/completions`,
    {
      method: 'POST',
      headers: openrouterHeaders(),
      body: JSON.stringify({ ...params, stream: true }),
      signal: abortController.signal,
    },
    120_000,
  );

  async function* iterChunks() {
    let response;
    try {
      response = await fetchPromise;
    } catch (err) {
      clearInterval(watchdog);
      _finalReject(err);
      throw err;
    }

    if (!response.ok) {
      clearInterval(watchdog);
      const body = await response.text();
      const err = new Error(`OpenRouter API error ${response.status}: ${body}`);
      _finalReject(err);
      throw err;
    }

    // State for assembling finalMessage
    let model = null;
    let finishReason = null;
    let usage = {};
    let contentText = '';
    const toolCalls = {};  // index → { id, type, function: { name, arguments } }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        lastChunkAt = Date.now();
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const chunk = parseSSELine(line.trim());
          if (!chunk) continue;

          if (!model && chunk.model) model = chunk.model;

          const choice = chunk.choices?.[0];
          if (choice) {
            const delta = choice.delta;
            if (delta?.content) contentText += delta.content;
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCalls[idx]) {
                  toolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
                }
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
              }
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
          }

          if (chunk.usage) usage = chunk.usage;

          yield chunk;
        }
      }
    } catch (err) {
      clearInterval(watchdog);
      if (aborted) {
        const tagged = new Error(`LLM stream aborted: ${err?.message || 'timeout'}`);
        tagged.code = 'LLM_STREAM_ABORTED';
        _finalReject(tagged);
        throw tagged;
      }
      _finalReject(err);
      throw err;
    }
    clearInterval(watchdog);

    // Assemble final message in OpenAI response shape
    const message = { role: 'assistant', content: contentText || null };
    const tcArray = Object.values(toolCalls);
    if (tcArray.length) message.tool_calls = tcArray;

    const finalResult = {
      id: null,
      model,
      choices: [{ message, finish_reason: finishReason || 'stop' }],
      usage,
    };
    _finalResolve(finalResult);
  }

  const iterator = iterChunks();

  return {
    [Symbol.asyncIterator]() { return iterator; },
    next: iterator.next.bind(iterator),
    return: iterator.return.bind(iterator),
    throw: iterator.throw.bind(iterator),
    finalMessage() { return _finalPromise; },
  };
}

// ══════════════════════════════════════════════════════════════════════
// OpenRouter client
// ══════════════════════════════════════════════════════════════════════

const openrouter = {
  messages: {
    // meta = { tenantId, callSite } —— 用于成本统计落表。callSite 是文本枚举
    // （形如 'medici.qualify' / 'kb.search.embed'），调用方自定。
    async create(params, meta = {}) {
      if (!config.openrouter.baseURL || !config.openrouter.apiKey) {
        throw new Error('[llm-client] OPENROUTER_API_KEY required');
      }

      const t0 = Date.now();
      const logMeta = {
        method: 'create',
        provider: 'openrouter',
        models: params.models,
        tools: params.tools?.length || 0,
        toolChoice: typeof params.tool_choice === 'string' ? params.tool_choice : params.tool_choice?.function?.name || null,
        tenantId: meta.tenantId,
        callSite: meta.callSite,
      };

      const response = await fetchWithTimeout(
        `${config.openrouter.baseURL}/chat/completions`,
        {
          method: 'POST',
          headers: openrouterHeaders(),
          body: JSON.stringify(params),
        },
        120_000,
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenRouter API error ${response.status}: ${body}`);
      }
      const result = await response.json();

      logLlmCall({
        ...logMeta,
        responseModel: result.model,
        finishReason: result.choices?.[0]?.finish_reason,
        promptTokens: result.usage?.prompt_tokens,
        completionTokens: result.usage?.completion_tokens,
        durationMs: Date.now() - t0,
      });
      return result;
    },

    stream(params, meta = {}) {
      if (!config.openrouter.baseURL || !config.openrouter.apiKey) {
        throw new Error('[llm-client] OPENROUTER_API_KEY required');
      }

      const t0 = Date.now();
      const logMeta = {
        method: 'stream',
        provider: 'openrouter',
        models: params.models,
        tools: params.tools?.length || 0,
        toolChoice: typeof params.tool_choice === 'string' ? params.tool_choice : params.tool_choice?.function?.name || null,
        tenantId: meta.tenantId,
        callSite: meta.callSite,
      };

      const streamObj = createStream(params);

      streamObj.finalMessage().then(result => {
        logLlmCall({
          ...logMeta,
          responseModel: result.model,
          finishReason: result.choices?.[0]?.finish_reason,
          promptTokens: result.usage?.prompt_tokens,
          completionTokens: result.usage?.completion_tokens,
          durationMs: Date.now() - t0,
        });
      }).catch(err => {
        logLlmCall({ ...logMeta, finishReason: `error: ${err.message}`, durationMs: Date.now() - t0 });
      });

      return streamObj;
    },
  },

  // ── OpenAI-compatible endpoints (embeddings + image generation) ────
  embeddings: {
    async create(params, options) {
      if (!config.openrouter.baseURL || !config.openrouter.apiKey) {
        throw new Error('[llm-client] OPENROUTER_API_KEY required for embeddings');
      }
      const timeoutMs = options?.timeout || 60_000;
      const response = await fetchWithTimeout(
        `${config.openrouter.baseURL}/embeddings`,
        {
          method: 'POST',
          headers: openrouterHeaders(),
          body: JSON.stringify(params),
        },
        timeoutMs,
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenRouter embeddings error ${response.status}: ${body}`);
      }
      return response.json();
    },
  },
  chat: {
    completions: {
      async create(params, options) {
        if (!config.openrouter.baseURL || !config.openrouter.apiKey) {
          throw new Error('[llm-client] OPENROUTER_API_KEY required for chat completions');
        }
        const timeoutMs = options?.timeout || 120_000;
        const response = await fetchWithTimeout(
          `${config.openrouter.baseURL}/chat/completions`,
          {
            method: 'POST',
            headers: openrouterHeaders(),
            body: JSON.stringify(params),
          },
          timeoutMs,
        );
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`OpenRouter chat error ${response.status}: ${body}`);
        }
        return response.json();
      },
    },
  },
};

// ══════════════════════════════════════════════════════════════════════
// OpenAI client (Direct) — Whisper only
// ══════════════════════════════════════════════════════════════════════

const openai = {
  audio: {
    transcriptions: {
      async create(params) {
        const form = new FormData();
        form.append('file', params.file);
        form.append('model', params.model);
        if (params.language) form.append('language', params.language);
        if (params.prompt) form.append('prompt', params.prompt);

        const response = await fetchWithTimeout(
          `https://api.openai.com/v1/audio/transcriptions`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${config.openai.apiKey}` },
            body: form,
          },
          60_000,
        );
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`OpenAI transcription error ${response.status}: ${body}`);
        }
        return response.json();
      },
    },
  },
};

// ── Exports ──────────────────────────────────────────────────────────
export { openrouter, openai };
