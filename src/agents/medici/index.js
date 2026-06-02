/**
 * Medici — the conversation agent that replies to B2B customers and qualifies
 * their inquiries into structured leads.
 *
 * Named after the Medici family: Florentine bankers who conducted business and
 * diplomacy through the same conversation. Each turn the agent simultaneously
 * replies, classifies intent/quality/value, extracts leads, and routes —
 * banking-and-diplomacy in one.
 *
 * 2026-05 重构：agent prompt 来源切换为 ai-reception-deal skill
 * (`skills/ai-reception-deal/`)，方法论由 skill 主导。LeadEngine 宿主收口
 * （submit_response envelope、阶段→inquiry_quality/route 映射、转人工与
 * 风格规则）写在 skill-host-patch.md 里追加到 skill 之后。skill 内容可直接
 * 编辑文件热替换，宿主代码改动只在 dynamic context 拼装、tools 列表、
 * dispatcher 三处。
 *
 * Public API: `runMedici({ history, input, context, agentConfig, trace })`.
 * Contract and pipeline diagram live in medici-design.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openrouter, MODELS } from '../../llm-client.js';
import { createTraceLogger } from '../../../lib/core-trace.js';
import supabase from '../../../lib/supabase.js';
import {
  downloadWhatsAppMediaBuffer,
  isClaudeSupportedImageMimeType,
} from '../../whatsapp-media.service.js';
import { loadSkill } from '../skills-runtime/index.js';
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

// 顶层保留的字段集 —— 系统字段 + 评分类元数据。
// 其他字段（业务字段、产品线自定义 lead_fields）全部进 details JSONB。
const TOP_LEVEL_RETAIN = new Set([
  'id', 'conversation_id', 'contact_id', 'tenant_id',
  'product_line', 'meta_ad_id',
  'created_at', 'updated_at',
  'inquiry_quality', 'business_value', 'conversation_intent',
  'conversation_intent_summary', 'route', 'handoff_summary',
]);

// ─── Host patch (loaded once at module scope, never changes) ─────────
//
// Skill bundle itself is loaded per-invocation inside runMedici so admin UI
// version switches take effect on the next conversation without a process
// restart.
const HOST_PATCH = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'skill-host-patch.md'),
  'utf8',
);

// ─── Prompt assembly ─────────────────────────────────────────────────

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

function formatList(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return '(none configured)';
  return keys.join(', ');
}

/**
 * Render the AVAILABLE ASSETS block. Empty list → returns '' so the section
 * doesn't appear at all (avoid teaching the model about a feature it can't use).
 */
function renderAvailableAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0) return '';
  const lines = assets.map((a) => {
    const desc = a.description ? a.description.replace(/\s+/g, ' ').trim() : '(no description)';
    const skus = Array.isArray(a.linked_skus) && a.linked_skus.length > 0
      ? `  [SKUs: ${a.linked_skus.join(', ')}]`
      : '';
    return `- asset_id=${a.id}${skus}  ${desc}`;
  });
  return `\n## AVAILABLE ASSETS (images you may attach to a reply)
${lines.join('\n')}

ATTACHMENT RULES:
- Default: do NOT attach any image. Leave \`attachments\` as [].
- ONLY attach when the customer explicitly asks for an image / photo / 图 / 图片 / 看一下实物 / picture (or similar visual request).
- Match priority: 1) If the customer named a specific SKU/model, pick the asset whose [SKUs: ...] tag contains it. 2) Otherwise pick by description fit. If none fits, say so politely and don't attach.
- The image arrives as a separate WhatsApp message right after your text reply, so it's fine to write next_message like "Sending you the photo:" and let the image follow.`;
}

/**
 * Per-product-line context — stable across all conversations for one line.
 * Lives in a cacheable block so Anthropic's prompt cache absorbs catalogue
 * + business-value guidance + the AVAILABLE ASSETS list (which can balloon
 * to 30+ image descriptions) instead of repaying full-price tokens each turn.
 */
export function buildPerLineContext({ injection, available_assets } = {}) {
  const inj = injection || {};
  const assetsBlock = renderAvailableAssets(available_assets);

  return `# DYNAMIC CONTEXT (per product line)

## PRODUCT LINE: ${inj.line_name || '(unset)'}

## LEAD FIELDS (for this product line)

${inj.lead_fields_hints || '(none configured)'}

Required-field tiers (used to decide inquiry_quality):
- GOOD basic intent clear — needs: ${formatList(inj.good_fields)}
- QUALIFY further details complete — needs: ${formatList(inj.qualify_fields)}
- PROOF customer verified and ready — needs: ${formatList(inj.proof_fields)}

## BUSINESS VALUE GUIDANCE

${inj.business_value_guidance || '(no guidance configured)'}${assetsBlock}`;
}

/**
 * Render the ATTACHMENTS ALREADY SENT block. Per-turn (not cached) because
 * the list grows with the conversation. Empty → '' so the section disappears.
 */
function renderSentAssets(sentIds, availableAssets) {
  if (!Array.isArray(sentIds) || sentIds.length === 0) return '';
  const desc = new Map(
    (availableAssets || []).map((a) => [
      a.id,
      (a.description || '').replace(/\s+/g, ' ').trim() || '(no description)',
    ]),
  );
  const lines = sentIds.map(
    (id) => `- asset_id=${id}  ${desc.get(id) || '(asset no longer in available list)'}`,
  );
  return `\n\n## ATTACHMENTS ALREADY SENT (this conversation)
${lines.join('\n')}`;
}

/**
 * Per-turn / per-conversation state — varies each Medici call. Kept out of
 * the cached block so we don't bust the per-line cache on every reply.
 */
export function buildPerTurnContext({
  missing_fields,
  prior_state,
  ad_referral,
  sent_assets,
  available_assets,
} = {}) {
  const missing = Array.isArray(missing_fields) && missing_fields.length > 0
    ? missing_fields.join(', ')
    : '(none)';
  const priorLines = buildPriorStateLines(prior_state);
  const priorBlock = priorLines.length > 0
    ? priorLines.map((l) => `- ${l}`).join('\n')
    : '- (no prior state — first turn)';

  const adBlock = ad_referral
    ? `\n\n## Ad the customer clicked to start this conversation\n${ad_referral}`
    : '';
  const sentAssetsBlock = renderSentAssets(sent_assets, available_assets);

  return `## CURRENT MISSING FIELDS

${missing}

## PRIOR STATE

${priorBlock}${adBlock}${sentAssetsBlock}`;
}

/**
 * Extract assets that the assistant already sent on prior turns. send-attachments
 * persists asset_id in message metadata; we just walk history. De-duplicated,
 * preserving first-send order.
 */
export function extractSentAssetIds(history) {
  const seen = new Set();
  const out = [];
  for (const m of Array.isArray(history) ? history : []) {
    const id = m?.metadata?.kb_asset_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Legacy single-block helper, kept so external callers / tests that already
 * consumed buildDynamicContext still get an equivalent string.
 */
export function buildDynamicContext(opts = {}) {
  return `${buildPerLineContext(opts)}

${buildPerTurnContext(opts)}`;
}

/**
 * Three blocks for Anthropic prompt caching:
 *   [0] static skill body + host patch  (cache_control: ephemeral)
 *   [1] per-product-line context        (cache_control: ephemeral)
 *   [2] per-turn / per-conversation state (not cached — varies)
 *
 * Two cache breakpoints means the per-line block (incl. AVAILABLE ASSETS)
 * survives across every turn of every conversation for that product_line,
 * not just within a single conversation.
 */
export function buildSystemBlocks(staticPrompt, perLine, perTurn) {
  return [
    { type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: perLine, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: perTurn },
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

/**
 * 在 tool-use 循环的第 2+ 次迭代前调用：把"最后一条 cache_control 在 messages
 * 里"的标记从 history-tail 滚动到刚追加的最后一条 tool message。
 *
 * 为什么这么做：Anthropic 单次请求最多 4 个 cache_control 断点。Medici 固定用掉
 * 了 3 个（skill / per-line / 最后一个 tool 定义），第 4 个原本钉在 history-tail
 * 给跨回合复用。但在同一个回合内 tool 循环展开后,前轮的 asst tool_call +
 * tool_result 全是 fresh token——下一次 LLM call 又重算一遍。把第 4 个断点
 * 推到 last tool result 上,下一次迭代读 cache 时能覆盖到本轮已有的 tool 交换,
 * 平均省 5-15K input tokens / 迭代。
 *
 * 副作用：history-tail 的 marker 被清掉,下一次跨回合调用不再能直接命中
 * history 的缓存(但本回合内 system + tools 缓存仍然有效)。在多轮 tool 调用
 * 的对话里(医ici 的典型场景),这笔交换是赚的。
 */
function rollCacheBreakpointToLastToolMessage(messages) {
  // 先清掉 messages 里所有 cache_control（history-tail marker 必须清,否则
  // 加上新 marker 后总数会变成 5,超过 Anthropic 上限）。system 块和 tools
  // 数组上的 marker 不在 messages 里,不受影响。
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && typeof block === 'object' && block.cache_control) {
        delete block.cache_control;
      }
    }
  }
  // 在最后一条 role='tool' 的消息内容末尾打 marker。OpenRouter 把 OpenAI
  // 格式的 tool 消息转换成 Anthropic 的 tool_result block,cache_control 透传。
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'tool') continue;
    if (typeof msg.content === 'string') {
      msg.content = [
        { type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } },
      ];
    } else if (Array.isArray(msg.content) && msg.content.length > 0) {
      msg.content[msg.content.length - 1].cache_control = { type: 'ephemeral' };
    }
    return;
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
 *
 * 不做 cap：每张 asset 在 prompt 里 30-60 tokens，进的是 per-line cache
 * （system[1]，ephemeral cache_control）—— 一次 cache write、N 次 cache read
 * 摊销下来单会话 < 1 美分。如果未来某个产品线把 sendable 资产堆到几千张
 * 让 cache 段过大，再回来考虑按"linked_skus 覆盖度 + recency"排序的 cap，
 * 而不是粗糙的 newest-N。
 */
async function loadAvailableAssets({ tenantId, productLineId }, logger) {
  if (!tenantId || !productLineId) return [];
  try {
    const { data, error } = await supabase
      .from('kb_assets')
      .select('id, description, mime_type, asset_type, linked_skus')
      .eq('tenant_id', tenantId)
      .eq('product_line_id', productLineId)
      .eq('is_sendable', true)
      .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (e) {
    logger.warn('medici.assets.failed', { error: e.message });
    return [];
  }
}

/**
 * Lazy-load a skill reference. Keeping references out of the static prompt
 * saves ~10K tokens per turn; the agent pulls only what it needs.
 */
const READ_SKILL_REFERENCE_TOOL = {
  name: 'read_skill_reference',
  description:
    '按需读取 ai-reception-deal skill 的 references/*.md 详细规则文档。' +
    'skill 主文档里出现 [详见](references/xxx.md) 这种引用时调本工具拉取。' +
    '可用名字：stages-definition / kb-usage-rules / tool-priority-rules / handover-rules / response-style。' +
    'name 不带路径前缀和 .md 后缀。',
  input_schema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: {
        type: 'string',
        description: 'reference 文件名（不含路径和 .md 后缀），如 "stages-definition"',
      },
    },
  },
};

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

function callClaude({ systemBlocks, messages, tools, toolChoice, tenantId, productLine, conversationId }) {
  // Pass system as a structured content array so `cache_control` markers
  // reach Anthropic via OpenRouter. Flattening to a single string strips
  // them and forces OpenRouter's auto-prefix-cache, which only gives us
  // ONE breakpoint (the skill body) — explicit markers give us two
  // (skill body + per-line block), so the AVAILABLE ASSETS / line config
  // survives the cache instead of being re-paid every turn.
  const systemContent = Array.isArray(systemBlocks)
    ? systemBlocks
        .filter((b) => b && typeof b === 'object' && typeof b.text === 'string' && b.text.length > 0)
        .map((b) => (b.cache_control ? { type: 'text', text: b.text, cache_control: b.cache_control } : { type: 'text', text: b.text }))
    : typeof systemBlocks === 'string'
      ? systemBlocks
      : String(systemBlocks || '');

  const payload = {
    models: [MODELS.SONNET],
    max_tokens: MAX_TOKENS,
    messages: [{ role: 'system', content: systemContent }, ...messages],
    tools: tools.map((t) => {
      const wireTool = {
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.input_schema },
      };
      // 透传 cache_control 到 OpenAI 格式工具的顶层（OpenRouter 接受这个位置）。
      // 不透传的话 markLastToolForCache / buildSubmitResponseTool 设的标记会被
      // 吃掉,整个 tools 数组（~2.4K tokens,含 submit_response 单工具 755 tokens）
      // 每次按 fresh input 计费——这是 2026-04 引入的回归(commit 26e522d9)。
      if (t.cache_control) wireTool.cache_control = t.cache_control;
      return wireTool;
    }),
    // Pin to Anthropic direct — keeps cache_control semantics consistent
    // (Bedrock strips it).
    provider: { order: ['anthropic'], allow_fallbacks: false },
  };
  if (toolChoice?.type === 'auto') {
    payload.tool_choice = 'auto';
  } else if (toolChoice?.type === 'any') {
    // Anthropic 'any' == OpenAI 'required'：模型必须调某个工具，无所谓哪个。
    // OpenRouter 走 OpenAI 兼容 schema，传字面量 'required'。
    payload.tool_choice = 'required';
  } else if (toolChoice?.type === 'tool') {
    payload.tool_choice = { type: 'function', function: { name: toolChoice.name } };
  } else if (toolChoice) {
    payload.tool_choice = toolChoice;
  }
  // sessionId = conversationId 时，admin/llm-usage 看板可按 conversation 维度
  // 切片成本，配合 ④ 的 force-submit 诊断也能定位是哪条对话越界。
  return openrouter.messages.create(payload, {
    tenantId,
    callSite: 'medici.qualify',
    productLine,
    sessionId: conversationId || null,
  });
}

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

// ─── Post-process ────────────────────────────────────────────────────

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
 * Normalize agent responses to canonical leads[].
 *
 * 产品线配置的 lead_fields 全部进 details JSONB（按配置的 key 名原样存）；
 * 顶层只保留 TOP_LEVEL_RETAIN 里列出的系统字段 + 评分元数据。
 */
export function normalizeAgentResponse(parsed) {
  if (!parsed.leads) return;
  parsed.leads = parsed.leads.map((lead) => {
    const canonical = { ...lead };
    // NOTE: legacy field aliases (car_brand→brand / part_name→product_name /
    // quantity→qty_bucket / incoterm→international_commercial_term) were removed.
    // normalizeAgentResponse only runs for custom-schema lines, whose
    // output_schema is additionalProperties:false — the model can ONLY emit the
    // product_line's configured lead_fields keys. Aliasing a configured key
    // (e.g. 农机线的 `quantity`) to a different name silently dropped it from
    // details, so the UI (which reads details[key] by the configured key) never
    // showed it. Store keys verbatim.

    const detailsObj = { ...(canonical.details || {}) };
    const topLevel = {};
    for (const [key, value] of Object.entries(canonical)) {
      if (key === 'details') continue;
      if (TOP_LEVEL_RETAIN.has(key)) {
        topLevel[key] = value;
      } else if (value !== '' && value !== null && value !== undefined) {
        detailsObj[key] = value;
      }
    }

    return { ...topLevel, details: detailsObj };
  });
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
 * Run one turn of the Medici conversation agent.
 *
 * @param {object}   opts
 * @param {Array}    opts.history      Prior {role, content, metadata} turns.
 * @param {string|object|Array} opts.input  Latest user input (plain text,
 *                                          single message, or aggregated batch).
 * @param {object}   [opts.context]    { missing_fields, qualify_missing_fields,
 *                                       prior_state, ad_referral }
 *                                     qualify_missing_fields gates the price
 *                                     lock in KB tools (non-empty → strip).
 * @param {object}   opts.agentConfig  Resolved product_line config.
 *                                     REQUIRED: dynamic_injection, tenant_id,
 *                                     product_line. Optional: output_schema.
 * @param {object}   [opts.trace]      { traceId, conversationId, waId }
 * @param {(event) => void} [opts.onToolEvent]  Observability hook.
 * @returns {Promise<object>}          Parsed structured response — see medici-design.md.
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

  if (!agentConfig?.dynamic_injection) {
    throw new Error(
      'medici: agentConfig.dynamic_injection is required. ' +
      'Unbound product_lines must be filtered upstream (Strategy C in queue-processor); ' +
      'replay scripts must load the per-conversation product_line config before calling.',
    );
  }

  // Skill bundle — loaded per-invocation. Admin UI version switch (via
  // /admin/skills) flips the active commit_sha in skill_active; the next call
  // here picks up the new content. ~5-20ms DB hit.
  const skill = await loadSkill('ai-reception-deal');
  const systemStatic = skill.systemPrompt + '\n\n---\n\n' + HOST_PATCH;

  // 1. messages[] (history + latest, cache_control on trailing history turn).
  const { messages, historyCount, latestContent } = await buildMessages(history, input, logger, metaToken);

  // 2. Resolve output schema (custom or generic fallback).
  const outputSchema = resolveOutputSchema(agentConfig);

  // 3. Assemble tools + load sendable assets in parallel. Assets are injected
  //    into the dynamic context so the LLM can reference them by id via the
  //    `attachments` envelope field (no extra tool round needed).
  const tenantId = agentConfig.tenant_id || null;
  const productLineId = agentConfig.product_line || null;
  const conversationId = trace?.conversationId || null;
  const [agentTools, availableAssets] = await Promise.all([
    loadAgentTools({ tenantId, productLineId }, logger),
    loadAvailableAssets({ tenantId, productLineId }, logger),
  ]);
  const tools = [
    ...agentTools,
    READ_SKILL_REFERENCE_TOOL,
    buildSubmitResponseTool(outputSchema),
  ];
  const toolsWithCache = markLastToolForCache(tools);

  const perLineContext = buildPerLineContext({
    injection: agentConfig.dynamic_injection,
    available_assets: availableAssets,
  });
  const sentAssetIds = extractSentAssetIds(history);
  const perTurnContext = buildPerTurnContext({
    missing_fields: context.missing_fields,
    prior_state: context.prior_state,
    ad_referral: context.ad_referral,
    sent_assets: sentAssetIds,
    available_assets: availableAssets,
  });
  const systemBlocks = buildSystemBlocks(systemStatic, perLineContext, perTurnContext);

  logger.info('medici.request.started', {
    message_count: messages.length,
    history_count: historyCount,
    latest_input_type: Array.isArray(latestContent) ? 'multimodal' : 'text',
    model: MODELS.SONNET,
    skill: skill.metadata.name,
    skill_sha: skill.source.sha256,
    context_info: buildTraceContextInfo(context),
    available_assets_count: availableAssets.length,
    sent_assets_count: sentAssetIds.length,
  });

  // 4. Tool-use loop. Same-round tool_calls run in parallel (Ogilvy pattern);
  //    submit_response among them short-circuits as the final answer. Every
  //    turn ultimately ends with submit_response — if the model won't emit it,
  //    we pin one final forced turn after the loop.
  let parsed = null;
  let response = await callClaude({
    systemBlocks,
    messages,
    tools: toolsWithCache,
    // tool_choice='required' 强制模型每轮必须调某个工具（KB 工具 / read_skill_reference
    // / submit_response 之一）。物理上消除"返回纯文本 finish_reason='stop'"那条路径
    // —— 历史数据里这条路径占 18% 调用、每条触发一次 force-submit 的额外 LLM call。
    toolChoice: { type: 'any' },
    tenantId,
    productLine: productLineId,
    conversationId,
  });
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
      const result = await dispatchTool(toolName, toolInput, {
        tenantId,
        productLineId,
        qualifyMissingFields: context.qualify_missing_fields || [],
        skill,
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

    // 滚动 cache 断点：把 messages 里的 cache_control 从 history-tail 推到
    // 刚 append 的最后一条 tool message。下次迭代时本轮的 asst tool_call +
    // tool_result 就能从 cache 读取,而不是按 fresh input 价付费。
    rollCacheBreakpointToLastToolMessage(messages);

    response = await callClaude({
      systemBlocks,
      messages,
      tools: toolsWithCache,
      // 同初次调用：所有 tool 循环迭代均保持 'any'，让模型最终必然以
      // submit_response 收尾、消除 stop 路径。
      toolChoice: { type: 'any' },
      tenantId,
      productLine: productLineId,
      conversationId,
    });
  }

  // 5. Force-submit fallback: loop exited without submit_response (hit
  //    MAX_TOOL_ITERATIONS, or model stopped with plain text). Pin the final
  //    turn with tool_choice=submit_response.
  if (!parsed) {
    // tool_choice='any' 之后 finish_reason='stop' 不再可能（模型物理上必须调
    // 工具）。force_submit 现在只剩两条路径：
    //   1) iterations 撞 MAX_TOOL_ITERATIONS（=5）：模型陷在 KB 工具循环里，
    //      可能是 prompt 没让它收敛、或是 KB tool_result 让它越调越多
    //   2) 模型在 any 模式下却调了非 submit 工具但 history 已经过长——理论
    //      上不会有，留作 defensive 兜底
    // 把诊断信息打全，方便后续按 conversation_id 反查 messages 重放
    const prevMsg = response.choices[0].message;
    const lastToolNames = (prevMsg.tool_calls || []).map((tc) => tc.function?.name).filter(Boolean);
    logger.warn('medici.tool_use.force_submit', {
      stop_reason: response.choices[0].finish_reason,
      iterations,
      max_iterations_hit: iterations >= MAX_TOOL_ITERATIONS,
      last_tool_calls: lastToolNames,
      // 偶发模型残留纯文本（理论上 'any' 下不应出现）的内容样本，截断到 500 字符
      // 防止 trace log 体积爆炸
      last_text_preview:
        typeof prevMsg.content === 'string'
          ? prevMsg.content.slice(0, 500)
          : null,
    });
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
    // 同样滚动断点：force-submit 也是同一回合内的 LLM call,前面 push 的
    // dummy tool_result 在下一次（如果有）应能命中 cache;即使只调一次,这里
    // 也保持与循环行为一致,避免 history-tail 的旧 marker 加上其它新 marker
    // 凑齐 5 个超过 Anthropic 上限。
    rollCacheBreakpointToLastToolMessage(messages);
    response = await callClaude({
      systemBlocks,
      messages,
      tools: toolsWithCache,
      toolChoice: { type: 'tool', name: 'submit_response' },
      tenantId,
      productLine: productLineId,
      conversationId,
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

// ─── Tool dispatcher ─────────────────────────────────────────────────

async function dispatchTool(name, input, ctx) {
  if (name === 'read_skill_reference') {
    const refName = String(input?.name || '').replace(/\.md$/, '').replace(/^references\//, '');
    const content = ctx.skill.references.get(refName);
    if (!content) {
      return {
        error: 'reference_not_found',
        message: `未找到 reference "${refName}"。`,
        available: [...ctx.skill.references.keys()],
      };
    }
    return { name: refName, content };
  }
  return executeKbTool(name, input, ctx);
}

export default runMedici;
export { GENERIC_LEAD_OUTPUT_SCHEMA };
