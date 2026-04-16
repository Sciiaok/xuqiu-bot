# 自动获客 (Autopilot) · 产品 & 工程设计

`/ai-automation` — ChatGPT 风格的自动获客板块。用户聊天描述产品并上传参考图，AI 主导制定完整 Click-to-WhatsApp 广告计划，一键启动投放到 Meta。

> 文档版本：2026-04（PR 1–4 已全部交付 + 后续若干性能/视觉迭代）

---

## 1. 产品定位

一句话：**用户聊产品，AI 产广告，点一下，广告上线**。

- 广告格式固定为 Click-to-WhatsApp：FB/IG → 点击 → 跳到指定 WA → 开启对话
- 优化目标固定：`optimization_goal=CONVERSATIONS` + `destination_type=WHATSAPP`
- 不生成落地页、不做 Lead Form、不做站内转化
- **每个会话只允许 1 个 campaign**（多市场/多受众用该 campaign 下的多个 ad_sets 表达）

**闭环到现有系统**：投放后的 WA 对话自动流入 `conversations` 表 → `/leadhub` 看询盘 → `/campaign-studio` 看归因/质量。`/ai-automation` 只管入口。

---

## 2. 用户流程

```
新对话
  → 用户描述产品 + 上传参考图
  → AI 追问缺口信息（国家、预算等）
  → AI 列出可用 WhatsApp 号码，让用户选（多个时）
  → AI 并行生成多张广告图（generate_ad_creative × N）
  → AI 调 draft_ad_plan 产出完整方案 → 右侧 AdPlanCard 实时填充
  → 用户检查卡片（要改就在聊天里说，AI 覆盖重写 plan）
  → 点「启动投放」
  → /launch 端点：stage（全部 PAUSED）→ activate（campaign + adsets + ads 三层）
  → 卡片状态 draft → staging → staged → launched
  → 成功后卡片出现 3 个直达链接：/campaign-studio · /leadhub · Meta 后台
```

**1 对话 = 1 计划**。`campaigns.length` 被 schema + dispatcher + prompt 三层锁死为 1。ad_sets 和 ads 的数量、组合、文案、素材全部由 AI 自主决定——它要做的是"给你这笔预算，我会怎么切才最优"。

---

## 3. 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Next.js App Router (React 19)，CSS Modules |
| 流式传输 | SSE (`lib/sse.js`) — 无 Redis，直接 `streamSSE(generator)` |
| 后端路由 | Next.js Route Handlers |
| 主 LLM | OpenRouter → Anthropic Claude（Sonnet 4.6 对话轮 / Haiku 4.5 合成轮） |
| 图生成 | OpenRouter → Gemini 3.1 / 2.5 Flash Image → GPT-5 Image（降级链） |
| 数据库 | Supabase（PostgreSQL + Storage）RLS 开启，anon-all 策略（单租） |
| Meta 集成 | Graph API v21 直连，`provider: { order: ['anthropic'] }` 固化路由 |
| 品牌 | Prome Engine（2026-04 refresh，logo 在 `public/brand/`） |

---

## 4. 数据模型

### 4.1 Supabase 表

`supabase/migrations/2026-04-16-autopilot.sql` 建了两张新表，老表（`campaign_briefs` / `orchestrator_sessions` / `orchestrator_messages` / `fix_knowledge`）冷冻不写。

```sql
autopilot_sessions
  id                 uuid PK
  user_id            uuid → auth.users
  title              text                -- 取首条 user message 前 60 字
  status             text                -- active | staging | launched | failed | archived
  plan_json          jsonb               -- 最新广告计划（见 4.2）
  meta_campaign_ids  text[]              -- 启动后填入；侧栏卡快速索引
  created_at, updated_at

autopilot_messages
  id             uuid PK
  session_id     uuid → autopilot_sessions
  message_index  int
  role           text      -- user | assistant | tool
  content        text
  tool_name      text
  tool_use_id    text
  tool_input     jsonb
  tool_result    jsonb
  attachments    jsonb
  created_at
```

另外：图像资产落在现有 `aigc_assets` 表，`conversation_id` 写 `null`（该列的 FK 指向 WhatsApp `conversations` 表，autopilot session 不适配），autopilot session id 放在 `metadata.autopilot_session_id` 字段里备查。

### 4.2 `plan_json` schema（启动后形态）

```jsonc
{
  "version": 1,
  "summary": "Geely 星耀8 · 沙特+阿联酋 Click-to-WhatsApp 询盘",
  "objective": "WHATSAPP_CONVERSATIONS",
  "whatsapp": {
    "phone_number_id":  "1007317245789266",
    "phone_normalized": "8618588557892",  // 裸 E.164，塞入 promoted_object
    "display_number":   "+86 185 8855 7892",
    "verified_name":    "RevoPanda Auto Export",
    "waba_id":          "4384461025119715"
  },
  "estimated_metrics": {
    "expected_conversations_min": 500,
    "expected_conversations_max": 1200,
    "cost_per_conversation_usd_low":  0.6,
    "cost_per_conversation_usd_high": 1.4
  },
  "campaigns": [{                         // 永远长度 1
    "name": "Geely-ME-WA",
    "daily_budget_cents": 3000,           // CBO: 预算挂 campaign 层
    "duration_days": 7,
    "ad_sets": [                          // AI 自主决定数量
      {
        "name": "Geely-SA-Dealer",
        "targeting": { "countries": ["SA"], "age_min": 25, "age_max": 55, "interests": [...] },
        "ads": [                          // AI 自主决定数量（常 A/B 2-4 条）
          {
            "name": "Geely-SA-01",
            "creative": {
              "image_url":    "https://.../ad01.jpg",
              "headline":     "Drive the Future — Geely Galaxy Starship 8",
              "primary_text": "...",
              "description":  "Geely 星耀8"
            },
            "welcome_message": "Hi! Interested in Geely Galaxy Starship 8 for dealership?"
          }
        ]
      }
      // …更多 ad_sets 按市场/受众切
    ]
  }],
  "status": "launched",
  "meta_campaign_ids": ["120245118885240034"],
  "meta_adset_ids":    ["120245118885610034", ...],
  "meta_ad_ids":       ["120245118888440034", ...],
  "launched_at":       "2026-04-16T...",
  "drafted_at":        "2026-04-16T..."
}
```

---

## 5. 后端架构

### 5.1 单 Agent 循环

`src/autopilot/agent.service.js::runAutopilotAgent()` — 一个 `for` 循环，最多 `MAX_ITERATIONS=20` 次：

1. 从 DB 重放对话历史为 OpenAI messages
2. 构建 system prompt：STATIC 段（挂 `cache_control: ephemeral`）+ DYNAMIC 段（WA 号码列表 + 上传图列表）
3. **模型路由**：若上一条是 tool_result（合成轮）→ Haiku；否则（对话轮）→ Sonnet
4. `openrouter.messages.stream({ provider: { order: ['anthropic'], allow_fallbacks: false }, ... })`
5. 边流边 yield：`delta`（文本）/ `tool_call`（工具触发，名称已知立刻发）/ `plan_partial`（`draft_ad_plan` 的 JSON 每积累 ~200 字就增量 parse 一次发给前端）
6. 若本轮没有 tool_call → yield `done` 结束；否则**并行执行同轮所有 tool_calls**（`Promise.all` + 事件队列，3 张素材 60s→20s）
7. 持久化、history 追加、下一轮

### 5.2 工具清单

| 工具 | 说明 |
|---|---|
| `draft_ad_plan` | 产出完整 plan_json，写入 session.plan_json。campaigns.length 严格 = 1，dispatcher 会拒绝多 campaign 的输入 |
| `web_search` | Anthropic native web_search；默认 Agent 不用，除非用户明确要求调研 |
| `read_webpage` | Anthropic native web_fetch；同上默认不用 |
| `generate_ad_creative` | 生成 1080×1080 广告图。`reference_image_ids` 必填（1-based 序号，引用 system prompt 列表里的用户上传图），dispatcher 把索引反解为 Supabase URL 再送模型。产物落 `aigc_assets` + `aigc-assets` bucket，返回 public URL |

启动相关（不作为 tool，由前端按钮直接触发）：

| 端点 | 说明 |
|---|---|
| `stage_campaigns` (`meta-launch.service.js`) | 生成器：campaign → adset → creative (link_data 格式) → ad，全部 PAUSED，按层流式 yield 进度 |
| `activate_campaigns` | 生成器：campaign → adset → ad 三层逐级 PAUSED→ACTIVE。Meta 只有三层都 ACTIVE 才真正出广告 |

### 5.3 API 路由

```
/api/autopilot/
├── whatsapp-accounts          GET  列可用 WA 号码 + gate 状态 (?force=1 绕 60s 缓存)
├── upload                     POST 多部分图片上传到 chat-uploads bucket
├── conversations              GET  list / POST create（create 后 fire-and-forget 预热 WA 缓存）
└── conversations/[id]/
    ├── route.js               GET  详情 + messages 历史 / DELETE 删除
    ├── messages/route.js      POST 发消息 → SSE 流
    └── launch/route.js        POST 触发 stage → activate（SSE 流式进度）
```

中断流：前端 `AbortController.abort()` 即可。SSE 的 ReadableStream `cancel()` 回调触发 `generator.return?.()`，后端清理干净。无需独立 `/stop` 端点。

### 5.4 Meta Graph API 调用形状（活线上验证）

```js
// 1. Campaign — CBO 开启
POST /act_{id}/campaigns
{ name, objective: "OUTCOME_ENGAGEMENT", status: "PAUSED",
  buying_type: "AUCTION", special_ad_categories: [],
  daily_budget: <cents>, bid_strategy: "LOWEST_COST_WITHOUT_CAP" }

// 2. AdSet — 无预算（继承 campaign CBO）
POST /act_{id}/adsets
{ name, campaign_id,
  optimization_goal: "CONVERSATIONS",
  billing_event: "IMPRESSIONS",
  destination_type: "WHATSAPP",
  promoted_object: { page_id, whatsapp_phone_number: "<E.164 no +>" },
  targeting: {
    age_min, age_max,
    geo_locations: { countries },
    targeting_automation: { advantage_audience: 0 }   // Meta 2025+ 强制显式
  },
  status: "PAUSED" }

// 3. Ad Creative — link_data 格式（非 asset_feed_spec；后者与 MESSAGES 目标不兼容）
POST /act_{id}/adcreatives
{ name,
  object_story_spec: {
    page_id,
    link_data: {
      image_hash,                        // 来自 metaUploadImage()
      link: "https://api.whatsapp.com/send",
      message: primary_text,
      name: headline,
      description,
      call_to_action: {
        type: "WHATSAPP_MESSAGE",
        value: { app_destination: "WHATSAPP", link: "https://api.whatsapp.com/send" }
      },
      page_welcome_message: "<VISUAL_EDITOR JSON>"     // 纯文本，无 ice_breakers
    }
  } }

// 4. Ad
POST /act_{id}/ads  { name, adset_id, creative: { creative_id }, status: "PAUSED" }

// 5. 激活 — 三层都要翻
POST /{campaign_id}  { status: "ACTIVE" }
POST /{adset_id}     { status: "ACTIVE" }   // 漏掉这层会显示"广告组已关闭"
POST /{ad_id}        { status: "ACTIVE" }
```

参考一条真实在投的 CTWA 广告（ad `120243642837920034`）完成字段对齐。

### 5.5 WhatsApp 号码网关

`src/autopilot/whatsapp-accounts.service.js`：
1. 经 `getMetaAccountForUser(userId)`（单租返 env，多租可换实现）拿 token + ad_account_id + page_id
2. 调 `fetchAccountAssets()` 遍历 Page → Business → WABAs → phone_numbers
3. 过滤：`verified_name` 非空且非 `"Test Number"` + `quality_rating !== 'RED'`
4. 返回状态：`ok / no_waba / no_phone / only_test_or_unverified / token_error / not_configured`
5. **进程内 60s 缓存**（负缓存 10s）；新对话创建后 `prewarmWhatsAppAccountsForUser(userId)` 异步加热

前端在新对话时前置调用，非 `ok` 渲染 `WhatsAppGateCard` 拦截聊天。`ok` 且号码 >1 时 Agent 会在 prompt 里主动列出让用户选，=1 时自动用，不再提供卡内下拉切换（换号只能让 AI 重新 draft）。

---

## 6. 前端架构

```
app/(app)/ai-automation/
├── page.js                             入口（Suspense + AutopilotApp）
├── AutopilotApp.js                     顶层容器，三列网格
├── autopilot.module.css                全部样式
├── hooks/
│   └── useMessageStream.js             SSE 订阅 + tool 并发进度汇总
└── components/
    ├── WhatsAppGateCard.js             账号未就绪拦截（6 种分流文案）
    └── AdPlanCard.js                   计划卡片（核心）
```

### 6.1 三列网格布局

```
┌──────────┬─────────────────┬──────────────┐
│ 会话列表  │ 聊天区          │ AdPlanCard   │
│ 260px    │ flex 1 (~1fr)   │ 400px        │
└──────────┴─────────────────┴──────────────┘
```

`.root` 是 grid `260px 1fr 400px` + `overflow: hidden` + `min-height: 0` 链（给所有 flex 子项），保证只有 `.chatScroll` 和 `.planPanel` 各自滚动，外层 `<main>` 绝不整页滚（坑过）。`.composer` `flex-shrink: 0` 固钉底部。

### 6.2 会话列表卡片（侧栏）

每条会话渲染 `SessionCard`，两行信息卡：
- 第一行：状态圆点（`draft/busy/launched/failed` 彩色 + pulse）+ 标题（取 `plan.summary > campaign.name > session.title > '(新项目)'`）+ hover 显示的 × 删除
- 第二行：`国家 · 预算 · 相对时间`（"2 小时前"/"3/14"）

避免了老版本 "你好" / "hi" 这类零信息量标题。

### 6.3 聊天区

消息从 DB `autopilot_messages` 顺序重放。`role=tool` 的行**不在聊天流里渲染**（老版本曾内联 AdPlanCard，现在搬到右列）。流式中：
- `delta` 累积成 `streamingText`，打字机效果
- `tool_call`/`tool_result` 聚合成 `toolStatus` 栏显示 "生成广告图 2/3…"（对 `generate_ad_creative` 特别优化 x/N 展示）
- `plan_partial` 进 `streamingPlan` state，右栏 AdPlanCard 优先显示它（partial > confirmed）

Composer：paperclip 上传（多图）+ 自适应 textarea + 发送/停止按钮互切。

### 6.4 AdPlanCard（右列核心）

**信息层级**：单一白色卡面 + 内部发丝分隔线，没有嵌套盒子。

```
┌─────────────────────────────────────┐
│ 📱 CLICK-TO-WHATSAPP                │  kind badge
│ <summary — 2 行完整展示>              │
├─────────────────────────────────────┤
│ 日预算     预估对话                   │  stats 行（inline，无盒）
│ $30 · 7天  500-1200 · 单价 $0.6-$1.4  │
├─────────────────────────────────────┤
│ 询盘落地                              │
│ 💬 +86 185 8855 7892                │  read-only，无下拉
│    RevoPanda Auto Export            │
├─────────────────────────────────────┤
│ 广告组 · 3                           │
│ [SA 2] [AE 2] [KW 1]                │  pill tabs，accent-tint active
│ SA · 25-55 岁 · 汽车经销              │
│                                      │
│ [图] Drive the Future — Geely …     │
│      The Geely Xingyao 8 has …      │  完整文本，不截断
│      💬 Hi! Interested in …         │
│ ─── (dashed) ───                     │
│ [图] …                               │
├─────────────────────────────────────┤
│ ⬤ 草稿           [✦ 启动投放]        │  状态点 + CTA
└─────────────────────────────────────┘
│ 看数据 → 看询盘 → Meta 后台 →        │  launched 后才出现
└─────────────────────────────────────┘
```

关键交互：
- **多 ad_sets** → 顶部 pill tabs（>1 时显示，=1 直接渲染；4+ 时横向滚动）
- **图片点击** → 全屏 lightbox（90vw/90vh，object-fit: contain，ESC / 背景点击关闭）
- **流式态**：`streaming=true` 时 footer 显示"生成中…"状态点动画，启动按钮禁用
- **启动按钮状态转移**：draft → staging（pulse 动画）→ staged → launched（绿点常亮 + 3 个直达链接）/ failed（红点 + 失败原因 + 重试按钮）
- **卡片滚动**：右列 `overflow-y: auto`，卡片本身 `flex-shrink: 0` 保持自然高度（否则会被 flex 压扁 + 自身 `overflow: hidden` 裁掉内容）

---

## 7. 性能与延迟优化

AI 轮询 + 图生成是延迟大头。交付顺序做了以下 6 项优化，把端到端从 2-4 分钟压缩到 40-70s：

| # | 优化 | 机制 | 实测 |
|---|---|---|---|
| 1 | **同轮 tool_calls 并行** | `Promise.all` + 事件队列，tool_call 事件按并发发出、tool_result 按到达顺序发出，最后按调用顺序持久化 | 3 张素材：60s → 20s |
| 2 | **Prompt 拆静/动 + cache_control** | system 拆两段，静态段标 `cache_control: ephemeral`，provider 固定 `anthropic`（避免 Bedrock 剥除 flag） | 命中时省 70%+ input tokens |
| 3 | **引用图索引化** | `reference_image_urls` → `reference_image_ids: [1,2]`，dispatcher 反解。完成 tokens 大幅下降；顺带杜绝"URL 幻觉"（曾胡编 Wikimedia URL） | 每 tool_call 省 ~400 tokens |
| 4 | **合成轮走 Haiku** | 末消息为 tool_result → 用 Haiku；对话轮仍 Sonnet | 合成轮 3–5× 提速 |
| 5 | **流式进度 + 渐进 plan** | `tool_call` 事件在 name 一到手就发（不等 args 满）；`plan_partial` 每 ~200 字试探性 `tryPartialJson()` 并 yield | 用户等待期间"看到字段在填" |
| 6 | **流看门狗** | `src/llm-client.js` 里 `STREAM_IDLE_TIMEOUT_MS=30s / STREAM_TOTAL_TIMEOUT_MS=180s`；任一超 → AbortController | 堵住之前 200s+ 僵死 |

另：`listWhatsAppAccountsForUser` 60s 进程内缓存 + 创建会话时 fire-and-forget 预热 → 每条消息省 ~4s Graph API 延迟。

---

## 8. 品牌（2026-04 refresh）

- Logo：`public/brand/prome-logo.png` (820×260 tight-cropped wordmark) + `public/brand/prome-mark.png` (单 P 标)
- 侧栏 hover 展开：collapsed 60px 仅 mark；expanded 240px 切全 wordmark；`.ni.active` 是灰底上的白色浮卡（阴影 + accent 色图标/文字）
- Theme tokens ([app/v5-theme.css](app/v5-theme.css))：
  - `--accent: #2563eb`（royal blue；老值是 FB 蓝 `#1877f2`）
  - `--bg: #f4f6fa`（冷调浅灰）
  - `--bg3: #eef4ff`（蓝调 hover surface）
  - `--r/--rl/--rxl: 8/10/14`（之前 6/8/12，整体更柔）
  - `--shadow`：两层柔 elevation（1px crisp + 3px halo）

---

## 9. 上线前清单

1. **Supabase SQL editor 跑 migration**：`supabase/migrations/2026-04-16-autopilot.sql`
2. **确认 env**：
   - `META_SYSTEM_TOKEN`（需 `whatsapp_business_management` + `ads_management` + `business_management`）
   - `META_AD_ACCOUNT_ID`、`META_PAGE_ID`
   - `OPENROUTER_API_KEY`
3. **首访 `/ai-automation`**：
   - Gate 应 `ok` 并列出可用 WA 号码（否则按 `WhatsAppGateCard` 文案处理）
   - 侧栏 logo 显示为 Prome Engine；hover 展开显示 wordmark
4. **E2E 冒烟**：新对话 → "推广 XX 到 TH+ID，预算 $30/天" → 上传 1-2 张产品图 → 等 AI 出 plan → 右列 AdPlanCard 填满 → 点启动 → 卡片 staged → launched → 三级链接显现 → 去 Meta Business 确认三层都 ACTIVE / IN_PROCESS

---

## 10. 已知风险与短板

| 项 | 说明 | 处理 |
|---|---|---|
| SSE 不支持续传 | 刷新中断后，已持久化消息不丢；in-flight delta 丢失 | 可接受；未来加 Redis Stream + lastEventId |
| 素材生成失败 | 3 模型降级链（Gemini 3.1 → 2.5 → GPT-5 Image）仍可能全败 | 错误透传，Agent 会建议重试或让用户手动上传产品图 |
| stage 部分失败 | 中途失败留下 orphan PAUSED 资源 | 目前透传错误让用户手动清理；未来加 rollback tool |
| 单租户 | env token 共享，多用户共用同一 Meta 账户 | 多租户接口已抽象 `getMetaAccountForUser(userId)`，未来换 OAuth + `user_meta_accounts` 表 |
| OpenRouter 路由抖动 | 偶尔路由到慢通道（曾见 15 tok/s） | 已 pin `provider: ['anthropic']`；再有问题 watchdog 30s idle 超时兜底 |
| 老表未清理 | `campaign_briefs` / `orchestrator_*` 冷冻存档 | 无新写入，零迁移；后续可定期归档到冷备 |

---

## 11. 已清理的旧代码

PR 4 清理清单（已执行）：
- 删 `app/(app)/campaign-studio/ChatTab.js` + `CampaignStudioScreen` 里的 `ai` tab
- 删 `app/api/campaign/**`、`app/api/cron/recover-orchestrator/`、`app/api/aigc/`
- 删 `src/campaign-orchestrator.service.js` / `campaign-intake.service.js` / `research-agent*.service.js` / `strategy-agent.service.js` / `execution-agent.service.js` / `creative-plan.service.js` / `reference-collector.service.js` / `aigc.service.js`（核心能力已内联到 `src/autopilot/creative.service.js`）
- 删 `lib/repositories/campaign-brief.repository.js` / `orchestrator.repository.js` / `fix-knowledge.repository.js`
- 保留 `src/meta-account.service.js` / `src/meta-ads-mcp-client.js`（新路径继续用）
- Supabase 老表不 drop，冷冻存档

净删约 6000+ 行遗留代码，autopilot 核心 5 个 service 文件合计 ~47KB。

---

## 12. 参考

线上 CTWA 广告参考（字段对齐用）：
- ad: `120243642837920034`
- campaign: `120235612159890034`
- objective / optimization_goal / destination_type / CTA / promoted_object 全部与本系统产出一致
