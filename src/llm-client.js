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
import { calcCostUsd, calcWhisperCostUsd } from './llm-pricing.js';
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

function logLlmCall({
  method, provider, models, responseModel, tools, toolChoice, finishReason,
  promptTokens, completionTokens, cacheCreationInputTokens, cacheReadInputTokens,
  durationMs, tenantId, callSite, sessionId, productLine,
  // 由 caller 直接给定的成本(USD)。两类用途:
  //   1. OpenRouter response 里 usage.cost (权威账单值,与控制台 spend 一致)
  //   2. 图片生成 / Whisper 这类非 token 计费 —— caller 按音频秒数或图片张数算
  // 优先级: costUsdOverride > calcCostUsd 本地价表 fallback。
  costUsdOverride,
  // 该次成本的来源标识。落入 JSON 日志,部署后能从日志 grep "cost_source=local"
  // 看哪些调用还在用本地价表(说明 OpenRouter 没返 usage.cost,或走的是 OpenAI
  // 直连)。值范围: 'openrouter' (response.usage.cost) / 'openai-direct-calc'
  // (Whisper/image 本地公式) / 'local-pricing-table' (兜底)。
  costSource,
  // 失败时的 provider 错误文本（OpenAI/OpenRouter error.message 或本地 throw）。
  // 配合 finishReason='error' 使用 —— caller 在 catch 块也调 logLlmCall 时填，
  // 落入 llm_usage_logs.error_message，事后 SQL 直接查到失败原因。
  errorMessage,
}) {
  const model = responseModel || models?.[0];

  // 埋点丢失告警 —— 不抛错，但在 stderr 留 stack trace，方便回滚 grep 出来。
  // 历史上 30d 窗口里有 334 行 call_site='unknown'/tenant_id=null，没人发现源头。
  // 这里有 stack 之后下一次发生时能直接定位。
  if (!callSite) {
    console.warn(`[llm-client] callSite missing for ${method} ${model} — stack:\n${new Error().stack}`);
  }
  if (!tenantId) {
    console.warn(`[llm-client] tenantId missing for ${method} ${model} call_site=${callSite || 'unknown'} — stack:\n${new Error().stack}`);
  }

  let costUsd;
  let resolvedSource;
  if (costUsdOverride != null) {
    costUsd = Number(costUsdOverride);
    resolvedSource = costSource || 'override';
  } else {
    costUsd = calcCostUsd({
      model,
      promptTokens,
      completionTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    });
    resolvedSource = 'local-pricing-table';
  }

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
    cache_creation_input_tokens: cacheCreationInputTokens || 0,
    cache_read_input_tokens: cacheReadInputTokens || 0,
    cost_usd: costUsd,
    cost_source: resolvedSource,
    duration_ms: durationMs,
    tenant_id: tenantId || null,
    call_site: callSite || null,
    session_id: sessionId || null,
    product_line: productLine || null,
    error_message: errorMessage || null,
  }));

  // Fire-and-forget 落表，不 await、不抛错 —— 写不进去也不应该影响 LLM 返回。
  // callSite 缺失时仍记一行，便于发现哪些调用点没埋点。
  //
  // 兼容性：cache_*_tokens 列在 2026-05-13 migration 才加上、session_id 在
  // 2026-05-15 migration 才加上、product_line 在 2026-05-16 加上、cost_source
  // 在 2026-05-18 加上、error_message 在 2026-05-22 加上。任一 migration 没
  // apply 的环境，PostgREST 会回 42703 undefined_column；这时退回到 baseRow
  // 老 schema，不丢日志。
  try {
    const baseRow = {
      tenant_id: tenantId || null,
      call_site: callSite || 'unknown',
      provider,
      model: model || null,
      prompt_tokens: promptTokens || 0,
      completion_tokens: completionTokens || 0,
      cost_usd: costUsd,
      duration_ms: durationMs ?? null,
      finish_reason: finishReason || null,
    };
    const rowWithExtras = {
      ...baseRow,
      cache_creation_input_tokens: cacheCreationInputTokens || 0,
      cache_read_input_tokens: cacheReadInputTokens || 0,
      session_id: sessionId || null,
      product_line: productLine || null,
      cost_source: resolvedSource,
      error_message: errorMessage || null,
    };
    const admin = getSupabaseAdmin();
    admin.from('llm_usage_logs').insert(rowWithExtras).then(({ error }) => {
      if (!error) return;
      // 42703 = undefined_column —— migration 没 apply，退回老 schema 重试。
      if (error.code === '42703' || /column .* does not exist/i.test(error.message || '')) {
        admin.from('llm_usage_logs').insert(baseRow).then(({ error: fallbackErr }) => {
          if (fallbackErr) console.error('[llm-client] persist usage failed:', fallbackErr.message);
        });
      } else {
        console.error('[llm-client] persist usage failed:', error.message);
      }
    });
  } catch (err) {
    console.error('[llm-client] persist usage threw:', err?.message);
  }
}

// 让 OpenRouter 在 response.usage 里返回它实际向账户扣的费 (usage.cost)。
// 这是和 OpenRouter 控制台 "Spend By Model" 完全一致的权威值,免去本地维护
// 价表的全部漂移风险(模型涨/降价、cache 折扣调整、合作折扣等都自动跟上)。
// 缺失或 false 时 OpenRouter 不会附 cost 字段,llm-client 回落到 calcCostUsd
// 本地价表 fallback。幂等;尊重 caller 自带的 usage 形状。
function withUsageInclude(params) {
  return { ...params, usage: { ...(params.usage || {}), include: true } };
}

// Anthropic prompt-caching 的 usage 字段在 OpenRouter 透传时藏在不同位置，
// 不同 provider 命名也略有差异 —— 这个 helper 把它们统一成 { cacheCreate, cacheRead }。
//
// 已知字段路径（命中过的形态都兜底）：
//   usage.cache_creation_input_tokens / usage.cache_read_input_tokens   ← OpenRouter 直透 Anthropic
//   usage.prompt_tokens_details.{cached_tokens, cache_write_tokens}     ← OpenAI 兼容字段（部分 provider）
//   usage.cached_tokens                                                 ← 旧版兜底
function extractCacheTokens(usage) {
  if (!usage) return { cacheCreate: 0, cacheRead: 0 };
  const details = usage.prompt_tokens_details || {};
  const cacheCreate =
    usage.cache_creation_input_tokens ??
    details.cache_write_tokens ??
    0;
  const cacheRead =
    usage.cache_read_input_tokens ??
    details.cached_tokens ??
    usage.cached_tokens ??
    0;
  return { cacheCreate: Number(cacheCreate) || 0, cacheRead: Number(cacheRead) || 0 };
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
    // meta = { tenantId, callSite, sessionId?, productLine? } —— 用于成本统计
    // 落表。callSite 是文本枚举（形如 'medici.qualify' / 'kb.search.embed'），
    // 调用方自定。sessionId 可选，传了才能在 per-session 用量看板里聚合
    // （ogilvy/medici 都用 uuid）。productLine 可选，挂上后 /product-lines/[id]
    // 的成本分析 tab 能按产品线聚合；Ogilvy 等不归属调用留空。
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
        sessionId: meta.sessionId,
        productLine: meta.productLine,
      };

      const response = await fetchWithTimeout(
        `${config.openrouter.baseURL}/chat/completions`,
        {
          method: 'POST',
          headers: openrouterHeaders(),
          body: JSON.stringify(withUsageInclude(params)),
        },
        120_000,
      );
      if (!response.ok) {
        const body = await response.text();
        throw new Error(`OpenRouter API error ${response.status}: ${body}`);
      }
      const result = await response.json();

      const { cacheCreate, cacheRead } = extractCacheTokens(result.usage);
      // result.usage.cost 是 OpenRouter 给账户实际扣费的权威值。在则走 override
      // 路径,本地价表彻底闭口;不在(老 provider / API 缓存层 bug)才回落 calcCost。
      const orCost = result.usage?.cost;
      logLlmCall({
        ...logMeta,
        responseModel: result.model,
        finishReason: result.choices?.[0]?.finish_reason,
        promptTokens: result.usage?.prompt_tokens,
        completionTokens: result.usage?.completion_tokens,
        cacheCreationInputTokens: cacheCreate,
        cacheReadInputTokens: cacheRead,
        durationMs: Date.now() - t0,
        costUsdOverride: orCost != null ? orCost : null,
        costSource: orCost != null ? 'openrouter' : null,
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
        sessionId: meta.sessionId,
        productLine: meta.productLine,
      };

      // SSE 最末一个 usage chunk 也带 cost(usage.include 已注入)。createStream
      // 内部的 if(chunk.usage) usage=chunk.usage 会捕获到最终 usage 对象。
      const streamObj = createStream(withUsageInclude(params));

      streamObj.finalMessage().then(result => {
        const { cacheCreate, cacheRead } = extractCacheTokens(result.usage);
        const orCost = result.usage?.cost;
        logLlmCall({
          ...logMeta,
          responseModel: result.model,
          finishReason: result.choices?.[0]?.finish_reason,
          promptTokens: result.usage?.prompt_tokens,
          completionTokens: result.usage?.completion_tokens,
          cacheCreationInputTokens: cacheCreate,
          cacheReadInputTokens: cacheRead,
          durationMs: Date.now() - t0,
          costUsdOverride: orCost != null ? orCost : null,
          costSource: orCost != null ? 'openrouter' : null,
        });
      }).catch(err => {
        logLlmCall({ ...logMeta, finishReason: `error: ${err.message}`, durationMs: Date.now() - t0 });
      });

      return streamObj;
    },
  },

  // ── OpenAI-compatible endpoints (embeddings + image generation) ────
  embeddings: {
    // meta = { tenantId, callSite, sessionId?, productLine?, timeout? }
    // 2026-05-18：补埋点。embedding 没 completion，没 cache，usage 只有
    // prompt_tokens。失败也按 messages.* 的口径写 finish_reason='error:...'，
    // 这样 admin/llm-usage 能看到、能算延迟、能从均值里剔除。
    async create(params, meta = {}) {
      if (!config.openrouter.baseURL || !config.openrouter.apiKey) {
        throw new Error('[llm-client] OPENROUTER_API_KEY required for embeddings');
      }
      const timeoutMs = meta.timeout || 60_000;
      const t0 = Date.now();
      const logMeta = {
        method: 'embeddings',
        provider: 'openrouter',
        models: params.model ? [params.model] : [],
        tenantId: meta.tenantId,
        callSite: meta.callSite,
        sessionId: meta.sessionId,
        productLine: meta.productLine,
      };
      try {
        const response = await fetchWithTimeout(
          `${config.openrouter.baseURL}/embeddings`,
          {
            method: 'POST',
            headers: openrouterHeaders(),
            body: JSON.stringify(withUsageInclude(params)),
          },
          timeoutMs,
        );
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`OpenRouter embeddings error ${response.status}: ${body}`);
        }
        const result = await response.json();
        const orCost = result.usage?.cost;
        logLlmCall({
          ...logMeta,
          responseModel: result.model || params.model,
          finishReason: 'embedding_returned',
          promptTokens: result.usage?.prompt_tokens || 0,
          completionTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          costUsdOverride: orCost != null ? orCost : null,
          costSource: orCost != null ? 'openrouter' : null,
          durationMs: Date.now() - t0,
        });
        return result;
      } catch (err) {
        logLlmCall({
          ...logMeta,
          responseModel: params.model,
          finishReason: `error: ${err.message}`,
          durationMs: Date.now() - t0,
        });
        throw err;
      }
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
      // 2026-05-18：补埋点 + 强制 verbose_json 拿到 duration。
      // Whisper 按音频秒数计费（$0.006/min），caller 不知道音频时长，由
      // OpenAI response.duration 给出。强行覆盖 response_format（caller
      // 用 transcription.text，verbose_json 仍包含 text 字段，向后兼容）。
      // meta = { tenantId, callSite, sessionId?, productLine? }
      async create(params, meta = {}) {
        const t0 = Date.now();
        const logMeta = {
          method: 'transcription',
          provider: 'openai',
          models: [params.model],
          tenantId: meta.tenantId,
          callSite: meta.callSite,
          sessionId: meta.sessionId,
          productLine: meta.productLine,
        };

        const form = new FormData();
        form.append('file', params.file);
        form.append('model', params.model);
        form.append('response_format', 'verbose_json');
        if (params.language) form.append('language', params.language);
        if (params.prompt) form.append('prompt', params.prompt);

        try {
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
          const result = await response.json();
          const audioSeconds = Number(result.duration) || 0;
          logLlmCall({
            ...logMeta,
            responseModel: params.model,
            finishReason: 'transcription_returned',
            promptTokens: 0,
            completionTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            durationMs: Date.now() - t0,
            costUsdOverride: calcWhisperCostUsd({ audioSeconds }),
            // OpenAI 直连,响应里不带 cost。按音频秒数 × $0.006/min 本地公式算。
            // 如果未来 Whisper 涨/降价,需要同步改 calcWhisperCostUsd。
            costSource: 'openai-direct-calc',
          });
          return result;
        } catch (err) {
          logLlmCall({
            ...logMeta,
            responseModel: params.model,
            finishReason: `error: ${err.message}`,
            durationMs: Date.now() - t0,
            costUsdOverride: 0,
            costSource: 'openai-direct-calc',
          });
          throw err;
        }
      },
    },
  },
};

// ── Exports ──────────────────────────────────────────────────────────
export { openrouter, openai, logLlmCall };
