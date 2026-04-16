/**
 * Autopilot Agent — the single orchestrating loop for /ai-automation.
 *
 * One LLM call, one tool-use cycle, streaming back to the browser as SSE.
 *
 * PR 1 scope: draft_ad_plan only. Later PRs add web_search, generate_ad_creative,
 * stage_campaigns, activate_campaigns. The loop structure does not change —
 * new tools just register here.
 */
import { openrouter, MODELS } from '../llm-client.js';
import {
  addMessage,
  addMessages,
  getMessagesForLLM,
  getNextMessageIndex,
  getSession,
  updateSession,
  getMessages,
} from '../../lib/repositories/autopilot.repository.js';
import { listWhatsAppAccountsForUser } from './whatsapp-accounts.service.js';
import { webSearch, readWebpage } from './tools.service.js';
import { generateAdCreative } from './creative.service.js';

const MAX_ITERATIONS = 20;

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
      '返回的 url 写入 draft_ad_plan 对应 ad 的 creative.image_url。',
    input_schema: {
      type: 'object',
      required: ['product_name', 'headline', 'reference_image_ids'],
      properties: {
        product_name: { type: 'string' },
        product_description: { type: 'string', description: '50-200 字卖点/规格' },
        headline: { type: 'string', description: '广告图主标题' },
        target_countries: { type: 'array', items: { type: 'string' }, description: 'ISO-2 码，例 ["TH","ID"]' },
        language: { type: 'string', description: '默认 English；按国家调' },
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
// Split into two blobs:
//   STATIC  — identical across every turn; marked cache_control so Anthropic
//             caches the first 2k+ input tokens for subsequent turns (5 min TTL).
//   DYNAMIC — per-session facts (WA numbers, uploaded image list). Can't cache.
//
// Tight by design: each bullet earns its place. Earlier versions spent 2500+
// tokens restating the same rules multiple ways; this one ships at ~900.

const SYSTEM_STATIC = `你是"自动获客" Agent，帮用户通过 Meta Click-to-WhatsApp 广告获取 B2B 外贸询盘。

## 系统约束（极少，务必遵守）
- 广告格式固定为 Click-to-WhatsApp：FB/IG 点击 → 跳转 WA 号 → 开启对话
- 优化目标固定：CONVERSATIONS + destination_type=WHATSAPP
- 不生成落地页、不做 Lead Form、不做站内转化
- **每个会话只允许 1 个 campaign**（dispatcher 会拒绝多 campaign）

## 你的核心职责：制定最优投放方案
在上面 4 条系统约束之外，**所有方案结构由你自己判断**。你要像一个资深 Meta 广告优化师：
- **ad_sets 的数量、每组的 targeting / 预算侧重**：你根据目标市场、人群画像、文化语言差异、预算规模自主决定。1 个大市场 1 组可能够，4 个截然不同的市场可能要 4 组，同一市场分受众 A/B 也可以。**没有默认数量**。
- **每个 ad_set 里 ads 的数量、变体组合**：A/B 测试（不同 headline、不同 hook angle、不同素材风格）是 Meta 广告优化的常识。**不要只出 1 条 ad 就交付**，除非预算极小且市场简单。同一 ad_set 出 2-4 条不同角度的 ads 是常态。但具体几条由你判断：素材/文案同质化时别凑数；创意有差异化空间就多出。
- **文案 (headline / primary_text / description) 怎么写**：抓痛点、卖点、语言本地化、行业术语、CTA 强度——你自己决定。不要生成模板化的平庸文案。
- **素材图怎么画**：每条 ad 的 generate_ad_creative 里的 headline / product_description 就是图上要凸显的信息。不同 ad 的图应该**视觉上有明显差异**（构图、配色、场景、文字位置），让 Meta 的算法能学到什么组合对什么受众最优。
- **welcome_message 怎么写**：每条 ad 的 WA 开场白可以按该 ad 针对的用户画像调整——批发客问 MOQ，零售客问型号偏好，不同市场用当地语言。

你的评判标准：**如果是你自己投放这笔预算，你会怎么切？**——这才是我们要的方案。别在数字上保守。

## 工作流程
1. 问清核心信息（产品 / 目标国家 / 预算）——用户给够了就立刻推进，不要刻意追问
2. 没上传产品图 → 让用户上传；没参考图不能调 generate_ad_creative
3. 可用 WA 号 >1 时列给用户选；=1 直接用；=0 引导去 business.facebook.com 绑定
4. 在同一轮回复里**并列批量调** generate_ad_creative（计划里有多少条 ad 就调多少次——并行执行，不串行）
5. 所有素材到齐后调 draft_ad_plan 产出完整方案
6. 用中文简短介绍方案重点（抓结构和亮点，不要 repeat 每个字段），提醒用户点"启动投放"

## 并行调用（影响用户体感）
同一轮回复里彼此独立的工具**必须一次全调**，系统并行执行。有多少条 ad 就并列发起多少个 generate_ad_creative 调用——总时间 = 最慢那个。依赖上一步结果的（draft_ad_plan）才允许分轮。

## 工具使用
- web_search / read_webpage：默认不用，除非用户明确要求调研
- generate_ad_creative：必填 reference_image_ids（下方列表的序号，**不要传 URL**）
- draft_ad_plan：一会话一份；覆盖式更新

## welcome_message
纯文本，第一人称，含产品名 + 一个开放式问题。按目标国家用当地语言或英文。

## 语气
中文对话，专业直接不啰嗦。产品细节没把握先问用户，不瞎编。`;

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
// The static prompt gets `cache_control: ephemeral` so it's reused across
// turns (5min TTL, charged once per 5min window).
//
// NOTE (2026-04): OpenRouter's routing may send the request to Bedrock or
// other providers that strip cache_control, in which case we see 0 cached
// tokens in usage stats. Leaving the flag in place is harmless and activates
// automatically once routing picks Anthropic-direct. Benchmarked: with
// provider: { order: ['anthropic'], allow_fallbacks: false } we still got 0
// writes in one test — investigating separately. Other optimizations (B/C/D/
// E/F) deliver the bulk of the speedup regardless.

function buildMessagesWithCache(staticPrompt, dynamicPrompt, history) {
  return [
    {
      role: 'system',
      content: [
        { type: 'text', text: staticPrompt, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: dynamicPrompt },
      ],
    },
    ...history,
  ];
}

// ── Main generator ─────────────────────────────────────────────────────

/**
 * Run one chat turn: take a user message, stream back Agent reasoning + tool
 * calls + final response. Yields SSE events shaped as { event, data }.
 *
 * @param {string} sessionId - autopilot session UUID
 * @param {string} userText - new user message (may be empty if attachments-only)
 * @param {Array}  attachments - [{url, content_type, filename}]
 * @param {string} userId - for multi-tenant WA lookup
 */
export async function* runAutopilotAgent(sessionId, userText, attachments = [], userId = null) {
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

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let assistantText = '';
    const accToolCalls = {};
    let finishReason = null;

    // Model routing: turns that synthesize output from tool results (writing
    // the plan JSON, summarizing search results, etc.) don't need Sonnet's
    // reasoning — Haiku is 3-5× faster at the same quality for structured
    // output. Conversational turns (info gathering, asking user questions)
    // still use Sonnet.
    const last = history[history.length - 1];
    const synthesisTurn = last?.role === 'tool';
    const model = synthesisTurn ? MODELS.HAIKU : MODELS.SONNET;

    try {
      const stream = openrouter.messages.stream({
        models: [model],
        max_tokens: 4096,
        messages: buildMessagesWithCache(SYSTEM_STATIC, dynamicPrompt, history),
        tools: openaiTools,
        tool_choice: 'auto',
        // Pin to Anthropic direct — keeps cache_control semantics consistent
        // (Bedrock strips it) and reduces provider-variance latency spikes.
        provider: { order: ['anthropic'], allow_fallbacks: false },
      });

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
      console.error('[autopilot] LLM stream error:', err.message);
      yield { event: 'error', data: { message: `模型调用失败：${err.message}` } };
      return;
    }

    const toolCalls = Object.values(accToolCalls);
    const hasToolCalls = toolCalls.length > 0;

    // Persist the assistant turn. If there are tool calls, each call is its own
    // row (so getMessagesForLLM can reconstruct them); otherwise a single row.
    const nextIdx = await getNextMessageIndex(sessionId);
    if (hasToolCalls) {
      await addMessages(sessionId, toolCalls.map((tc, i) => ({
        message_index: nextIdx + i,
        role: 'assistant',
        content: i === 0 ? (assistantText || null) : null,
        tool_name: tc.function.name,
        tool_use_id: tc.id,
        tool_input: safeParseJSON(tc.function.arguments),
      })));
      // Also add to in-memory history so the next loop iteration sees it
      history.push({
        role: 'assistant',
        content: assistantText || null,
        tool_calls: toolCalls,
      });
    } else if (assistantText) {
      await addMessage(sessionId, {
        message_index: nextIdx,
        role: 'assistant',
        content: assistantText,
      });
      history.push({ role: 'assistant', content: assistantText });
    }

    // No tools → we're done.
    if (!hasToolCalls) {
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
      return webSearch(input);
    case 'read_webpage':
      return readWebpage(input);
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
