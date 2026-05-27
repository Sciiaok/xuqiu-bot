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
 * Agent prompt 来源是 PromeEngine-ads-skill (`skills/PromeEngine-ads-skill/`)；
 * skill 内部 6 主阶段(业务理解→路径选择→市场分析→投放策略→创意策略→方案输出)
 * 由 skill 自洽。Click-to-WhatsApp 收口约束写在 `skill-host-patch.md` 里追加到
 * skill prompt 之后。skill 内容可直接编辑文件热替换，宿主代码改动只在
 * SYSTEM_STATIC、TOOLS 数组、dispatcher 三处。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openrouter, MODELS } from '../../llm-client.js';
import {
  addMessage,
  addMessages,
  appendStageOutput,
  getMessagesForLLM,
  getNextMessageIndex,
  getSession,
  updateSession,
  getMessages,
} from '../../../lib/repositories/ogilvy.repository.js';
import { loadSkill } from '../skills-runtime/index.js';
import { getMetaAccountForUser, getWhatsAppNumberById } from './whatsapp-accounts.service.js';
import { findProductLineById } from '../../../lib/repositories/product-line.repository.js';
import { webSearch, readWebpage } from './tools.service.js';
import { generateAdCreative, isAllowedCreativeUrl } from './creative.service.js';
import { collectKnownUrls, repairAssistantUrls } from './url-repair.js';

// Tool-use loop cap. 30-day usage data shows real chain depth maxes out at 6
// (p90=4, avg=1.7), so 10 gives ~67% headroom while bounding the blast radius
// of a misbehaving agent that keeps emitting tool calls. Hitting this limit
// yields an `error` event and the user can resume by sending a new message.
const MAX_ITERATIONS = 10;

// ── Skill bundle + host patch (loaded once, cached at module scope) ─────
//
// Top-level await loads the skill bundle synchronously at first import. The
// loader memoizes by directory path, so subsequent imports are free.
// Restart the Next.js server to pick up edits to the skill bundle.
const SKILL = await loadSkill('PromeEngine-ads-skill');
// Resolve sibling skill-host-patch.md via import.meta.url so the path holds
// regardless of process cwd (dev / standalone build / serverless).
const HOST_PATCH = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'skill-host-patch.md'),
  'utf8',
);

// References are loaded on-demand via the `read_skill_reference` tool. v2 bundle
// reorganized references into platforms/ industries/ playbooks/ + top-level
// docs — 15 files / ~40K tokens total. Inlining everything would balloon the
// cached prefix; lazy fetch keeps the prefix small and only pulls the few
// references the model actually consults this session.
const REFERENCE_KEYS = Array.from(SKILL.references.keys()).sort();

// ── Tool schemas ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'draft_ad_plan',
    description:
      '产出一份 Click-to-WhatsApp 广告计划草稿。当用户给出足够的产品信息、目标国家和预算后调用。' +
      '计划中所有广告的 objective 固定为 WHATSAPP_CONVERSATIONS，优化目标为 CONVERSATIONS（最大化 WhatsApp 对话数）。' +
      '每个 ad 必须包含一条纯文本的 welcome_message（用户进入 WhatsApp 后看到的第一句）。' +
      'phone_number_id 必须来自 system prompt 里列出的可用号码之一。',
    input_schema: {
      type: 'object',
      required: ['whatsapp', 'campaigns', 'summary'],
      properties: {
        summary: { type: 'string', description: '一句话总结这个计划，显示在卡片顶部' },
        channel: {
          type: 'string',
          enum: ['fb', 'ig', 'google', 'tiktok'],
          description: 'v2 新增。广告系统。V_1.0 默认锁 Meta CTW (fb), 其他取值是 dim5 框架预留。可选, 缺省按 "fb" 处理。',
        },
        ad_format: {
          type: 'string',
          enum: ['ctw', 'ctm', 'instant_form', 'uac', 'shopping', 'spark'],
          description: 'v2 新增。广告形式。V_1.0 默认 ctw (Click-to-WhatsApp), 其他取值是预留。可选, 缺省按 "ctw" 处理。',
        },
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
                    schedule: {
                      type: 'object',
                      description:
                        '**可选**。投放时段（dayparting）。不填则 24h 全天投放。' +
                        '多市场场景必须用 timezone_type=USER 以匹配各受众本地时间——例如菲律宾 PHT 08:00 与哈萨克斯坦 ALMT 08:00 是不同物理时刻。' +
                        '⚠️ 单日预算 < $200 时不建议开 dayparting：Meta 学习期需要稳定流量样本，切窗会拉长 learning phase。',
                      required: ['windows'],
                      properties: {
                        timezone_type: {
                          type: 'string',
                          enum: ['USER', 'ADVERTISER'],
                          description: 'USER=按受众本地时间（多市场首选）；ADVERTISER=按广告账户时区。省略则默认 USER。',
                        },
                        windows: {
                          type: 'array',
                          minItems: 1,
                          maxItems: 24,
                          description: '时间窗数组。每窗一个 [开始-结束] 区间，多个时段就拆多窗。',
                          items: {
                            type: 'object',
                            required: ['days', 'start_minute', 'end_minute'],
                            properties: {
                              days: {
                                type: 'array',
                                items: { type: 'integer', minimum: 0, maximum: 6 },
                                minItems: 1,
                                description: '生效星期数组，0=周日 1=周一 ... 6=周六。例：[1,2,3,4,5]=工作日。',
                              },
                              start_minute: {
                                type: 'integer',
                                minimum: 0,
                                maximum: 1440,
                                description: '当日起始分钟数 (0=00:00, 480=08:00, 720=12:00, 1020=17:00)。',
                              },
                              end_minute: {
                                type: 'integer',
                                minimum: 0,
                                maximum: 1440,
                                description: '当日结束分钟数，必须严格大于 start_minute。',
                              },
                            },
                          },
                        },
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
                          creative_typology_id: {
                            type: 'string',
                            description:
                              'v2 新增。图片类型 ID, 如 "#1-inventory-yard" / "#4-stock-data-card", ' +
                              '取自 industries/{行业}.md 的图片类型清单。用于审计承诺-兑现一致性。可选。',
                          },
                          first_contact_binding: {
                            type: 'string',
                            description:
                              'v2 新增。首响绑定标识, 如 "spot-inventory-confirm" / "logistics-quote"。' +
                              '与 creative_typology_id 配对, 让宿主可校验"图片承诺-WhatsApp 兑现"一致性。可选。',
                          },
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
    name: 'persist_stage_output',
    description:
      '把刚刚产出的一段长内容归档到会话存档，并在后续对话历史里以 200 字摘要替代原文，' +
      '避免 context window 被反复堆叠的长方案撑爆（1M 上限但 token 成本与长度线性相关）。' +
      '何时调：你刚输出了一段超过 **1500 字 / token** 的方案、报告、策划案、操作手册等' +
      '"成形可独立交付"的产出，且预期不会立即被用户大改时。' +
      '★ 强触发：阶段 3 完整市场分析 / 阶段 4 完整投放策略 / 阶段 5 素材清单 / 阶段 6 plan_json 文本 ' +
      '产出后，**同一轮必须紧接着调一次 persist_stage_output**，再回应用户。' +
      '如果用户在下一轮请求修改这段，你基于上次结论生成新版后再次调用此工具（同一 label 多版本是允许的）。' +
      '不要拿这个工具压缩短消息、对话片段或临时澄清——这是为"完整产出"准备的。',
    input_schema: {
      type: 'object',
      required: ['label', 'summary', 'markdown'],
      properties: {
        label: {
          type: 'string',
          description:
            '1 句中文标识，让用户和未来的你能从存档列表里识别这段。' +
            '例："阶段 3 · 10 章 CTW 策划案" / "市场分析报告 · 北美" / "执行方案 V2 (调整 05 章受众)"。' +
            '同一段产出多版本时在 label 后加 V1/V2/(调整 X) 后缀。',
        },
        summary: {
          type: 'string',
          description:
            '200 字内的关键结论，**用第三人称概括**这段产出最重要的决策点 / 数字 / 结构。' +
            '会替换掉原文出现在对话历史里，未来的对话只能看到这个 summary 不能看到原文。' +
            '所以这里要写够你未来重新调用 / 修改时所需的最低信息。',
        },
        markdown: {
          type: 'string',
          description:
            '你刚才输出的完整 markdown 原文，**逐字复制**，不要重写或精简。' +
            '原文会存进数据库，用户在 UI "已存档产出" 时间线上能完整回看。',
        },
      },
    },
  },
  {
    name: 'read_skill_reference',
    description:
      '按 name 读取 skill bundle 内的 reference 文档。v2 bundle 把 reference 分四层组织:' +
      '`platforms/{meta,google,tiktok}` 平台规范、`industries/{automotive,agri-machinery,solar,generic}` ' +
      '行业知识、`playbooks/{budget-and-bidding,targeting-and-audience,b2b-long-funnel}` 投放手册、' +
      'top-level `data-sources` / `compliance` / `creative-prompts`。' +
      'skill 主文档会指明各阶段需要读哪个 reference, 按需调用即可,不要一次性全拉。' +
      '同一 reference 单次会话内一般只需调一次, 重复调用会浪费 context。',
    input_schema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: {
          type: 'string',
          description: '相对 references/ 的路径(不含 .md 后缀), 如 "platforms/meta" / "industries/automotive" / "data-sources"',
        },
      },
    },
  },
  {
    name: 'web_search',
    description:
      '联网搜索市场信息。返回结构: {summary, results[{title,url}], citations[{url,title,content_snippet}]}。\n' +
      '★ citations 是最高优先级的事实溯源 —— content_snippet 是源页面的原文片段(每条最长 600 字),' +
      '没经过二次摘要。任何具体数字 / 日期 / 价格 / 销量 / 发布事件等"硬事实",' +
      '必须基于 citations 里能字面找到的内容,并以 markdown 链接 `[字面值](url)` 形式 inline 引用对应 citation 的 url。\n' +
      '✗ summary 只是 Haiku 二次摘要,可能丢失原文上下文(例:把新闻稿 dateline 误解成产品发布日期)' +
      '——只能用 summary 帮自己快速 orient,不能用 summary 作为事实出处。\n' +
      '✗ 如果 citations 里找不到支撑某事实,不要写具体数字 / 日期,改用区间或定性描述。',
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
      '读取指定 URL 的网页正文并返回完整文本。\n' +
      '⚠️ 当前上游 web_fetch 不稳定(经常返回 500),会得到 `error: "read_webpage_unavailable"`。' +
      '看到这个错误时不要重试同一个或其它 URL —— 改用 web_search 拿 citations 做事实溯源 ' +
      '(citations[].content_snippet 已含源页面原文片段,足以覆盖大多数事实需求)。\n' +
      '仅当需要超出 citations 600 字限制的长内容时才尝试 read_webpage。',
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
      '生成一张广告图。必须有用户上传的参考图。' +
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
        aspect_ratio: {
          type: 'string',
          enum: ['1:1', '4:5', '9:16', '16:9'],
          description:
            'v2 新增。画幅:1:1=FB Feed/IG Feed(默认), 4:5=IG Feed 竖屏, 9:16=IG Reels/Stories/TikTok, 16:9=横屏视频/Google UAC。' +
            '底层模型仅原生支持 1024×1024 / 1024×1536(竖) / 1536×1024(横), 4:5 与 9:16 都映射到 1024×1536, prompt 内会指明目标比例。可选, 缺省 1:1。',
        },
        cta_style: {
          type: 'string',
          enum: ['whatsapp', 'signup', 'shop', 'install', 'learn_more', 'call_now'],
          description:
            'v2 新增。图上 CTA 按钮风格。V_1.0 默认 whatsapp(绿色 WhatsApp 风格按钮)。' +
            '其它取值仅适配未来非 CTW 形式, V_1.0 路径仍应填 whatsapp。可选, 缺省 whatsapp。',
        },
        creative_type: {
          type: 'string',
          enum: ['single_image', 'carousel_placeholder', 'video_placeholder'],
          description:
            'v2 新增。素材类型。V_1.0 仅真正生成 single_image, carousel/video 仅作 schema 占位 — ' +
            '即使填占位值, 实际返回仍是单图 url, 但工具结果会带 placeholder 标记供下游识别。可选, 缺省 single_image。',
        },
      },
    },
  },
];

// ── System prompt ───────────────────────────────────────────────────────
//
// Composed of three parts:
//   1. SKILL — PromeEngine-ads-skill body (loaded from skills/<name>/). Defines
//      the 6-stage SOP (business intake → path selection → market analysis →
//      strategy → creative → plan output).
//   2. HOST_PATCH — CTW collar prose. Tells the model: no filesystem, tool
//      whitelist, distill to single CTW campaign before calling draft_ad_plan,
//      WHATSAPP_CONVERSATIONS objective override. Lives in skill-host-patch.md.
//   3. DYNAMIC — per-session facts (WA numbers + page_id + uploaded images).
//      Built per-turn in buildDynamicSystemPrompt(). NOT cached.
//
// References (skills/<name>/references/**/*.md, 15 files / ~40K tokens) are no
// longer inlined — pulled on demand via the read_skill_reference tool.
// Available reference keys are appended to the static prefix so the model can
// discover them without a directory probe.
//
// Static segment (1 + 2 + reference index) is stable across turns and gets
// cache_control.

const REFERENCE_INDEX_NOTE =
  `## skill 可用 reference (用 read_skill_reference 工具按 name 读)\n\n` +
  REFERENCE_KEYS.map(k => `- ${k}`).join('\n');

const SYSTEM_STATIC = [
  SKILL.systemPrompt,
  '---',
  HOST_PATCH,
  '---',
  REFERENCE_INDEX_NOTE,
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
function buildDynamicSystemPrompt(waNumbers, uploadedImageUrls = [], pageId = null) {
  const numbersBlock = waNumbers.length
    ? waNumbers
        .map(
          (n, i) =>
            `  ${i + 1}. phone_number_id="${n.phone_number_id}" · ${n.display_number} · ${n.verified_name} · waba_id="${n.waba_id || ''}" · 质量=${n.quality_rating}`,
        )
        .join('\n')
    : '  (无可用号码)';

  const pageLine = pageId
    ? `## 当前账户 Meta Page ID\n  page_id="${pageId}"（由宿主自动注入，所有 ad_set 共用）\n\n`
    : '## 当前账户 Meta Page ID\n  (未配置)\n\n';

  const uploadsBlock = uploadedImageUrls.length
    ? uploadedImageUrls.map((_, i) => `  ${i + 1}. [image ${i + 1}]`).join('\n')
    : '  (尚未上传)';

  // Google / TikTok account injection — schema-only stub. LeadEngine has no
  // data source for these yet (only `meta_phone_numbers` exists); a real
  // binding flow + encrypted token storage would be a separate feature. The
  // stub is here so the skill's dim5 framework can detect "non-Meta channel
  // requested but unbound" and route the user back to Meta CTW per V_1.0
  // boundary.
  const googleLine = '## 当前账户 Google Ads 账号\n  (未绑定 — 当前 LeadEngine 仅支持 Meta;若需 Google 投放,请联系产品方排期。skill 应按 Meta CTW 继续。)\n\n';
  const tiktokLine = '## 当前账户 TikTok Ads 账号\n  (未绑定 — 当前 LeadEngine 仅支持 Meta;若需 TikTok 投放,请联系产品方排期。skill 应按 Meta CTW 继续。)\n\n';

  return `## 当前账户可用 WhatsApp 号码
${numbersBlock}

${pageLine}${googleLine}${tiktokLine}## 用户已上传的产品图（用序号引用，不要复制 URL）
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

// ── Model selection ────────────────────────────────────────────────────
//
// 主对话 (ogilvy.turn) 锁定 Claude Sonnet 4.6（1M context window）。
//
// 历史上 ogilvy 用过 "stage-aware" 路由——按上一条是否 tool result / 是否
// 含 stage 3/5 关键词在 Sonnet 与 Haiku 间切换。数据上两个问题：
//
// 1. Haiku 4.5 名义 context window 200K，session 反复返工时主对话 history
//    实测触达 300K+ 灰区（Anthropic 4.5+ API 不报错但模型 working memory
//    超训练长度，输出质量未保证）。
// 2. Sonnet / Haiku 各维护一套 prompt cache，每次切换对方 cache 都要从头
//    建立；省下的单价被 cache write 吃掉一半。
//
// 改为统一 Sonnet 后：① 主对话 input 走真实 1M context；② 单 prompt cache
// 命中率高；③ 路由代码消失。代价是单 turn 单价 ×3.75（input $0.003 vs
// $0.0008），用 stage_outputs 历史压缩协议 (host-patch §5) 控总成本。
//
// 工具调用 (web_search Anthropic fallback / read_webpage) 保留 Haiku —— short
// prompt synthesis Sonnet 不增值（见 tools.service.js）。

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
  const userRow = await addMessage(sessionId, {
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

  yield { event: 'user_saved', data: { message_index: userIdx, id: userRow.id } };

  // 2. Session 锁定单产品线 → 自动注入对应的 WA 号码,模型不再让用户选。
  //    历史 (productLine=NULL) 的会话也 fail-safe:返回错误而不是回退到
  //    "随便挑一个号码"——避免错号发广告。
  const productLine = session?.product_line || null;
  if (!productLine) {
    yield { event: 'error', data: { message: '此会话未绑定产品线(可能是迁移前老数据),无法继续。请新建项目。' } };
    return;
  }
  const productLineRow = await findProductLineById({ tenantId: session.tenant_id, id: productLine });
  if (!productLineRow?.wa_phone_number_id) {
    yield { event: 'error', data: { message: `产品线「${productLineRow?.name || productLine}」未绑定 WhatsApp 号码,请先在产品线配置里绑定` } };
    return;
  }
  const boundWaNumber = await getWhatsAppNumberById(userId, productLineRow.wa_phone_number_id);
  if (!boundWaNumber) {
    yield { event: 'error', data: { message: `产品线绑定的号码 ${productLineRow.wa_phone_number_id} 在 Meta 端不可用(可能已停用或当前用户无权限)` } };
    return;
  }

  const [metaAccount, uploadedImageUrls] = await Promise.all([
    getMetaAccountForUser(userId),
    collectSessionUploadUrls(sessionId),
  ]);
  // 单号码包装成数组喂给 buildDynamicSystemPrompt — 提示词模板不变,
  // 模型看到的就是"只有这一个号码可用",自然不会试图调 listWhatsAppAccounts。
  const dynamicPrompt = buildDynamicSystemPrompt(
    [boundWaNumber],
    uploadedImageUrls,
    metaAccount?.page_id || null,
  );

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

    // 主对话锁定 Sonnet 4.6（1M context window）。详见上方 Model selection
    // 注释 — 历史的 stage-aware 路由在数据上暴露了 Haiku 200K 灰区 + 双
    // prompt cache 浪费两个问题。
    const model = MODELS.SONNET;

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
      }, { tenantId: session?.tenant_id || null, callSite: 'ogilvy.turn', sessionId, productLine });

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
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        event: 'ogilvy.llm.stream_error',
        component: 'ogilvy/agent',
        session_id: sessionId,
        iteration: iter,
        accumulated_text_chars: assistantText.length,
        accumulated_tool_calls: Object.keys(accToolCalls).length,
        finish_reason: finishReason || null,
        error: err.message,
        error_name: err.name || null,
      }));
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
      // URL self-heal against citations the agent has actually seen this
      // session. See ./url-repair.js for rationale (the 2026-05-25 case
      // had Sonnet writing "discord" instead of "diesel" mid-URL).
      const knownUrls = collectKnownUrls(history);
      const { text: repairedText, repaired, unverified } =
        pendingAssistantText
          ? repairAssistantUrls(pendingAssistantText, knownUrls)
          : { text: pendingAssistantText, repaired: [], unverified: [] };
      if (repaired.length || unverified.length) {
        console.log(JSON.stringify({
          ts: new Date().toISOString(),
          level: 'info',
          event: 'ogilvy.url_repair.applied',
          component: 'ogilvy/agent',
          session_id: sessionId,
          repaired_count: repaired.length,
          unverified_count: unverified.length,
          repairs: repaired.map(r => `${r.from} → ${r.to}`),
        }));
      }
      const flushedText = repairedText || null;
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
      let assistantId = null;
      if (pendingAssistantText) {
        const knownUrls = collectKnownUrls(history);
        const { text: repairedText, repaired, unverified } =
          repairAssistantUrls(pendingAssistantText, knownUrls);
        if (repaired.length || unverified.length) {
          console.log(
            `[ogilvy] url-repair session=${sessionId}: repaired=${repaired.length} unverified=${unverified.length}`,
            repaired.map(r => `${r.from} → ${r.to}`).join('; '),
          );
        }
        const assistantRow = await addMessage(sessionId, {
          message_index: nextIdx,
          role: 'assistant',
          content: repairedText,
        });
        assistantId = assistantRow.id;
        history.push({ role: 'assistant', content: repairedText });
        pendingAssistantText = '';
      }
      yield { event: 'done', data: { message_index: nextIdx, id: assistantId } };
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
      productLine,
      waNumbers: [boundWaNumber],
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
    case 'persist_stage_output':
      return persistStageOutput(input, ctx);
    case 'read_skill_reference': {
      const refName = typeof input?.name === 'string' ? input.name.trim() : '';
      if (!refName) {
        return { error: 'name_required', message: 'name 必填', available: REFERENCE_KEYS };
      }
      const content = SKILL.references.get(refName);
      if (!content) {
        return { error: 'not_found', message: `reference "${refName}" 不存在`, available: REFERENCE_KEYS };
      }
      return { name: refName, content };
    }
    case 'web_search':
      return webSearch(input, { tenantId: ctx.tenantId, sessionId: ctx.sessionId, productLine: ctx.productLine });
    case 'read_webpage':
      return readWebpage(input, { tenantId: ctx.tenantId, sessionId: ctx.sessionId, productLine: ctx.productLine });
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
        aspectRatio:         input.aspect_ratio || '1:1',
        ctaStyle:            input.cta_style || 'whatsapp',
        creativeType:        input.creative_type || 'single_image',
        sessionId:           ctx.sessionId,
        userId:              ctx.userId,
        tenantId:            ctx.tenantId,
        productLine:         ctx.productLine,
      });
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * persist_stage_output — archive a long-form assistant output (10-章 strategy
 * doc, market analysis report, plan_json prose, etc.) so getMessagesForLLM can
 * compress it out of future LLM-facing history. The full markdown stays in DB
 * under autopilot_sessions.stage_outputs; the user can recall it in the UI's
 * stage-archive panel without spending tokens.
 *
 * Pairing semantics: the compression in getMessagesForLLM walks message rows
 * and, when it sees an assistant text row immediately followed (in order) by
 * a successful persist_stage_output tool_result, replaces that assistant text
 * with `[已存档:{label}] {summary}`. The pairing key is "this assistant turn
 * → its very next persist tool call in the same dispatch batch", so the model
 * has to call persist_stage_output in the same turn as it produces the output.
 *
 * Schema is intentionally label/summary/markdown only — no enum, no stage
 * field. The skill body owns "what an output looks like"; this layer just
 * stores and compresses.
 */
async function persistStageOutput(input, { sessionId }) {
  const { label, summary, markdown } = input || {};
  if (!label || typeof label !== 'string') {
    return { error: 'label_required', message: 'label 必填，1 句中文标识。' };
  }
  if (!summary || typeof summary !== 'string') {
    return { error: 'summary_required', message: 'summary 必填，200 字内关键结论。' };
  }
  if (!markdown || typeof markdown !== 'string' || markdown.length < 200) {
    return {
      error: 'markdown_too_short',
      message: '只有超过 ~3000 字的成形产出才值得归档；短消息不要走这个工具。',
    };
  }
  try {
    const record = await appendStageOutput(sessionId, { label, summary, markdown });
    return {
      ok: true,
      archived_id: record.id,
      label: record.label,
      summary: record.summary,
      // compressed_text 是 getMessagesForLLM 在未来 turn 里用来替换原 assistant
      // text 的字符串。把它放在 tool_result 里，压缩逻辑只需一字段就能搬运。
      compressed_text: `[已存档:${record.label}]\n\n${record.summary}`,
      message: '已归档。后续 turn 中这段会以 compressed_text 替换原文进入 LLM 历史，用户在 UI "已存档产出" 时间线上仍可回看完整 markdown。',
    };
  } catch (err) {
    return { error: 'persist_failed', message: err.message };
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
  // Lifecycle guard (P1-1): refuse to overwrite plan_json on a session that's
  // already mid-launch, launched, paused, or staged. Without this, the Agent
  // running in another tab could blow away meta_campaign_ids / meta_ad_ids
  // by rewriting plan_json while a launch is in flight, or — worse — wipe
  // the campaign tree linkage on a live session and break /pause / /resume.
  // Only `active` (first draft) and `failed` (retry after fix) are writable.
  const sessionRow = await getSession(sessionId);
  if (sessionRow && !['active', 'failed'].includes(sessionRow.status)) {
    return {
      error: 'session_locked',
      message:
        `当前会话状态 "${sessionRow.status}" 已锁定 plan,不能再修改方案。` +
        `如果是 launched/paused 想改方案,请先在 UI 暂停并删除当前 session,新建一个重做。`,
    };
  }

  // Skill-driven flow guard: refuse plan submission if the agent has not yet
  // produced any ad creative this session. Cheaper than parsing the full
  // skill output for completion markers — if there's no creative, there's no
  // plan worth committing. Stops the model from shortcutting straight to
  // draft_ad_plan without running the SOP.
  const history = await getMessages(sessionId);
  const hasCreative = history.some(m =>
    m.role === 'tool' && m.tool_name === 'generate_ad_creative' && !m.tool_result?.error
  );
  if (!hasCreative) {
    return {
      error: 'skill_stages_incomplete',
      message:
        '本会话尚未生成任何广告素材，无法提交方案。请按 skill 流程执行：' +
        '完成阶段 1.0 → §4.C → 2 → 3 的对话内输出 → 阶段 4 调用 generate_ad_creative ' +
        '为每条 ad 生成素材 → 阶段 5 输出执行方案 → 用户确认后再调 draft_ad_plan 提交。',
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
    // v2 schema:顶层 channel / ad_format 描述这个 plan 该往哪个平台/形式投。
    // V_1.0 锁 Meta CTW(fb / ctw),缺省按这个走;下游 launch 路径不消费这两个
    // 字段,仅供未来多平台扩展 + 审计使用。
    channel: input.channel || 'fb',
    ad_format: input.ad_format || 'ctw',
    summary: input.summary || '',
    whatsapp: {
      phone_number_id: chosen.phone_number_id,
      phone_normalized: chosen.phone_normalized,
      display_number: chosen.display_number,
      verified_name: chosen.verified_name,
      waba_id: chosen.waba_id,
    },
    objective: 'WHATSAPP_CONVERSATIONS',
    // campaigns 直接透传 — v2 在 ads[] 项内带 creative_typology_id /
    // first_contact_binding 审计字段,launch 链路不读,只随 plan_json 落库。
    campaigns: input.campaigns || [],
    estimated_metrics: input.estimated_metrics || null,
    status: 'draft',
    meta_campaign_ids: [],
    drafted_at: new Date().toISOString(),
  };

  // Atomic CAS belt-and-suspenders to the read-side status guard above:
  // if status drifted from active/failed → staging in the microsecond gap
  // between our getSession read and this update, the WHERE clause filters
  // us out and updateSession throws STATUS_DRIFT instead of clobbering
  // plan_json.
  try {
    await updateSession(
      sessionId,
      { plan_json: plan },
      { onlyIfStatusIn: ['active', 'failed'] },
    );
  } catch (err) {
    if (err.code === 'STATUS_DRIFT') {
      return {
        error: 'session_locked',
        message:
          '会话状态在保存前已被另一操作锁定(可能是 launch 同时开始)。请刷新 UI 查看当前状态。',
      };
    }
    throw err;
  }

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

      // schedule (dayparting) — optional. If present, must shape-check or Meta
      // rejects with a vague "Invalid parameter".
      const sched = as?.schedule;
      if (sched !== undefined && sched !== null) {
        const tz = sched.timezone_type;
        if (tz !== undefined && tz !== null && tz !== 'USER' && tz !== 'ADVERTISER') {
          issues.push(`${sTag}.schedule.timezone_type 必须是 "USER" 或 "ADVERTISER"（收到：${JSON.stringify(tz)}）`);
        }
        const wins = Array.isArray(sched.windows) ? sched.windows : null;
        if (!wins || wins.length === 0) {
          issues.push(`${sTag}.schedule.windows 必须是非空数组；如果不需要 dayparting，整个 schedule 字段省略即可。`);
        } else if (wins.length > 24) {
          issues.push(`${sTag}.schedule.windows 最多 24 条（收到 ${wins.length}）。如果时段重叠请合并。`);
        } else {
          for (const [wi, w] of wins.entries()) {
            const wTag = `${sTag}.schedule.windows[${wi}]`;
            const days = Array.isArray(w?.days) ? w.days : null;
            if (!days || days.length === 0 ||
                !days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
              issues.push(`${wTag}.days 必须是非空数组，元素 ∈ [0,6]（0=Sun..6=Sat）（收到：${JSON.stringify(w?.days)}）`);
            }
            const s = w?.start_minute, e = w?.end_minute;
            const validS = Number.isInteger(s) && s >= 0 && s <= 1440;
            const validE = Number.isInteger(e) && e >= 0 && e <= 1440;
            if (!validS || !validE || s >= e) {
              issues.push(`${wTag}.start_minute/end_minute 必须为 0-1440 整数且 start < end（收到 start=${JSON.stringify(s)}, end=${JSON.stringify(e)}）`);
            }
          }
        }
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
        } else if (!isAllowedCreativeUrl(ad.creative.image_url)) {
          // Only URLs returned by our own generate_ad_creative are accepted.
          // External URLs (e.g. attacker-controlled, leaked via injected tool
          // output) would be downloaded and uploaded to the user's Meta ad
          // account by metaUploadImage, wasting budget on adversarial assets.
          issues.push(
            `${aTag}.creative.image_url 不是 generate_ad_creative 返回的素材 URL。` +
            '只能使用本次会话里 generate_ad_creative 工具返回的 url 字段，不要填外部链接或自己拼路径。',
          );
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
