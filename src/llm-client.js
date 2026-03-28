/**
 * LLM Client Abstraction Layer
 *
 * Unified Anthropic-format API that routes to multiple providers:
 *   - Claude models → MixAI Cloud (primary) / Anthropic Direct (fallback)
 *   - MiniMax models → OpenRouter (OpenAI-compatible, auto-translated)
 *
 * Callers always use Anthropic message format. Translation is internal.
 *
 * Forced tool_choice on MiniMax:
 *   OpenRouter doesn't support forced tool_choice for MiniMax.
 *   The client converts it to JSON-mode output with schema injection,
 *   then wraps the result back into Anthropic tool_use format — transparent to callers.
 *
 * Usage:
 *   import { anthropic, openai, MODELS } from './llm-client.js';
 *   const res = await anthropic.messages.create({ model: MODELS.SONNET, ... });
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

// ── Model Registry ───────────────────────────────────────────────────
export const MODELS = {
  SONNET: 'claude-sonnet-4-6',
  HAIKU: 'claude-haiku-4-5-20251001',
  MINIMAX: 'minimax/minimax-m2.7',
  GPT_MINI: 'gpt-4o-mini',
  EMBEDDING: 'text-embedding-3-small',
  WHISPER: 'whisper-1',
};

function isMiniMaxModel(model) {
  return model?.startsWith('minimax/');
}

// ── Provider Config ──────────────────────────────────────────────────
const MIXAI_KEY = process.env.MIXAI_API_KEY;
const MIXAI_URL = process.env.MIXAI_BASE_URL || 'https://us.mixaicloud.com';

const mixaiClient = MIXAI_KEY
  ? new Anthropic({ apiKey: MIXAI_KEY, baseURL: MIXAI_URL })
  : null;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const anthropicDirect = ANTHROPIC_KEY
  ? new Anthropic({ apiKey: ANTHROPIC_KEY })
  : null;

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const openrouterClient = OPENROUTER_KEY
  ? new OpenAI({
      apiKey: OPENROUTER_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
      timeout: 120_000,
    })
  : null;

// ── Claude Routing ──────────────────────────────────────────────────
function hasDirectOnlyServerTools(params) {
  return params.tools?.some(
    (tool) => typeof tool?.type === 'string' && tool.type.startsWith('web_fetch_'),
  );
}

function needsDirectApi(params) {
  if (hasDirectOnlyServerTools(params)) return true;
  if (params.tool_choice && (params.tool_choice.type === 'tool' || params.tool_choice.type === 'any')) return true;
  if (params.output_config) return true;
  return false;
}

function pickClaudeClient(params) {
  if (needsDirectApi(params)) {
    if (anthropicDirect) return { client: anthropicDirect, provider: 'direct' };
    throw new Error('[llm-client] ANTHROPIC_API_KEY required for web_fetch / forced tool_choice / output_config');
  }
  if (mixaiClient) return { client: mixaiClient, provider: 'mixai' };
  if (anthropicDirect) return { client: anthropicDirect, provider: 'direct' };
  throw new Error('[llm-client] No Claude provider configured (set MIXAI_API_KEY or ANTHROPIC_API_KEY)');
}

// ── Logging ──────────────────────────────────────────────────────────
function logLlmCall({ method, provider, model, responseModel, tools, toolChoice, stopReason, inputTokens, outputTokens, durationMs }) {
  const baseUrls = { mixai: MIXAI_URL, direct: 'https://api.anthropic.com', openrouter: 'https://openrouter.ai' };
  console.log(`[llm-client] ${JSON.stringify({
    method, provider,
    base_url: baseUrls[provider] || provider,
    model,
    response_model: responseModel || model,
    tools: tools || 0,
    tool_choice: toolChoice || null,
    stop_reason: stopReason || null,
    input_tokens: inputTokens || 0,
    output_tokens: outputTokens || 0,
    duration_ms: durationMs,
  })}`);
}

// ══════════════════════════════════════════════════════════════════════
// MiniMax Translation Layer (Anthropic format ↔ OpenAI format)
// ══════════════════════════════════════════════════════════════════════

// ── Anthropic → OpenAI message translation ──────────────────────────

function translateSystemToOpenAI(system) {
  if (!system) return [];
  if (typeof system === 'string') return [{ role: 'system', content: system }];
  // Array of content blocks (with cache_control etc.) → join text
  if (Array.isArray(system)) {
    const text = system.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n\n');
    return [{ role: 'system', content: text }];
  }
  return [{ role: 'system', content: String(system) }];
}

function translateMessagesToOpenAI(messages) {
  const result = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      // Check for tool_result content
      if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter(b => b.type === 'tool_result');
        const otherBlocks = msg.content.filter(b => b.type !== 'tool_result');

        // tool_result → OpenAI tool messages
        for (const tr of toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          });
        }
        // Other content blocks → user message
        if (otherBlocks.length > 0) {
          const parts = otherBlocks.map(b => {
            if (b.type === 'text') return { type: 'text', text: b.text };
            if (b.type === 'image') {
              return {
                type: 'image_url',
                image_url: {
                  url: b.source?.type === 'base64'
                    ? `data:${b.source.media_type};base64,${b.source.data}`
                    : b.source?.url || '',
                },
              };
            }
            return { type: 'text', text: JSON.stringify(b) };
          });
          result.push({ role: 'user', content: parts });
        }
      } else {
        result.push({ role: 'user', content: msg.content });
      }
    } else if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        const toolUses = msg.content.filter(b => b.type === 'tool_use');
        const textBlocks = msg.content.filter(b => b.type === 'text');
        const textContent = textBlocks.map(b => b.text).join('') || null;

        if (toolUses.length > 0) {
          result.push({
            role: 'assistant',
            content: textContent,
            tool_calls: toolUses.map(tu => ({
              id: tu.id,
              type: 'function',
              function: {
                name: tu.name,
                arguments: JSON.stringify(tu.input),
              },
            })),
          });
        } else {
          result.push({ role: 'assistant', content: textContent || '' });
        }
      } else {
        result.push({ role: 'assistant', content: msg.content || '' });
      }
    }
  }
  return result;
}

function translateToolsToOpenAI(tools) {
  if (!tools) return undefined;
  return tools
    .filter(t => t.name && t.input_schema) // Skip native server tools (web_search, etc.)
    .map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema,
      },
    }));
}

// ── OpenAI → Anthropic response translation ─────────────────────────

function translateResponseToAnthropic(openaiResponse, model) {
  const choice = openaiResponse.choices?.[0];
  if (!choice) throw new Error('[llm-client] Empty response from MiniMax');

  const content = [];

  // Text content
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  // Tool calls → tool_use blocks
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input;
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  // Map finish_reason
  const stopReasonMap = {
    stop: 'end_turn',
    tool_calls: 'tool_use',
    length: 'max_tokens',
    content_filter: 'end_turn',
  };

  return {
    id: openaiResponse.id,
    type: 'message',
    role: 'assistant',
    model: openaiResponse.model || model,
    content,
    stop_reason: stopReasonMap[choice.finish_reason] || 'end_turn',
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  };
}

// ── Forced tool_choice → JSON mode conversion ───────────────────────

function buildForcedJsonCall(params, toolName) {
  const tool = params.tools?.find(t => t.name === toolName);
  if (!tool) throw new Error(`[llm-client] Forced tool "${toolName}" not found in tools array`);

  const schema = tool.input_schema;
  const schemaInstruction = `\n\nYou MUST respond with a JSON object matching this schema. Do NOT output anything outside the JSON.\nSchema:\n${JSON.stringify(schema, null, 2)}`;

  // Build OpenAI messages with schema injected into system prompt
  const systemMsgs = translateSystemToOpenAI(params.system);
  if (systemMsgs.length > 0) {
    systemMsgs[systemMsgs.length - 1].content += schemaInstruction;
  } else {
    systemMsgs.push({ role: 'system', content: schemaInstruction.trim() });
  }

  const userMsgs = translateMessagesToOpenAI(params.messages);

  return {
    model: params.model,
    max_tokens: params.max_tokens,
    messages: [...systemMsgs, ...userMsgs],
    response_format: { type: 'json_object' },
    // No tools, no tool_choice — pure JSON output
  };
}

function wrapJsonResponseAsToolUse(openaiResponse, toolName, model) {
  const choice = openaiResponse.choices?.[0];
  if (!choice?.message?.content) throw new Error('[llm-client] Empty response from MiniMax (forced JSON)');

  let rawJson = choice.message.content;
  // Strip markdown code fences if model wrapped JSON in ```json ... ```
  const fenceMatch = rawJson.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) rawJson = fenceMatch[1].trim();
  let input;
  try { input = JSON.parse(rawJson); } catch { input = { _raw: rawJson }; }

  // Generate a tool_use ID matching Anthropic format
  const toolUseId = `toolu_mm_${Date.now().toString(36)}`;

  return {
    id: openaiResponse.id,
    type: 'message',
    role: 'assistant',
    model: openaiResponse.model || model,
    content: [
      { type: 'tool_use', id: toolUseId, name: toolName, input },
    ],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: openaiResponse.usage?.prompt_tokens || 0,
      output_tokens: openaiResponse.usage?.completion_tokens || 0,
    },
  };
}

// ── MiniMax call handler ────────────────────────────────────────────

async function callMiniMax(params) {
  if (!openrouterClient) {
    throw new Error('[llm-client] OPENROUTER_API_KEY required for MiniMax models');
  }

  const t0 = Date.now();
  const isForcedTool = params.tool_choice?.type === 'tool';
  const forcedToolName = isForcedTool ? params.tool_choice.name : null;
  const logMeta = {
    method: 'create',
    provider: 'openrouter',
    model: params.model,
    tools: params.tools?.length || 0,
    toolChoice: isForcedTool ? `forced:${forcedToolName}→json` : (params.tool_choice?.type || null),
  };

  let result;

  if (isForcedTool) {
    // Forced tool_choice → JSON mode with schema injection
    const jsonParams = buildForcedJsonCall(params, forcedToolName);
    const raw = await openrouterClient.chat.completions.create(jsonParams);
    result = wrapJsonResponseAsToolUse(raw, forcedToolName, params.model);
  } else {
    // Auto/none tool_choice → standard OpenAI tool calling
    const openaiParams = {
      model: params.model,
      max_tokens: params.max_tokens,
      messages: [
        ...translateSystemToOpenAI(params.system),
        ...translateMessagesToOpenAI(params.messages),
      ],
    };

    const openaiTools = translateToolsToOpenAI(params.tools);
    if (openaiTools?.length) {
      openaiParams.tools = openaiTools;
      openaiParams.tool_choice = 'auto';
    }

    const raw = await openrouterClient.chat.completions.create(openaiParams);
    result = translateResponseToAnthropic(raw, params.model);
  }

  logLlmCall({
    ...logMeta,
    responseModel: result.model,
    stopReason: result.stop_reason,
    inputTokens: result.usage?.input_tokens,
    outputTokens: result.usage?.output_tokens,
    durationMs: Date.now() - t0,
  });

  return result;
}

// ══════════════════════════════════════════════════════════════════════
// Unified Proxy (routes by model)
// ══════════════════════════════════════════════════════════════════════

const anthropicProxy = {
  messages: {
    async create(params) {
      // ── MiniMax models → OpenRouter with translation ──
      if (isMiniMaxModel(params.model)) {
        return callMiniMax(params);
      }

      // ── Claude models → MixAI / Anthropic Direct ──
      const t0 = Date.now();
      const logMeta = {
        method: 'create',
        model: params.model,
        tools: params.tools?.length || 0,
        toolChoice: params.tool_choice?.type || null,
      };

      const { client, provider } = pickClaudeClient(params);
      try {
        const result = await client.messages.create(params);
        logLlmCall({ ...logMeta, provider, responseModel: result.model, stopReason: result.stop_reason, inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens, durationMs: Date.now() - t0 });
        return result;
      } catch (err) {
        if (provider === 'mixai' && anthropicDirect && !process.env.LLM_NO_FALLBACK) {
          console.warn(`[llm-client] MixAI failed, falling back to Anthropic direct:`, err.message);
          emitLlmEvent({ type: 'fallback', from: 'mixai', to: 'direct', model: params.model, error: err.message });
          const result = await anthropicDirect.messages.create(params);
          logLlmCall({ ...logMeta, provider: 'direct', responseModel: result.model, stopReason: result.stop_reason, inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens, durationMs: Date.now() - t0 });
          return result;
        }
        emitLlmEvent({ type: 'error', provider, model: params.model, error: err.message });
        throw err;
      }
    },

    stream(params) {
      // MiniMax streaming not supported — fall through to Claude
      if (isMiniMaxModel(params.model)) {
        throw new Error(`[llm-client] Streaming not supported for MiniMax models (${params.model}). Use create() instead.`);
      }

      const t0 = Date.now();
      const { client, provider } = pickClaudeClient(params);
      const logMeta = {
        method: 'stream',
        model: params.model,
        tools: params.tools?.length || 0,
        toolChoice: params.tool_choice?.type || null,
        provider,
      };

      // Wrap stream with fallback: if MixAI stream fails and direct is available, retry
      const stream = client.messages.stream(params);
      stream.finalMessage().then(msg => {
        logLlmCall({
          ...logMeta,
          responseModel: msg.model,
          stopReason: msg.stop_reason,
          inputTokens: msg.usage?.input_tokens,
          outputTokens: msg.usage?.output_tokens,
          durationMs: Date.now() - t0,
        });
      }).catch(err => {
        logLlmCall({ ...logMeta, stopReason: `error: ${err.message}`, durationMs: Date.now() - t0 });
      });

      // If primary is mixai, attach a fallback wrapper
      if (provider === 'mixai' && anthropicDirect && !process.env.LLM_NO_FALLBACK) {
        const originalOn = stream.on.bind(stream);
        let hasError = false;
        originalOn('error', () => { hasError = true; });
        // Expose a retry helper the caller can use
        stream._fallbackStream = () => {
          console.warn('[llm-client] Stream fallback: MixAI → Anthropic direct');
          return anthropicDirect.messages.stream(params);
        };
      }

      return stream;
    },
  },
};

// ── OpenAI Client (embeddings, GPT, product parsing) ─────────────────
const USE_OPENROUTER = !process.env.OPENAI_API_KEY && !!process.env.OPENROUTER_API_KEY;

function openaiModel(model) {
  if (!USE_OPENROUTER) return model;
  const PREFIX = {
    [MODELS.GPT_MINI]: 'openai/gpt-4o-mini',
    [MODELS.EMBEDDING]: 'openai/text-embedding-3-small',
  };
  return PREFIX[model] || model;
}

const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY;
const openaiClient = OPENAI_KEY
  ? new OpenAI({
      apiKey: OPENAI_KEY,
      baseURL: USE_OPENROUTER
        ? (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api') + '/v1'
        : undefined,
      timeout: 60000,
    })
  : null;

// ── Event listeners ─────────────────────────────────────────────────
const _listeners = [];
export function onLlmEvent(fn) {
  _listeners.push(fn);
  return () => { const i = _listeners.indexOf(fn); if (i >= 0) _listeners.splice(i, 1); };
}
function emitLlmEvent(event) {
  for (const fn of _listeners) { try { fn(event); } catch {} }
}

// ── Exports ──────────────────────────────────────────────────────────
export const anthropic = anthropicProxy;
export const openai = openaiClient;
export { openaiModel };
