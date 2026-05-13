/**
 * Ogilvy — the ad-buyer agent behind /ogilvy.
 *
 * Named after David Ogilvy, who united product insight, copy, art direction,
 * and media buying into a single craft. This agent does the same: takes the
 * user's product + marketing intent, produces creative, drafts a Meta
 * campaign plan, and (later) optimizes mid-flight.
 *
 * One LLM call per turn, one tool-use loop, streaming back to the browser
 * as SSE. New tools register here; the loop structure stays stable.
 *
 * 2026-04 魔改：agent prompt 来源切换为 overseas-ad-planning skill
 * (`skills/overseas-ad-planning.skill`)，五阶段 SOP 由 skill 主导。
 * Click-to-WhatsApp 收口约束写在 `skill-host-patch.md` 里追加到
 * skill prompt 之后。skill 可热替换，宿主代码改动只在 SYSTEM_STATIC、
 * TOOLS 数组、dispatcher 三处。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openrouter, MODELS } from '../../llm-client.js';
import {
  addMessage,
  addMessages,
  getMessagesForLLM,
  getNextMessageIndex,
  getSession,
  updateSession,
  getMessages,
} from '../../../lib/repositories/ogilvy.repository.js';
import { loadSkill } from '../skills-runtime/index.js';
import { listWhatsAppAccountsForUser } from './whatsapp-accounts.service.js';
import { webSearch, readWebpage } from './tools.service.js';
import { generateAdCreative } from './creative.service.js';

const MAX_ITERATIONS = 20;

// ── Skill bundle + host patch (loaded once, cached at module scope) ─────
//
// Top-level await loads the .skill bundle synchronously at first import. The
// loader memoizes by file path + mtime, so subsequent imports are free.
// Restart the Next.js server to pick up a swapped skill bundle.
const SKILL = await loadSkill('overseas-ad-planning');
// Resolve sibling skill-host-patch.md via import.meta.url so the path holds
// regardless of process cwd (dev / standalone build / serverless).
const HOST_PATCH = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'skill-host-patch.md'),
  'utf8',
);

// References are inlined into the cached system prompt (see SYSTEM_STATIC below).
// Past iterations exposed a `read_skill_reference` tool that streamed a single
// reference's content into the conversation as a tool_result — but each call
// added 10–20K characters of permanent history bloat. Inlining all four ~once,
// inside the ephemeral-cached static prefix, costs the bundle once per cache
// window (5min) at 0.1× input price on cache reads, and removes the per-call
// tool round-trip entirely.
const REFERENCES_INLINED = (() => {
  const order = ['data-sources', 'strategy-template', 'meta-creative-specs', 'meta-api-template'];
  const parts = ['## 附录 · 参考资料（已内联，无需调用工具）\n'];
  for (const key of order) {
    const content = SKILL.references.get(key);
    if (!content) continue;
    parts.push(`### references/${key}.md\n\n${content.trim()}\n`);
  }
  // Any reference not in `order` (forward-compat for future skill bundles)
  for (const [key, content] of SKILL.references) {
    if (order.includes(key)) continue;
    parts.push(`### references/${key}.md\n\n${(content || '').trim()}\n`);
  }
  return parts.join('\n');
})();

// ── Tool schemas ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'draft_ad_plan',
    description:
      '产出一份 Click-to-WhatsApp 广告计划草稿。当用户给出足够的产品信息、目标国家和预算后调用。' +
      '计划中所有广告的 objective 固定为 OUTCOME_ENGAGEMENT，优化目标为 CONVERSATIONS（最大化 WhatsApp 对话数）。' +
      '每个 ad 必须包含一条纯文本的 welcome_message（用户进入 WhatsApp 后看到的第一句）。' +
      'phone_number_id 必须来自 system prompt 里列出的可用号码之一。',
    input_schema: {
      type: 'object',
      required: ['whatsapp', 'campaigns', 'summary'],
      properties: {
        summary: { type: 'string', description: '一句话总结这个计划，显示在卡片顶部' },
        whatsapp: {
          type: 'object',
          required: ['phone_number_id'],
          properties: {
            phone_number_id: { type: 'string', description: '从可用列表中选一个' },
          },
        },
        estimated_metrics: {
          type: 'object',
          properties: {
            expected_conversations_min: { type: 'number' },
            expected_conversations_max: { type: 'number' },
            cost_per_conversation_usd_low: { type: 'number' },
            cost_per_conversation_usd_high: { type: 'number' },
          },
        },
        campaigns: {
          type: 'array',
          minItems: 1,
          maxItems: 1,
          description:
            '本系统严格约定每个会话只产出 1 个 campaign。' +
            '这个 campaign 下的 ad_sets 数量、每个 ad_set 的 ads 数量由你根据方案最优化自主决定——' +
            '市场/受众差异大就多分 ad_set，创意角度多就多出 ads 做 A/B 测试。',
          items: {
            type: 'object',
            required: ['name', 'daily_budget_cents', 'ad_sets'],
            properties: {
              name: { type: 'string' },
              daily_budget_cents: {
                type: 'integer',
                description:
                  '**必填**。每天预算，单位为分 (cents) 的正整数。$20/天 = 2000, $50/天 = 5000。' +
                  '注意：daily_budget 放在 campaign 层（CBO），不要放在 ad_set 层。漏填会导致 Meta 拒绝投放。',
              },
              duration_days: { type: 'integer', description: '投放天数，不填则长期' },
              ad_sets: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['name', 'targeting', 'ads'],
                  properties: {
                    name: { type: 'string' },
                    targeting: {
                      type: 'object',
                      required: ['countries', 'age_min', 'age_max'],
                      properties: {
                        countries: { type: 'array', items: { type: 'string' }, description: 'ISO-2 国家码数组，如 ["TH", "ID"]' },
                        age_min: { type: 'integer', minimum: 13, maximum: 65 },
                        age_max: { type: 'integer', minimum: 18, maximum: 65 },
                        interests: { type: 'array', items: { type: 'string' } },
                      },
                    },
                    ads: {
                      type: 'array',
                      minItems: 1,
                      items: {
                        type: 'object',
                        required: ['name', 'creative', 'welcome_message'],
                        properties: {
                          name: { type: 'string' },
                          creative: {
                            type: 'object',
                            required: ['headline', 'primary_text'],
                            properties: {
                              headline: { type: 'string', description: '标题，FB 里"标题"栏' },
                              primary_text: { type: 'string', description: '正文，FB 里"内容"栏' },
                              description: { type: 'string' },
                              image_url: { type: 'string', description: 'generate_ad_creative 返回的 url，逐字复制' },
                            },
                          },
                          welcome_message: {
                            type: 'string',
                            description: '用户点击广告进入 WhatsApp 后看到的第一条消息（纯文本，不含按钮）',
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'web_search',
    description:
      '联网搜索市场信息。用于快速了解目标国家的市场规模、消费习惯、竞品投放情况等，帮助你做 targeting 和文案决策。' +
      '每次搜索只返回摘要和最多 5 条相关链接。如果需要深入读某条链接的正文，继续调 read_webpage。',
    input_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: '搜索关键词，中英文都可以' },
      },
    },
  },
  {
    name: 'read_webpage',
    description:
      '读取指定 URL 的网页正文并返回摘要。当用户提供了产品官网或 web_search 找到了重要链接时调用。' +
      '每次只能读一个 URL，返回 content 控制在 6000 字内。',
    input_schema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: '完整的 http(s) URL' },
      },
    },
  },
  {
    name: 'generate_ad_creative',
    description:
      '生成一张 1080×1080 广告图。必须有用户上传的参考图。' +
      '为方案里每一条 ad 分别调一次——**不同 ad 的 headline / product_description 要不同**，' +
      '让生成的图在视觉构图、文字重点、场景氛围上有明显差异（A/B 测试才有意义）。' +
      '⚠️ 关键约束：本工具的输入必须**逐字对应**阶段四「素材清单」里那一条 CR 的字段——' +
      'headline 用素材清单的 Headline 文案原文，product_description 用素材清单的「图片视觉描述」段原文。' +
      '不要做卖点摘要、不要简化、不要重新措辞，否则生成出来的图会跟方案里描述的场景/构图/文案不一致。' +
      '返回的 url 写入 draft_ad_plan 对应 ad 的 creative.image_url。',
    input_schema: {
      type: 'object',
      required: ['product_name', 'headline', 'product_description', 'reference_image_ids'],
      properties: {
        product_name: { type: 'string', description: '产品名（中英文均可）' },
        product_description: {
          type: 'string',
          description:
            '**图片视觉脚本**——逐字传入素材清单中该条 CR 的「图片视觉描述」段原文。' +
            '内容是场景、构图、氛围、本地化元素（车牌/路牌/建筑/人物/光线等）。' +
            '不是产品卖点摘要、不是规格表、不是营销话术。' +
            '工具内部会自动注入"商业摄影质量/产品保真/尺寸/文字 overlay"等约束，' +
            '本字段只负责描述视觉本身，长度 80-300 字。',
        },
        headline: {
          type: 'string',
          description:
            '广告图主标题——逐字传入素材清单中该条 CR 的 Headline 文案原文（≤40 字符），' +
            '工具会渲染到图上。不要替换成产品名或缩短，必须和素材清单/方案 ad.creative.headline 完全一致。',
        },
        target_countries: { type: 'array', items: { type: 'string' }, description: 'ISO-2 码，例 ["TH","ID"]' },
        language: {
          type: 'string',
          description:
            'Headline 文字层使用的语言。默认 English；按目标市场设置（沙特→Arabic、德国→German、' +
            '泰国→Thai 等）。必须和素材清单的语言一致。',
        },
        reference_image_ids: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          minItems: 1,
          description: '引用 system prompt 中"用户已上传的产品图"列表的序号（1-based）。例 [1,2]。不要传 URL。',
        },
      },
    },
  },
];

// ── System prompt ───────────────────────────────────────────────────────
//
// Composed of four parts:
//   1. SKILL  — overseas-ad-planning skill body (loaded from .skill bundle).
//      Defines the 5-stage SOP (needs intake → market analysis → strategy →
//      creative → Meta launch docs).
//   2. HOST_PATCH — CTW collar prose. Tells the model: no filesystem, tool
//      whitelist, distill to single CTW campaign before calling draft_ad_plan,
//      etc. Lives in skill-host-patch.md.
//   3. REFERENCES_INLINED — full content of skills/.../references/*.md, joined
//      with section headers. ~16K tokens. Previously pulled lazily via the
//      now-removed `read_skill_reference` tool; inlining removes the tool
//      round-trip and lets the cache absorb the cost: at 0.1× input price on
//      cache hits this is ~$0.0003 per cached read vs ~$0.05+ each time the
//      old tool roundtripped a 10-20k char tool_result into history.
//   4. DYNAMIC — per-session facts (WA numbers + uploaded image list). Built
//      per-turn in buildDynamicSystemPrompt(). NOT part of the cached prefix.
//
// Static segment (1 + 2 + 3) is stable across turns and gets cache_control.

const SYSTEM_STATIC = [
  SKILL.systemPrompt,
  '---',
  HOST_PATCH,
  '---',
  REFERENCES_INLINED,
].join('\n\n');

/**
 * Collect every image URL the user has uploaded in this session (in order).
 * Indices here (1-based) are what the Agent passes as reference_image_ids
 * to generate_ad_creative — the dispatcher maps them back to real URLs.
 * Without this the Agent used to hallucinate URLs (Wikimedia, etc.) when
 * it needed to name the images in tool args.
 */
async function collectSessionUploadUrls(sessionId) {
  const rows = await getMessages(sessionId);
  const urls = [];
  for (const r of rows) {
    if (r.role !== 'user' || !Array.isArray(r.attachments)) continue;
    for (const att of r.attachments) {
      const url = att?.url;
      const ct = att?.content_type || '';
      if (url && ct.startsWith('image/') && !urls.includes(url)) urls.push(url);
    }
  }
  return urls;
}

/**
 * Build the DYNAMIC system prompt (per-session facts — can't be cached).
 * Kept terse so we don't blow the per-turn input budget.
 */
function buildDynamicSystemPrompt(waNumbers, uploadedImageUrls = []) {
  const numbersBlock = waNumbers.length
    ? waNumbers
        .map(
          (n, i) =>
            `  ${i + 1}. phone_number_id="${n.phone_number_id}" · ${n.display_number} · ${n.verified_name} · 质量=${n.quality_rating}`,
        )
        .join('\n')
    : '  (无可用号码)';

  const uploadsBlock = uploadedImageUrls.length
    ? uploadedImageUrls.map((_, i) => `  ${i + 1}. [image ${i + 1}]`).join('\n')
    : '  (尚未上传)';

  return `## 当前账户可用 WhatsApp 号码
${numbersBlock}

## 用户已上传的产品图（用序号引用，不要复制 URL）
${uploadsBlock}

调 generate_ad_creative 时，reference_image_ids 必须是上面列表的 1-based 序号子集（例 [1,2]）。dispatcher 会把序号映射到真实 URL。列表为空时不要调该工具。`;
}

// ── Message helpers ────────────────────────────────────────────────────
// Build the messages array for OpenRouter with Anthropic prompt caching.
//
// Two cache breakpoints are placed (Anthropic allows up to 4):
//   1. End of SYSTEM_STATIC — caches skill body + host patch + references
//      (~22K tokens) for the entire 5-min window. Stable across all turns.
//   2. Last user/assistant message in `history` — caches the growing
//      conversation prefix. Subsequent iterations of the same tool-use loop
//      (and the user's next turn within 5min) replay the prefix at the
//      cache-read rate (0.10× input price).
//
// Tool messages and assistant tool_call-only rows are skipped for the second
// breakpoint because OpenAI-format tool messages aren't a reliable place to
// attach cache_control (we'd need to alter content shape). Walking back to the
// most recent user/assistant text message keeps the format clean and still
// captures > 90% of multi-turn savings.
//
// Provider is pinned to Anthropic direct (see the call site) — Bedrock and
// other OpenRouter providers strip cache_control silently, which makes the
// usage stats show zero cache hits even when the request was well-formed.

function buildMessagesWithCache(staticPrompt, dynamicPrompt, history) {
  const messages = [
    {
      role: 'system',
      content: [
        { type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicPrompt },
      ],
    },
    ...history.map(m => ({ ...m })),
  ];

  // Walk back through history to find the most recent user/assistant message
  // with non-null content and tag its last text block with cache_control.
  for (let i = messages.length - 1; i >= 1; i--) {
    const m = messages[i];
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (m.content === null || m.content === undefined) continue;
    if (typeof m.content === 'string') {
      m.content = [
        { type: 'text', text: m.content, cache_control: { type: 'ephemeral' } },
      ];
      break;
    }
    if (Array.isArray(m.content) && m.content.length > 0) {
      const arr = m.content.slice();
      let tagged = false;
      for (let j = arr.length - 1; j >= 0; j--) {
        if (arr[j]?.type === 'text') {
          arr[j] = { ...arr[j], cache_control: { type: 'ephemeral' } };
          tagged = true;
          break;
        }
      }
      // Image-only message (e.g. user uploaded a photo with no caption) — append
      // a zero-width breadcrumb so we still have a text block to anchor the cache.
      if (!tagged) {
        arr.push({ type: 'text', text: '​', cache_control: { type: 'ephemeral' } });
      }
      m.content = arr;
      break;
    }
  }

  return messages;
}

// ── Model routing ──────────────────────────────────────────────────────
//
// Stage-aware model picker. Reads the recent conversation and routes
// Stage-3 / Stage-5 turns to Sonnet (chain-of-reasoning matters there) and
// everything else to Haiku. Synthesis iterations after a tool result are
// always Haiku — they're small structured outputs Haiku does well.
//
// Keyword list is hand-tuned against the skill body + host patch. Bias is
// conservative: when a Stage 3/5 marker shows up *anywhere* in the last 4
// messages, we stay on Sonnet for the entire turn (and all its tool-use
// iterations, since the keyword stays in history). Better to over-spend a
// few dollars than to produce a thin 10-章 策划案.

// Stage-3 / Stage-5 / 蒸馏 triggers. Lowercased; matched as substring.
// Order doesn't matter — first hit wins.
const SONNET_STAGE_TRIGGERS = [
  '阶段三', '阶段五',
  '策划案', '10 章', '10章', '十章',
  'plan_json', '投放方案', '后台操作手册',
  '蒸馏', 'draft_ad_plan',
  '完整方案', '出方案', '出策划', '生成方案', '输出方案', '正式输出',
];

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join(' ');
  }
  return '';
}

export function pickModelForOgilvyTurn(history) {
  // Synthesis after tool result: Haiku is strictly better — fast, cheap,
  // structured-output strong. Long reasoning doesn't help here.
  const last = history[history.length - 1];
  if (last?.role === 'tool') return MODELS.HAIKU;

  // Scan the last 4 messages (user + assistant prose) for stage triggers.
  // Why a window: a Stage-3 trigger can sit in the assistant's prior message
  // ("即将输出 10 章策划案") and the user's reply might just be "好的，继续";
  // we still want Sonnet on this turn.
  const recentText = history
    .slice(-4)
    .map(m => extractText(m.content))
    .join(' ')
    .toLowerCase();
  if (SONNET_STAGE_TRIGGERS.some(k => recentText.includes(k))) return MODELS.SONNET;

  // First user message of the session: the intake dialog quality (asking
  // smart clarifying questions, role identification) benefits from Sonnet.
  // `history` here always includes the just-added user message, so "no prior
  // assistant" means this is iteration 1 of the first turn.
  const hasAssistantPrior = history.slice(0, -1).some(m => m.role === 'assistant');
  if (!hasAssistantPrior) return MODELS.SONNET;

  return MODELS.HAIKU;
}

// ── Main generator ─────────────────────────────────────────────────────

/**
 * Run one chat turn: take a user message, stream back Agent reasoning + tool
 * calls + final response. Yields SSE events shaped as { event, data }.
 *
 * @param {string} sessionId - Ogilvy session UUID (autopilot_sessions row id)
 * @param {string} userText - new user message (may be empty if attachments-only)
 * @param {Array}  attachments - [{url, content_type, filename}]
 * @param {string} userId - for multi-tenant WA lookup
 */
export async function* runOgilvy(sessionId, userText, attachments = [], userId = null) {
  // 1. Persist the user message first so the next load sees it even if we crash.
  const userIdx = await getNextMessageIndex(sessionId);
  await addMessage(sessionId, {
    message_index: userIdx,
    role: 'user',
    content: userText || '',
    attachments,
  });

  // Derive/refresh the session title from the first user message.
  const session = await getSession(sessionId);
  if (session && !session.title && userText) {
    await updateSession(sessionId, { title: userText.slice(0, 60) });
  }

  yield { event: 'user_saved', data: { message_index: userIdx } };

  // 2. Fetch the available WhatsApp numbers + uploaded reference images. We
  //    pass image indices (not URLs) to the Agent to keep tool args short,
  //    and the dispatcher maps indices back to URLs before calling generate.
  const waGate = await listWhatsAppAccountsForUser(userId);
  const uploadedImageUrls = await collectSessionUploadUrls(sessionId);
  const dynamicPrompt = buildDynamicSystemPrompt(waGate.numbers || [], uploadedImageUrls);

  // 3. Rebuild the OpenAI message list from DB.
  const history = await getMessagesForLLM(sessionId);

  // 4. Tool-use loop
  const openaiTools = TOOLS.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));

  // Accumulator for assistant prose that spans multiple stream calls when the
  // model hits max_tokens mid-output. Persisted as a single DB row at turn end
  // so the transcript shows one bubble instead of N continuation fragments.
  let pendingAssistantText = '';

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let assistantText = '';
    const accToolCalls = {};
    let finishReason = null;

    // Model routing — stage-aware. The previous "first-turn Sonnet, else Haiku"
    // rule was too crude: Stage 3 (10-章策划案) and Stage 5 (双文档 + plan_json
    // 蒸馏) are exactly the turns where chain-of-reasoning quality matters, and
    // Haiku produces visibly weaker 章节连贯性 there. pickModelForOgilvyTurn
    // scans recent messages for canonical stage markers and routes those turns
    // back to Sonnet while keeping the cheap default for everything else.
    const model = pickModelForOgilvyTurn(history);

    try {
      const stream = openrouter.messages.stream({
        models: [model],
        // 16K cap fits a full 17-chapter strategy doc or a stage-5 dual
        // document in one shot. If the model still hits the cap (genuine
        // mega-output), the length-continuation path below stitches the
        // next stream onto pendingAssistantText.
        max_tokens: 16384,
        messages: buildMessagesWithCache(SYSTEM_STATIC, dynamicPrompt, history),
        tools: openaiTools,
        tool_choice: 'auto',
        // Pin to Anthropic direct — keeps cache_control semantics consistent
        // (Bedrock strips it) and reduces provider-variance latency spikes.
        provider: { order: ['anthropic'], allow_fallbacks: false },
      }, { tenantId: session?.tenant_id || null, callSite: 'ogilvy.turn' });

      // Track which tool-call indices have already signaled 'tool_call_start'
      // — we emit it the moment the tool name is known, long before args
      // finish accumulating. Without this the UI shows only a spinner while
      // a 2k-token plan_json accumulates (can be 30-90s).
      const startedIdxs = new Set();
      // Progressive plan rendering: retry lenient JSON parse every ~200 new
      // chars and emit plan_partial so the card fills in live.
      const CHARS_BETWEEN_PARTIAL = 200;
      const lastEmittedLen = new Map();

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) {
          assistantText += delta.content;
          yield { event: 'delta', data: { text: delta.content } };
        }
        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!accToolCalls[idx]) {
              accToolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
            }
            if (tc.id) accToolCalls[idx].id = tc.id;
            if (tc.function?.name) accToolCalls[idx].function.name += tc.function.name;
            if (tc.function?.arguments) accToolCalls[idx].function.arguments += tc.function.arguments;

            // Early signal: as soon as we know the tool name, tell the UI so
            // it can show "生成广告图…" / "撰写方案…" instead of blank spinner.
            const entry = accToolCalls[idx];
            if (entry.function.name && !startedIdxs.has(idx)) {
              startedIdxs.add(idx);
              yield { event: 'tool_call', data: { tool: entry.function.name } };
            }

            // Progressive rendering for draft_ad_plan: parse partial JSON as
            // it streams in and push incremental plan objects to the card.
            if (entry.function.name === 'draft_ad_plan') {
              const len = entry.function.arguments.length;
              const prev = lastEmittedLen.get(idx) || 0;
              if (len - prev >= CHARS_BETWEEN_PARTIAL) {
                lastEmittedLen.set(idx, len);
                const partial = tryPartialJson(entry.function.arguments);
                if (partial) yield { event: 'plan_partial', data: { plan: partial } };
              }
            }
          }
        }
        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }
      }
    } catch (err) {
      console.error('[ogilvy] LLM stream error:', err.message);
      yield { event: 'error', data: { message: `模型调用失败：${err.message}` } };
      return;
    }

    const toolCalls = Object.values(accToolCalls);
    const hasToolCalls = toolCalls.length > 0;
    pendingAssistantText += assistantText;

    if (hasToolCalls) {
      // Flush any accumulated prose (including continuations from prior
      // length-truncation iterations) onto the first tool_use row, then
      // attach the rest of the tool_use rows. Each tool call is its own DB
      // row so getMessagesForLLM can reconstruct the OpenAI message list.
      const nextIdx = await getNextMessageIndex(sessionId);
      const flushedText = pendingAssistantText || null;
      pendingAssistantText = '';
      await addMessages(sessionId, toolCalls.map((tc, i) => ({
        message_index: nextIdx + i,
        role: 'assistant',
        content: i === 0 ? flushedText : null,
        tool_name: tc.function.name,
        tool_use_id: tc.id,
        tool_input: safeParseJSON(tc.function.arguments),
      })));
      history.push({
        role: 'assistant',
        content: flushedText,
        tool_calls: toolCalls,
      });
    } else {
      // No tool calls. Two sub-cases:
      //   a) finishReason === 'length' — output got cut by the per-stream
      //      token cap. Push the partial onto history (in-memory only),
      //      append a synthetic continuation hint, and re-enter the loop.
      //      We do NOT persist yet so the final transcript stays as one
      //      assistant bubble.
      //   b) finishReason in {'stop','end_turn',null} — genuine end. Persist
      //      the full pendingAssistantText and yield done.
      if (finishReason === 'length' && assistantText) {
        history.push({ role: 'assistant', content: assistantText });
        history.push({
          role: 'user',
          content:
            '上文被 token 上限截断。请直接接着上文最后一个字继续写完整内容，' +
            '不要重复已写部分，不要做开场白或总结，也不要解释你被截断了。',
        });
        continue;
      }

      const nextIdx = await getNextMessageIndex(sessionId);
      if (pendingAssistantText) {
        await addMessage(sessionId, {
          message_index: nextIdx,
          role: 'assistant',
          content: pendingAssistantText,
        });
        history.push({ role: 'assistant', content: pendingAssistantText });
        pendingAssistantText = '';
      }
      yield { event: 'done', data: { message_index: nextIdx } };
      return;
    }

    // Execute all tool_calls in the same assistant turn concurrently. The
    // Agent can emit e.g. 3 generate_ad_creative calls at once; running them
    // sequentially used to dominate total latency. We stream tool_call and
    // tool_result events through a shared queue so the UI keeps seeing the
    // progression in real time, while the actual work runs in parallel.
    const eventQueue = [];
    let resolveWait = null;
    const notify = () => { if (resolveWait) { const r = resolveWait; resolveWait = null; r(); } };

    const toolCtx = {
      sessionId,
      userId,
      tenantId: session?.tenant_id || null,
      waNumbers: waGate.numbers || [],
      uploadedImageUrls,
    };

    // Kick off every tool in parallel. Results are collected by id so we can
    // persist them in original call order afterwards (DB ordering matters for
    // OpenAI message reconstruction). We do NOT re-emit tool_call here — the
    // stream loop already fired one as soon as the tool name was known.
    const executions = toolCalls.map(async (tc) => {
      const input = safeParseJSON(tc.function.arguments);
      const result = await executeTool(tc.function.name, input, toolCtx);
      eventQueue.push({ event: 'tool_result', data: { tool: tc.function.name, result } });
      notify();
      return { tc, input, result };
    });

    let allDone = false;
    const completed = Promise.all(executions).finally(() => { allDone = true; notify(); });

    // Drain the queue as events arrive — keeps SSE streaming progressive.
    while (!allDone || eventQueue.length > 0) {
      while (eventQueue.length > 0) yield eventQueue.shift();
      if (!allDone) await new Promise(r => { resolveWait = r; });
    }

    const settled = await completed;

    // Persist tool results in the same order the Agent called them so
    // getMessagesForLLM can pair each tool_use with its matching tool_result.
    for (const { tc, result } of settled) {
      const toolIdx = await getNextMessageIndex(sessionId);
      await addMessage(sessionId, {
        message_index: toolIdx,
        role: 'tool',
        tool_name: tc.function.name,
        tool_use_id: tc.id,
        tool_result: result,
      });
      history.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  yield { event: 'error', data: { message: `工具循环超过 ${MAX_ITERATIONS} 次，已中断` } };
}

// ── Tool dispatcher ─────────────────────────────────────────────────────

async function executeTool(name, input, ctx) {
  switch (name) {
    case 'draft_ad_plan':
      return draftAdPlan(input, ctx);
    case 'web_search':
      return webSearch(input, { tenantId: ctx.tenantId, sessionId: ctx.sessionId });
    case 'read_webpage':
      return readWebpage(input, { tenantId: ctx.tenantId });
    case 'generate_ad_creative': {
      // Translate 1-based index references into real Supabase URLs. Keeping
      // URLs out of tool args saves ~200-600 tokens per call (Supabase URLs
      // are ~180 chars each); Agent only sees indices in its tool schema,
      // which side-steps the URL-hallucination class of bugs entirely.
      const uploads = ctx.uploadedImageUrls || [];
      const maxIdx = uploads.length;

      // Back-compat: some LLM turns may still emit reference_image_urls
      // (cache is 5min; old messages can linger). Accept both, preferring ids.
      const rawIds = Array.isArray(input.reference_image_ids) ? input.reference_image_ids : [];
      const rawUrls = Array.isArray(input.reference_image_urls) ? input.reference_image_urls : [];

      let resolved = [];
      const invalid = [];
      for (const id of rawIds) {
        const n = Number(id);
        if (!Number.isInteger(n) || n < 1 || n > maxIdx) { invalid.push(id); continue; }
        const url = uploads[n - 1];
        if (url && !resolved.includes(url)) resolved.push(url);
      }
      for (const url of rawUrls) {
        if (!uploads.includes(url)) invalid.push(url);
        else if (!resolved.includes(url)) resolved.push(url);
      }

      if (!resolved.length) {
        return {
          error: 'reference_image_ids_required',
          message:
            maxIdx === 0
              ? '用户还没上传产品图，不能生成素材。让用户先上传参考图再调用此工具。'
              : '必须传 reference_image_ids（1-based 序号）。有效范围 [1..' + maxIdx + ']。',
          available_indices: Array.from({ length: maxIdx }, (_, i) => i + 1),
        };
      }
      if (invalid.length) {
        return {
          error: 'reference_image_ids_invalid',
          message: '下列引用无效。只能用 available_indices 里的序号。',
          rejected: invalid,
          available_indices: Array.from({ length: maxIdx }, (_, i) => i + 1),
        };
      }

      return generateAdCreative({
        productName:         input.product_name,
        productDescription:  input.product_description,
        headline:            input.headline,
        referenceImageUrls:  resolved,
        targetCountries:     input.target_countries || [],
        language:            input.language,
        sessionId:           ctx.sessionId,
        userId:              ctx.userId,
        tenantId:            ctx.tenantId,
      });
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * draft_ad_plan — validate the plan, enrich it with the chosen WhatsApp
 * number's display info, and persist it to the session.
 *
 * This does NOT touch Meta. Staging/activation happens in separate tools
 * (added in PR 4).
 */
async function draftAdPlan(input, { sessionId, waNumbers }) {
  // Skill-driven flow guard: refuse plan submission if the agent has not yet
  // produced any ad creative this session. Cheaper than parsing the full
  // 5-stage skill output for completion markers — if there's no creative,
  // there's no plan worth committing. Stops the model from shortcutting
  // straight to draft_ad_plan without running the SOP.
  const history = await getMessages(sessionId);
  const hasCreative = history.some(m =>
    m.role === 'tool' && m.tool_name === 'generate_ad_creative' && !m.tool_result?.error
  );
  if (!hasCreative) {
    return {
      error: 'skill_stages_incomplete',
      message:
        '本会话尚未生成任何广告素材，无法提交方案。请按 skill 五阶段流程执行：' +
        '完成阶段一到三的对话内输出 → 阶段四调用 generate_ad_creative 为每条 ad 生成素材 → ' +
        '阶段五输出双文档 → 用户确认后再调 draft_ad_plan 提交。',
    };
  }

  const chosenId = input?.whatsapp?.phone_number_id;
  const chosen = waNumbers.find(n => n.phone_number_id === chosenId);
  if (!chosen) {
    return {
      error: 'phone_number_id_invalid',
      message: `phone_number_id="${chosenId}" 不在可用列表里。可用的有：${waNumbers.map(n => n.phone_number_id).join(', ') || '(无)'}`,
    };
  }

  // Enforce the "1 conversation = 1 campaign" product rule. Multiple markets
  // or audience variations must live as ad_sets within the single campaign.
  const campaigns = Array.isArray(input.campaigns) ? input.campaigns : [];
  if (campaigns.length !== 1) {
    return {
      error: 'single_campaign_required',
      message:
        `plan.campaigns 必须且只能有 1 个 campaign（当前 ${campaigns.length} 个）。` +
        `如果要投多个市场/受众，请把它们合并到同一个 campaign 的多个 ad_sets 里，` +
        `每个 ad_set 用自己的 targeting.countries 和 ads 配置。`,
    };
  }

  // Structural validation. tool_use schema marks these as required but
  // Anthropic doesn't strictly enforce `required` — models occasionally drop
  // fields (e.g. emit daily_budget on the ad_set level per outdated Meta docs
  // instead of on the campaign). Validating here lets the Agent retry in the
  // SAME turn with a clear error message, instead of failing at launch time
  // with a cryptic Meta rejection.
  const structuralError = validatePlanShape(campaigns);
  if (structuralError) return structuralError;

  const plan = {
    version: 1,
    summary: input.summary || '',
    whatsapp: {
      phone_number_id: chosen.phone_number_id,
      phone_normalized: chosen.phone_normalized,
      display_number: chosen.display_number,
      verified_name: chosen.verified_name,
      waba_id: chosen.waba_id,
    },
    objective: 'WHATSAPP_CONVERSATIONS',
    campaigns: input.campaigns || [],
    estimated_metrics: input.estimated_metrics || null,
    status: 'draft',
    meta_campaign_ids: [],
    drafted_at: new Date().toISOString(),
  };

  await updateSession(sessionId, { plan_json: plan });

  return { ok: true, plan_summary: plan.summary, campaigns_count: plan.campaigns.length };
}

/**
 * Validate the shape of `campaigns` against what Meta will accept.
 *
 * Returns a tool-result-shaped error object the Agent can read, or null when
 * valid. Catches exactly the things that Meta reports with cryptic messages
 * at stage time — daily_budget misplaced or missing, empty targeting,
 * missing creative — so the Agent retries in the same turn instead of the
 * user hitting a mid-launch failure.
 *
 * Kept intentionally shallow: only fields that block Graph API acceptance.
 * Creative content quality is not policed here.
 */
function validatePlanShape(campaigns) {
  const issues = [];

  for (const [ci, c] of campaigns.entries()) {
    const cTag = `campaigns[${ci}]`;
    if (!c?.name || typeof c.name !== 'string') {
      issues.push(`${cTag}.name 缺失或不是字符串`);
    }
    // daily_budget_cents is the most frequent drop. LLM occasionally buries
    // it on ad_sets (wrong for CBO) or omits entirely. Accept integer or
    // integer-like string but reject undefined / 0 / negative.
    const dbRaw = c?.daily_budget_cents;
    const db = Number(dbRaw);
    if (dbRaw === undefined || dbRaw === null || !Number.isInteger(db) || db <= 0) {
      issues.push(
        `${cTag}.daily_budget_cents 缺失或无效（收到：${JSON.stringify(dbRaw)}）。` +
        '必填正整数，单位为分——$20/天 = 2000。daily_budget 必须放在 campaign 层，而不是 ad_set 层。',
      );
    }

    const adSets = Array.isArray(c?.ad_sets) ? c.ad_sets : [];
    if (adSets.length === 0) {
      issues.push(`${cTag}.ad_sets 必须至少有 1 个 ad_set`);
    }

    for (const [si, as] of adSets.entries()) {
      const sTag = `${cTag}.ad_sets[${si}]`;
      if (!as?.name) issues.push(`${sTag}.name 缺失`);

      const countries = Array.isArray(as?.targeting?.countries)
        ? as.targeting.countries.filter(x => typeof x === 'string' && x.trim())
        : [];
      if (countries.length === 0) {
        issues.push(`${sTag}.targeting.countries 为空，至少要 1 个 ISO-2 国家码（例 "SA","AE"）`);
      }

      const ads = Array.isArray(as?.ads) ? as.ads : [];
      if (ads.length === 0) {
        issues.push(`${sTag}.ads 必须至少有 1 个 ad`);
      }

      for (const [ai, ad] of ads.entries()) {
        const aTag = `${sTag}.ads[${ai}]`;
        if (!ad?.name) issues.push(`${aTag}.name 缺失`);
        if (!ad?.creative?.headline) issues.push(`${aTag}.creative.headline 缺失`);
        if (!ad?.creative?.primary_text) issues.push(`${aTag}.creative.primary_text 缺失`);
        if (!ad?.creative?.image_url) {
          issues.push(`${aTag}.creative.image_url 缺失——请先调 generate_ad_creative 拿到 URL 再填回来`);
        }
        if (!ad?.welcome_message) issues.push(`${aTag}.welcome_message 缺失`);
      }
    }
  }

  if (issues.length === 0) return null;
  return {
    error: 'plan_shape_invalid',
    message:
      '计划结构不符合 Meta 投放要求。请修正以下字段后重新调用 draft_ad_plan：\n  - ' +
      issues.join('\n  - '),
    issues,
  };
}

// ── Utils ───────────────────────────────────────────────────────────────

function safeParseJSON(str) {
  if (!str) return {};
  try {
    return JSON.parse(str);
  } catch {
    return { __parse_error: true, raw: str };
  }
}

/**
 * Best-effort partial JSON parse. Scans the buffer char-by-char tracking
 * string/escape state and bracket/brace depth, finds the latest position
 * where the structure is "clean" (not mid-string, not mid-value), truncates
 * there, closes any open brackets/braces, and tries JSON.parse.
 *
 * Handles nested partials like `{"a":[{"b":"unterminat` by truncating back
 * to the last stable comma (or open container) and closing with `}`/`]`.
 *
 * Returns null if no parseable prefix can be recovered. Cheap — O(n) scan.
 */
function tryPartialJson(partial) {
  if (!partial || typeof partial !== 'string') return null;
  try { return JSON.parse(partial); } catch { /* proceed */ }

  // Walk forward tracking depth + string state. Remember the last index
  // where we were NOT in a string, the char was a comma OR an open
  // container. Truncating there and closing the stack yields valid JSON.
  let inString = false, escape = false;
  let lastSafeEnd = -1;                   // position just after a safe cut
  const stack = [];                       // '{' or '[' in order

  for (let i = 0; i < partial.length; i++) {
    const c = partial[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') {
      stack.push(c);
      // Empty container is a safe cut point too
      lastSafeEnd = i + 1;
    } else if (c === '}' || c === ']') {
      stack.pop();
      lastSafeEnd = i + 1;
    } else if (c === ',') {
      lastSafeEnd = i;                    // cut BEFORE the comma
    } else if (c === ':') {
      // after ':' we'll start a value, so this isn't safe by itself
    } else if (/\s/.test(c)) {
      // whitespace doesn't change safety
    } else {
      // in the middle of a literal token
    }
  }

  if (lastSafeEnd <= 0) return null;
  let fixed = partial.slice(0, lastSafeEnd);

  // Re-walk fixed to get the final stack (in case we cut mid-structure)
  const finalStack = [];
  inString = false; escape = false;
  for (let i = 0; i < fixed.length; i++) {
    const c = fixed[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') finalStack.push(c);
    else if (c === '}' || c === ']') finalStack.pop();
  }
  for (let i = finalStack.length - 1; i >= 0; i--) {
    fixed += finalStack[i] === '{' ? '}' : ']';
  }

  try { return JSON.parse(fixed); } catch { return null; }
}
