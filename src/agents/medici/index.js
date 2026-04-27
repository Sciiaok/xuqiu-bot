/**
 * Medici — the conversation agent that replies to B2B customers and qualifies
 * their inquiries into structured leads.
 *
 * Named after the Medici family: Florentine bankers who conducted business and
 * diplomacy through the same conversation. Each turn the agent simultaneously
 * replies, classifies intent/quality/value, extracts leads, and routes —
 * banking-and-diplomacy in one.
 *
 * Public API: `runMedici({ history, input, context, agentConfig, trace })`.
 * Contract and pipeline diagram live in types.md.
 */

import { openrouter, MODELS } from '../../llm-client.js';
import { createTraceLogger } from '../../../lib/core-trace.js';
import supabase from '../../../lib/supabase.js';
import {
  downloadWhatsAppMediaBuffer,
  isClaudeSupportedImageMimeType,
} from '../../whatsapp-media.service.js';
import { buildKbTools, executeKbTool } from './kb-tools.js';
import {
  GENERIC_LEAD_OUTPUT_SCHEMA,
  hasCustomOutputSchema,
  resolveOutputSchema,
} from './output-schema.js';

// ─── Constants ───────────────────────────────────────────────────────

const MAX_TOKENS = 4096;
const MAX_TOOL_ITERATIONS = 5;
const FORCE_SUBMIT_PROMPT =
  'Please call submit_response with your structured response now.';

// Fields that correspond to actual columns on the `leads` table. Anything a
// product_line's custom lead_fields introduces beyond this set gets preserved
// in the `details` JSONB column so DB inserts don't fail.
const STANDARD_DB_FIELDS = new Set([
  'brand', 'car_model', 'destination_country', 'destination_port',
  'loading_port', 'international_commercial_term', 'company_name',
  'timeline', 'color_quantity', 'qty_bucket', 'product_name',
  'sku_description', 'buyer_type', 'details',
]);

// ─── Prompt assembly ─────────────────────────────────────────────────

/** @throws if agentConfig lacks a non-empty system_prompt. */
export function resolveSystemPrompt(agentConfig) {
  const prompt = agentConfig?.system_prompt;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error(
      'medici: agentConfig.system_prompt is required. ' +
      'Unbound product_lines must be filtered upstream (Strategy C in queue-processor); ' +
      'replay scripts must load the per-conversation product_line config before calling.',
    );
  }
  return prompt;
}

export function buildPriorStateLines(priorState) {
  if (!priorState) return [];
  const lines = [
    `Prior classification: intent=${priorState.conversation_intent}, quality=${priorState.inquiry_quality}, value=${priorState.business_value}`,
  ];
  const collected = [
    priorState.car_model && `product=${priorState.car_model}`,
    priorState.qty_bucket && `qty=${priorState.qty_bucket}`,
    priorState.destination_country && `destination=${priorState.destination_country}`,
    priorState.company_name && `company=${priorState.company_name}`,
  ].filter(Boolean);
  if (collected.length > 0) lines.push(`Collected so far: ${collected.join(', ')}`);
  lines.push(
    'IMPORTANT: Do NOT downgrade intent or quality unless the customer EXPLICITLY contradicts prior business signals (e.g. "actually I only need 1 for personal use"). Job titles like "self employed", "mechanic", etc. are NOT contradictions.',
  );
  return lines;
}

/**
 * Render the AVAILABLE ASSETS block. Empty list → returns '' so the section
 * doesn't appear at all (avoid teaching the model about a feature it can't use).
 */
function renderAvailableAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0) return '';
  const lines = assets.map((a) => {
    const desc = a.description ? a.description.replace(/\s+/g, ' ').trim() : '(no description)';
    return `- asset_id=${a.id}  ${desc}`;
  });
  return `\n\nAVAILABLE ASSETS (images you may attach to a reply):
${lines.join('\n')}

ATTACHMENT RULES:
- Default: do NOT attach any image. Leave \`attachments\` as [].
- ONLY attach when the customer explicitly asks for an image / photo / 图 / 图片 / 看一下实物 / picture (or similar visual request).
- Pick the asset_id whose description best matches what they asked for. If none fits, say so politely and don't attach.
- The image arrives as a separate WhatsApp message right after your text reply, so it's fine to write next_message like "Sending you the photo:" and let the image follow.`;
}

export function buildDynamicContext(contextInfo = {}) {
  const missingFieldsText =
    contextInfo.missing_fields?.length > 0
      ? `Missing fields to collect: ${contextInfo.missing_fields.join(', ')}`
      : 'No specific fields required';
  const priorStateLines = buildPriorStateLines(contextInfo.prior_state);
  const carRecommendation = contextInfo.car_recommendation || '';
  const adReferral = contextInfo.ad_referral || '';

  const adReferralBlock = adReferral
    ? `\n\nAd the customer clicked to start this conversation:\n${adReferral}`
    : '';
  const assetsBlock = renderAvailableAssets(contextInfo.available_assets);

  return `CURRENT CONTEXT:
- ${missingFieldsText}${priorStateLines.length > 0 ? '\n- ' + priorStateLines.join('\n- ') : ''}${carRecommendation ? '\n- ' + carRecommendation : ''}${adReferralBlock}${assetsBlock}`;
}

/**
 * Two blocks:
 *   [0] static per-product-line prompt  (cache_control: ephemeral → cached)
 *   [1] dynamic per-request context      (not cached)
 */
export function buildSystemBlocks(systemPrompt, dynamicContext) {
  return [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicContext },
  ];
}

// ─── Messages (multimodal) ───────────────────────────────────────────

/**
 * Stored message → Anthropic content.
 * Returns a plain string for text-only, array of blocks for multimodal, '' for empty.
 */
async function buildClaudeContent(message, logger, metaToken = null) {
  const text = typeof message?.content === 'string' ? message.content.trim() : '';
  const metadata = message?.metadata || {};
  const blocks = [];

  if (text) blocks.push({ type: 'text', text });

  if (
    message?.role === 'user' &&
    metadata.media_type === 'image' &&
    metadata.wa_media_id
  ) {
    if (!metaToken) {
      logger.warn('medici.image_attachment.skip_no_token', { wa_media_id: metadata.wa_media_id });
      return blocks.length === 1 && blocks[0].type === 'text' ? blocks[0].text : blocks;
    }
    try {
      const { buffer, mimeType } = await downloadWhatsAppMediaBuffer(metadata.wa_media_id, { token: metaToken });
      if (buffer.length > 0 && isClaudeSupportedImageMimeType(mimeType)) {
        blocks.push({
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}` },
        });
      }
    } catch (error) {
      logger.warn('medici.image_attachment.failed', {
        wa_media_id: metadata.wa_media_id,
        error: error.message,
      });
    }
  }

  // Inline image path — used by the Medici simulator and any caller that
  // already has the bytes in hand and shouldn't go through the WhatsApp
  // media download. Accepts either a full data URL or {data_url, mime_type}.
  if (message?.role === 'user' && metadata.inline_image) {
    const { data_url, mime_type } = metadata.inline_image;
    if (typeof data_url === 'string' && data_url.startsWith('data:')) {
      const detectedMime = mime_type || data_url.slice(5, data_url.indexOf(';'));
      if (isClaudeSupportedImageMimeType(detectedMime)) {
        blocks.push({ type: 'image_url', image_url: { url: data_url } });
      } else {
        logger.warn('medici.inline_image.unsupported_mime', { mime_type: detectedMime });
      }
    }
  }

  if (blocks.length === 0) return '';
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text;
  return blocks;
}

/**
 * Latest user input can be: plain string / single message object / array of
 * aggregated messages. Flatten into one Anthropic content value.
 */
async function normalizeLatestUserMessage(input, logger, metaToken = null) {
  if (typeof input === 'string') return input;

  const items = Array.isArray(input) ? input : [input];
  const blocks = [];

  for (const item of items) {
    const content = await buildClaudeContent({ role: 'user', ...item }, logger, metaToken);
    if (typeof content === 'string') {
      if (content.trim()) blocks.push({ type: 'text', text: content });
      continue;
    }
    blocks.push(...content);
  }

  if (blocks.length === 0) return '';
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text;
  return blocks;
}

function isNonEmptyMessage(message) {
  if (typeof message.content === 'string') return message.content.trim() !== '';
  return Array.isArray(message.content) && message.content.length > 0;
}

/** Mark the last history entry with cache_control (mutates). */
function markHistoryForCache(history) {
  if (history.length === 0) return;
  const last = history[history.length - 1];
  if (typeof last.content === 'string') {
    last.content = [
      { type: 'text', text: last.content, cache_control: { type: 'ephemeral' } },
    ];
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
  }
}

async function buildMessages(conversationHistory, latestUserMessage, logger, metaToken = null) {
  const historyMessages = Array.isArray(conversationHistory) ? conversationHistory : [];

  const sanitizedHistory = await Promise.all(
    historyMessages.map(async (msg) => ({
      role: msg.role,
      content: await buildClaudeContent(msg, logger, metaToken),
    })),
  );
  const latestUserContent = await normalizeLatestUserMessage(latestUserMessage, logger, metaToken);

  const messages = [
    ...sanitizedHistory,
    { role: 'user', content: latestUserContent },
  ].filter(isNonEmptyMessage);

  // Apply cache_control after filtering — matches prior behavior where empty
  // trailing history messages are pruned before being marked.
  markHistoryForCache(sanitizedHistory);

  return { messages, historyCount: sanitizedHistory.length, latestContent: latestUserContent };
}

// ─── Tools ───────────────────────────────────────────────────────────

/**
 * KB 表 2026-04-28 加了 product_line_id 列后所有 KB 工具直接按
 * (tenant_id, product_line_id) 查询，不再需要 agents.id UUID 这条桥。
 */
async function loadAgentTools({ tenantId, productLineId }, logger) {
  if (!tenantId || !productLineId) return [];
  try {
    return await buildKbTools({ tenantId, productLineId });
  } catch (e) {
    logger.warn('medici.kb_tools.failed', { error: e.message });
    return [];
  }
}

/**
 * Load sendable image assets for the product line. Returned as a plain list
 * that buildDynamicContext renders into the AVAILABLE ASSETS block; the LLM
 * references them by id via the `attachments` envelope field. Failures
 * downgrade to an empty list — Medici keeps replying without images.
 */
async function loadAvailableAssets({ tenantId, productLineId }, logger) {
  if (!tenantId || !productLineId) return [];
  try {
    const { data, error } = await supabase
      .from('kb_assets')
      .select('id, description, mime_type, asset_type')
      .eq('tenant_id', tenantId)
      .eq('product_line_id', productLineId)
      .eq('is_sendable', true);
    if (error) throw error;
    return data || [];
  } catch (e) {
    logger.warn('medici.assets.failed', { error: e.message });
    return [];
  }
}

/**
 * Every turn MUST end with this tool call — plain assistant text is discarded.
 * Callers always see schema-validated JSON (= tool args).
 */
function buildSubmitResponseTool(outputSchema) {
  return {
    name: 'submit_response',
    description:
      'Submit your final response. This is the ONLY way to reply to the customer — every turn must end with a submit_response tool call. Do NOT reply with plain assistant text; plain text will be discarded. If you do not need to call any other tool, call submit_response immediately as your single tool call for the turn.',
    input_schema: outputSchema,
    cache_control: { type: 'ephemeral' },
  };
}

function markLastToolForCache(tools) {
  if (tools.length === 0) return tools;
  return tools.map((tool, i) =>
    i === tools.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : tool,
  );
}

// ─── LLM transport (OpenRouter → Anthropic) ──────────────────────────

function callClaude({ systemBlocks, messages, tools, toolChoice }) {
  // OpenRouter expects a single 'system' message, not Anthropic's block array.
  const systemContent = Array.isArray(systemBlocks)
    ? systemBlocks.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n\n')
    : typeof systemBlocks === 'string'
      ? systemBlocks
      : String(systemBlocks || '');

  const payload = {
    models: [MODELS.SONNET],
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'system', content: systemContent }, ...messages],
    tools: tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema },
    })),
  };
  if (toolChoice?.type === 'auto') {
    payload.tool_choice = 'auto';
  } else if (toolChoice?.type === 'tool') {
    payload.tool_choice = { type: 'function', function: { name: toolChoice.name } };
  } else if (toolChoice) {
    payload.tool_choice = toolChoice;
  }
  return openrouter.messages.create(payload);
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// ─── Post-process ────────────────────────────────────────────────────

function cleanEmptyValues(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === '' || value === null || value === undefined) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Schema requires every field to appear, so Claude emits '' for unknowns.
 * We strip those before storage.
 */
export function stripEmptyStringFields(obj) {
  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === '') continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Normalize non-standard agent responses to canonical leads[].
 *
 * 把任何非 STANDARD_DB_FIELDS 的字段移进 details JSONB —— 这是 product_line
 * 自定义 lead_fields 落库的兜底。少了这个，custom 字段会让 DB insert 失败。
 *
 * 老的 rfq_items / root-level customer_profile 分支已经下掉（product_lines
 * 重构后 output_schema 都是按 lead_fields 自动拼的，不再产出那种形状）。
 */
export function normalizeAgentResponse(parsed) {
  // Move non-canonical fields into details JSONB. Also applies a couple of
  // hardcoded aliases for legacy agents (car_brand/part_name/quantity).
  if (parsed.leads) {
    parsed.leads = parsed.leads.map((lead) => {
      const hasExtraFields = Object.keys(lead).some((k) => !STANDARD_DB_FIELDS.has(k));
      if (!hasExtraFields) return lead;

      const mapped = { ...lead };
      if (lead.car_brand && !lead.brand) mapped.brand = lead.car_brand;
      if (lead.part_name && !lead.product_name) mapped.product_name = lead.part_name;
      if (lead.quantity && !lead.qty_bucket) mapped.qty_bucket = lead.quantity;

      const allFields = cleanEmptyValues(lead);
      delete allFields.details;
      mapped.details = { ...(lead.details || {}), ...allFields };
      return mapped;
    });
  }
}

// ─── Orchestrator (public entry) ─────────────────────────────────────

function buildTraceContextInfo(contextInfo = {}) {
  const entries = Object.entries(contextInfo || {}).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return {};
  return Object.fromEntries(
    entries.map(([k, v]) => (Array.isArray(v) ? [k, v.slice(0, 20)] : [k, v])),
  );
}

/**
 * Flatten a history entry / user input to plain text. Used for the KB query
 * rewrite context — multimodal turns contribute their text parts only.
 */
function extractPlainText(value) {
  if (typeof value === 'string') return value;
  if (value?.content) return extractPlainText(value.content);
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === 'string' ? item : item?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Build the conversation context forwarded to search_knowledge for multi-turn
 * query rewriting. Only user/assistant turns (LLM-internal tool traffic is
 * excluded), plain text only, tail-capped to keep the rewrite prompt cheap.
 */
function buildConversationContextForKb(history, input) {
  const turns = [];
  for (const m of Array.isArray(history) ? history : []) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const text = extractPlainText(m.content);
    if (text) turns.push({ role: m.role, content: text });
  }
  // Fold the latest user input into the context so "price?" resolves against
  // both prior turns AND the current question when Claude rewrites a follow-up
  // tool query.
  const latest = extractPlainText(input);
  if (latest) turns.push({ role: 'user', content: latest });
  return turns.slice(-8);
}

/**
 * Run one turn of the Medici conversation agent.
 *
 * @param {object}   opts
 * @param {Array}    opts.history      Prior {role, content, metadata} turns.
 * @param {string|object|Array} opts.input  Latest user input (plain text,
 *                                          single message, or aggregated batch).
 * @param {object}   [opts.context]    { missing_fields, prior_state,
 *                                       car_recommendation, ad_referral }
 * @param {object}   opts.agentConfig  Resolved product_line config.
 *                                     REQUIRED: system_prompt.
 *                                     Optional: output_schema, id.
 * @param {object}   [opts.trace]      { traceId, conversationId, waId }
 * @param {(event: {type:'tool_call'|'tool_result', tool:string, input?:object, result?:string, iteration:number}) => void}
 *               [opts.onToolEvent]    Observability hook — fires before each
 *                                     tool call and after each result. Used
 *                                     by the chat simulator to render a tool
 *                                     timeline; in production leave unset.
 * @returns {Promise<object>}          Parsed structured response — see types.md.
 */
export async function runMedici({
  history,
  input,
  context = {},
  agentConfig,
  metaToken = null,
  trace = {},
  onToolEvent,
}) {
  const logger = createTraceLogger({
    component: 'medici',
    trace_id: trace.traceId,
    conversation_id: trace.conversationId,
    wa_id: trace.waId,
  });

  // 1. messages[] (history + latest, cache_control on trailing history turn).
  const { messages, historyCount, latestContent } = await buildMessages(history, input, logger, metaToken);

  // 2. Resolve system prompt (REQUIRED) + output schema.
  const systemPrompt = resolveSystemPrompt(agentConfig);
  const outputSchema = resolveOutputSchema(agentConfig);

  // 3. Assemble tools + load sendable assets in parallel. Assets are injected
  //    into the dynamic context so the LLM can reference them by id via the
  //    `attachments` envelope field (no extra tool round needed).
  const tenantId = agentConfig?.tenant_id || null;
  const productLineId = agentConfig?.product_line || null;
  const [agentTools, availableAssets] = await Promise.all([
    loadAgentTools({ tenantId, productLineId }, logger),
    loadAvailableAssets({ tenantId, productLineId }, logger),
  ]);
  const tools = [...markLastToolForCache(agentTools), buildSubmitResponseTool(outputSchema)];

  const enrichedContext = { ...context, available_assets: availableAssets };
  const systemBlocks = buildSystemBlocks(systemPrompt, buildDynamicContext(enrichedContext));

  logger.info('medici.request.started', {
    message_count: messages.length,
    history_count: historyCount,
    latest_input_type: Array.isArray(latestContent) ? 'multimodal' : 'text',
    model: MODELS.SONNET,
    context_info: buildTraceContextInfo(enrichedContext),
    available_assets_count: availableAssets.length,
  });
  const conversationContext = buildConversationContextForKb(history, input);

  // 4. Tool-use loop. Same-round tool_calls run in parallel (Ogilvy pattern);
  //    submit_response among them short-circuits as the final answer. Every
  //    turn ultimately ends with submit_response — if the model won't emit it,
  //    we pin one final forced turn after the loop.
  let parsed = null;
  let response = await callClaude({ systemBlocks, messages, tools, toolChoice: { type: 'auto' } });
  let iterations = 0;

  while (
    iterations < MAX_TOOL_ITERATIONS &&
    response.choices[0].finish_reason === 'tool_calls'
  ) {
    iterations++;
    const msg = response.choices[0].message;
    const toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0) break;

    const submit = toolCalls.find((tc) => tc.function.name === 'submit_response');
    if (submit) {
      logger.info('medici.tool_use.submit_response', { iterations });
      parsed = safeParseJson(submit.function.arguments);
      break;
    }

    const settled = await Promise.all(toolCalls.map(async (tc) => {
      const toolName = tc.function.name;
      const toolInput = safeParseJson(tc.function.arguments);
      onToolEvent?.({ type: 'tool_call', tool: toolName, input: toolInput, iteration: iterations });
      logger.info('medici.tool_use.call', { tool: toolName, iteration: iterations });
      // All non-submit tools currently go through executeKbTool; unknown
      // tool names return a structured {error} result (safe fallback).
      const result = await executeKbTool(toolName, toolInput, {
        tenantId,
        productLineId,
        conversationContext,
      });
      onToolEvent?.({ type: 'tool_result', tool: toolName, result, iteration: iterations });
      return { tc, result };
    }));

    // Append the single assistant turn (carrying all tool_calls), then each
    // tool_result in call order — providers validate that each tool_call has
    // a matching tool message before the next turn.
    messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });
    for (const { tc, result } of settled) {
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    response = await callClaude({ systemBlocks, messages, tools });
  }

  // 5. Force-submit fallback: loop exited without submit_response (hit
  //    MAX_TOOL_ITERATIONS, or model stopped with plain text). Pin the final
  //    turn with tool_choice=submit_response.
  if (!parsed) {
    logger.warn('medici.tool_use.force_submit', {
      stop_reason: response.choices[0].finish_reason,
      iterations,
    });
    const prevMsg = response.choices[0].message;
    messages.push({ role: 'assistant', content: prevMsg.content, tool_calls: prevMsg.tool_calls });
    // Previous tool_calls need matching tool_results before the user turn,
    // otherwise the provider rejects the message list.
    for (const tc of prevMsg.tool_calls || []) {
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify({ skipped: 'Force submit' }),
      });
    }
    messages.push({ role: 'user', content: FORCE_SUBMIT_PROMPT });
    response = await callClaude({
      systemBlocks,
      messages,
      tools,
      toolChoice: { type: 'tool', name: 'submit_response' },
    });
    const submitTool = (response.choices[0].message.tool_calls || []).find(
      (tc) => tc.function.name === 'submit_response',
    );
    if (!submitTool) {
      throw new Error('medici: Claude did not produce a response after forced submit_response');
    }
    logger.info('medici.tool_use.submit_response', { iterations, forced: true });
    parsed = safeParseJson(submitTool.function.arguments);
  }

  // 6. Normalize legacy output shapes + strip empty-string fields.
  if (hasCustomOutputSchema(agentConfig)) normalizeAgentResponse(parsed);
  if (parsed.leads) parsed.leads = parsed.leads.map(stripEmptyStringFields);

  logger.info('medici.request.completed', {
    intent: parsed.conversation_intent,
    inquiry_quality: parsed.inquiry_quality,
    business_value: parsed.business_value,
    route: parsed.route,
    leads_count: (parsed.leads || []).length,
  });

  return parsed;
}

export default runMedici;
export { GENERIC_LEAD_OUTPUT_SCHEMA };
