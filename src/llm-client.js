/**
 * LLM Client Abstraction Layer
 *
 * Unified Anthropic-format API that routes to multiple providers:
 *   - Claude models → Anthropic Direct API
 *   - MiniMax models → OpenRouter (OpenAI-compatible, auto-translated)
 *   - Gemini models → OpenRouter (OpenAI-compatible, auto-translated)
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
  GEMINI_FLASH: 'gemini-2.5-flash',
  GPT_MINI: 'gpt-4o-mini',
  EMBEDDING: 'text-embedding-3-small',
  WHISPER: 'whisper-1',
};

function isMiniMaxModel(model) {
  return model?.startsWith('minimax/');
}

function isGeminiModel(model) {
  return !!model?.includes('gemini');
}

// ── Provider Config ──────────────────────────────────────────────────
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const anthropicClient = ANTHROPIC_KEY
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

// ── Logging ──────────────────────────────────────────────────────────
function logLlmCall({ method, provider, model, responseModel, tools, toolChoice, stopReason, inputTokens, outputTokens, durationMs }) {
  const baseUrls = { direct: 'https://api.anthropic.com', openrouter: 'https://openrouter.ai' };
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
      if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter(b => b.type === 'tool_result');
        const otherBlocks = msg.content.filter(b => b.type !== 'tool_result');

        for (const tr of toolResults) {
          result.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
          });
        }
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
    .filter(t => t.name && t.input_schema)
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
  if (!choice) throw new Error('[llm-client] Empty response from provider');

  const content = [];
  if (choice.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input;
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }

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

  const systemMsgs = translateSystemToOpenAI(params.system);
  if (systemMsgs.length > 0) {
    systemMsgs[systemMsgs.length - 1].content += schemaInstruction;
  } else {
    systemMsgs.push({ role: 'system', content: schemaInstruction.trim() });
  }

  return {
    model: params.model,
    max_tokens: params.max_tokens,
    messages: [...systemMsgs, ...translateMessagesToOpenAI(params.messages)],
    response_format: { type: 'json_object' },
  };
}

function wrapJsonResponseAsToolUse(openaiResponse, toolName, model) {
  const choice = openaiResponse.choices?.[0];
  if (!choice?.message?.content) throw new Error('[llm-client] Empty response (forced JSON)');

  let rawJson = choice.message.content;
  const fenceMatch = rawJson.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) rawJson = fenceMatch[1].trim();
  let input;
  try {
    input = JSON.parse(rawJson);
  } catch (parseErr) {
    console.error(`[llm-client] JSON parse failed for forced tool ${toolName}. Error: ${parseErr.message}. Raw (first 800 chars): ${rawJson.slice(0, 800)}`);
    input = { _raw: rawJson, _parse_error: parseErr.message };
  }

  const toolUseId = `toolu_mm_${Date.now().toString(36)}`;

  return {
    id: openaiResponse.id,
    type: 'message',
    role: 'assistant',
    model: openaiResponse.model || model,
    content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
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
    const jsonParams = buildForcedJsonCall(params, forcedToolName);
    const raw = await openrouterClient.chat.completions.create(jsonParams);
    result = wrapJsonResponseAsToolUse(raw, forcedToolName, params.model);
  } else {
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

  logLlmCall({ ...logMeta, responseModel: result.model, stopReason: result.stop_reason, inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens, durationMs: Date.now() - t0 });
  return result;
}

// ── Gemini call handler (OpenRouter only) ────────────────────────────

function isGeminiImageModel(model) {
  return !!model?.match(/gemini.*image/i);
}

function geminiOpenRouterModel(model) {
  return model.startsWith('google/') ? model : 'google/' + model;
}

async function callGemini(params) {
  if (!openrouterClient) {
    throw new Error('[llm-client] OPENROUTER_API_KEY required for Gemini models');
  }

  const t0 = Date.now();
  const model = geminiOpenRouterModel(params.model);
  const logMeta = {
    method: 'create',
    provider: 'openrouter',
    model: params.model,
    tools: params.tools?.length || 0,
    toolChoice: params.tool_choice?.type || null,
  };

  const openaiParams = {
    model,
    max_tokens: params.max_tokens,
    messages: [
      ...translateSystemToOpenAI(params.system),
      ...translateMessagesToOpenAI(params.messages),
    ],
  };

  if (isGeminiImageModel(params.model)) {
    openaiParams.modalities = ['image', 'text'];
  }

  const openaiTools = translateToolsToOpenAI(params.tools);
  if (openaiTools?.length) {
    openaiParams.tools = openaiTools;
    openaiParams.tool_choice = 'auto';
  }

  const raw = await openrouterClient.chat.completions.create(openaiParams);
  const result = translateResponseToAnthropic(raw, params.model);

  logLlmCall({ ...logMeta, responseModel: result.model, stopReason: result.stop_reason, inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens, durationMs: Date.now() - t0 });
  return result;
}

// ══════════════════════════════════════════════════════════════════════
// Unified Proxy (routes by model)
// ══════════════════════════════════════════════════════════════════════

const anthropicProxy = {
  messages: {
    async create(params) {
      // ── Gemini models → OpenRouter with translation ──
      if (isGeminiModel(params.model)) {
        return callGemini(params);
      }

      // ── MiniMax models → OpenRouter with translation ──
      if (isMiniMaxModel(params.model)) {
        return callMiniMax(params);
      }

      // ── Claude models → Anthropic Direct ──
      if (!anthropicClient) {
        throw new Error('[llm-client] ANTHROPIC_API_KEY required for Claude models');
      }

      const t0 = Date.now();
      const logMeta = {
        method: 'create',
        provider: 'direct',
        model: params.model,
        tools: params.tools?.length || 0,
        toolChoice: params.tool_choice?.type || null,
      };

      const result = await anthropicClient.messages.create(params);
      logLlmCall({ ...logMeta, responseModel: result.model, stopReason: result.stop_reason, inputTokens: result.usage?.input_tokens, outputTokens: result.usage?.output_tokens, durationMs: Date.now() - t0 });
      return result;
    },

    stream(params) {
      if (isMiniMaxModel(params.model)) {
        throw new Error(`[llm-client] Streaming not supported for MiniMax models (${params.model}). Use create() instead.`);
      }

      if (!anthropicClient) {
        throw new Error('[llm-client] ANTHROPIC_API_KEY required for Claude streaming');
      }

      const t0 = Date.now();
      const logMeta = {
        method: 'stream',
        provider: 'direct',
        model: params.model,
        tools: params.tools?.length || 0,
        toolChoice: params.tool_choice?.type || null,
      };

      const stream = anthropicClient.messages.stream(params);
      stream.finalMessage().then(msg => {
        logLlmCall({ ...logMeta, responseModel: msg.model, stopReason: msg.stop_reason, inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens, durationMs: Date.now() - t0 });
      }).catch(err => {
        logLlmCall({ ...logMeta, stopReason: `error: ${err.message}`, durationMs: Date.now() - t0 });
      });

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
export { openaiModel, isGeminiModel };
