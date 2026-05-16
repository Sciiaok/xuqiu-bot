# Ogilvy · 自动获客 Agent · 产品 & 工程设计

`/ogilvy` — ChatGPT 风格的自动获客板块。用户聊天描述产品并上传参考图，AI 主导制定完整 Click-to-WhatsApp 广告计划，一键启动投放到 Meta。

> **命名约定**：
> - **产品层 / UI 层** 与 **工程层** 都叫「**Ogilvy**」——`/ogilvy` 路由、sidebar 菜单、`src/agents/ogilvy/`、`runOgilvy()` 一致。取自 David Ogilvy（现代广告教父），他一个人把产品洞察 → 文案 → 视觉 → 媒介购买打通成一条完整手艺；Agent 做的就是同一件事。
> - **历史名「Autopilot」** 已弃用（2026-05-07 重命名）；DB 表名 `autopilot_sessions` / `autopilot_messages` 沿用旧名以保持向前兼容。
>
> 文档版本：2026-05-16（项目强绑产品线 + WhatsApp 号码改成产品线自动注入；模型路由从 stage-aware 改为 Sonnet 4.6 锁定；`read_skill_reference` 工具下线，6 份 references 全量内联；新增 `persist_stage_output` 历史压缩工具；图模型链改为 OpenAI `gpt-image-1` + Gemini Flash Image fallback 两段；`web_search` 走 Tavily 主路径 + Anthropic Haiku fallback；UsageBadge / StageArchive / AdCreativePreview / ProductLinePicker 上线；MAX_ITERATIONS 20 → 10；`/product-lines/[id]/cost-stats` 把 Medici / Ogilvy 平级展示 + leadhub 风格时间窗口；保留 2026-05-07 之前 PR 1–4 / 长输出续写 / Autopilot → Ogilvy 重命名等节流性改动）

---

## 1. 产品定位

一句话：**用户聊产品，AI 产广告，点一下，广告上线**。

- 广告格式固定为 Click-to-WhatsApp：FB/IG → 点击 → 跳到指定 WA → 开启对话
- 优化目标固定：`optimization_goal=CONVERSATIONS` + `destination_type=WHATSAPP`
- 不生成落地页、不做 Lead Form、不做站内转化
- **每个会话只允许 1 个 campaign**（多市场/多受众用该 campaign 下的多个 ad_sets 表达）

**闭环到现有系统**：投放后的 WA 对话自动流入 `conversations` 表 → `/leadhub` 看询盘 → `/campaign-studio` 看归因/质量。`/ogilvy` 只管入口。

---

## 2. 用户流程

```
新项目
  → 弹 ProductLinePicker 强制选产品线（无可用 WA 号码的线被禁选）
  → 创建会话，product_line 写入 autopilot_sessions（创建后不可改）
  → 用户描述产品 + 上传参考图
  → AI 追问缺口信息（国家、预算等）
  → 产品线绑定的 WhatsApp 号码自动注入 dynamic prompt，AI 不再问选哪个
  → AI 并行生成多张广告图（generate_ad_creative × N）
  → 期间长产出（10 章策划案 / 市场分析）由 AI 主动调 persist_stage_output 归档
     右侧 StageArchive 时间线同步显示「已存档产出」
  → AI 调 draft_ad_plan 产出完整方案 → 右侧 AdPlanCard 实时填充
  → 用户检查卡片（要改就在聊天里说，AI 覆盖重写 plan）
  → 点「启动投放」
  → /launch 端点：stage（全部 PAUSED）→ activate（campaign + adsets + ads 三层）
  → 卡片状态 draft → staging → staged → launched
  → 成功后卡片出现 3 个直达链接：/campaign-studio · /leadhub · Meta 后台
```

**1 项目 = 1 产品线 + 1 计划**。`campaigns.length` 被 schema + dispatcher + prompt 三层锁死为 1；`autopilot_sessions.product_line` 创建时强绑，没绑产品线（迁移前老数据）的会话进 `runOgilvy` 会被 fail-safe 拦截，避免拿错号发广告。ad_sets 和 ads 的数量、组合、文案、素材全部由 AI 自主决定——它要做的是"给你这笔预算，我会怎么切才最优"。

---

## 3. 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Next.js App Router (React 19)，CSS Modules |
| 流式传输 | SSE (`lib/sse.js`) — 无 Redis，直接 `streamSSE(generator)` |
| 后端路由 | Next.js Route Handlers |
| 主 LLM | OpenRouter → Anthropic Claude **Sonnet 4.6 锁定**（1M context window）。工具子调用 web_search / read_webpage 走 Haiku 4.5 |
| Web 搜索 | **Tavily REST 主路径**（advanced + include_answer，~$0.005/q）+ Anthropic native `web_search_20250305` via Haiku fallback。Session-scope 3h 缓存按归一化 query 去重 |
| 图生成 | **OpenAI Images API `gpt-image-1` 主路径 + OpenRouter `google/gemini-3.1-flash-image-preview` fallback**（两段链，老 doc 提到的 Gemini 2.5 / GPT-5 Image 已下掉） |
| 数据库 | Supabase（PostgreSQL + Storage）RLS 开启，anon-all 策略（单租） |
| Meta 集成 | Graph API v21 直连，`provider: { order: ['anthropic'] }` 固化路由 |
| 品牌 | Prome Engine（2026-04 refresh，logo 在 `public/brand/`） |

---

## 4. 数据模型

### 4.1 Supabase 表

`supabase/migrations/2026-04-16-autopilot.sql` 建了两张新表，老表（`campaign_briefs` / `orchestrator_sessions` / `orchestrator_messages` / `fix_knowledge`）冷冻不写。之后又有四次结构性叠加（按时间顺序：[soft-delete](../../../supabase/migrations/2026-05-12-autopilot-soft-delete.sql) → [llm_usage_logs.session_id](../../../supabase/migrations/2026-05-15-llm-usage-session-id.sql) → [stage_outputs](../../../supabase/migrations/2026-05-16-autopilot-sessions-stage-outputs.sql) + [llm_usage_logs.product_line](../../../supabase/migrations/2026-05-16-llm-usage-product-line.sql) → [autopilot_sessions.product_line](../../../supabase/migrations/2026-05-17-autopilot-sessions-product-line.sql)）。

```sql
autopilot_sessions
  id                 uuid PK
  user_id            uuid → auth.users
  tenant_id          uuid
  title              text                -- 取首条 user message 前 60 字
  status             text                -- active | staging | launched | failed | archived
  plan_json          jsonb               -- 最新广告计划（见 4.2）
  meta_campaign_ids  text[]              -- 启动后填入；侧栏卡快速索引
  product_line       text                -- 2026-05-17 新增。产品线 slug（对应 product_lines.id）
                                         -- 新会话创建时强制选择，创建后不可改；NULL 仅迁移前老数据
                                         -- 索引 (tenant_id, product_line) where deleted_at IS NULL
  stage_outputs      jsonb DEFAULT '[]'  -- 2026-05-16 新增。由模型主动调 persist_stage_output
                                         -- append 的「成形可独立交付」长产出归档数组
                                         -- 元素形态 {id, label, summary, markdown, created_at}
  deleted_at         timestamptz         -- 2026-05-12 新增。软删除
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

另外：图像资产落在现有 `aigc_assets` 表，`conversation_id` 写 `null`（该列的 FK 指向 WhatsApp `conversations` 表，Ogilvy session 不适配），Ogilvy session id 放在 `metadata.autopilot_session_id` 字段里备查（字段名沿用旧名保持向前兼容）。

LLM 用量埋点表 `llm_usage_logs` 同步加了三列以支撑 UsageBadge / cost-stats：`cache_creation_input_tokens`、`cache_read_input_tokens`（[2026-05-13](../../../supabase/migrations/2026-05-13-llm-usage-cache-tokens.sql)）、`session_id`（[2026-05-15](../../../supabase/migrations/2026-05-15-llm-usage-session-id.sql)）、`product_line`（[2026-05-16](../../../supabase/migrations/2026-05-16-llm-usage-product-line.sql)）。Ogilvy 的所有调用都把这四个维度透传过去。

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

`src/agents/ogilvy/index.js::runOgilvy()` — 一个 `for` 循环，最多 `MAX_ITERATIONS=10` 次（历史是 20；30 天真实数据显示 chain depth p90=4 / avg=1.7，10 已留 ~67% 余量，再多只会放大失控 agent 的爆炸半径）：

1. 持久化用户消息（保证崩溃不丢）
2. **产品线 fail-safe**：读 `autopilot_sessions.product_line` → 用 `findProductLineById` 拿 `wa_phone_number_id` → 用 `getWhatsAppNumberById` 在 Meta 端验证号码可用。任何一步空都直接 yield `error` 中断本轮，避免拿错号或漏号发广告
3. 从 DB 重放对话历史为 OpenAI messages
4. 构建 system prompt：**STATIC 段** = `overseas-ad-planning` skill 主文档 + `skill-host-patch.md`（CTW 收口补丁）+ **6 份 references 全量内联**（详见 §5.5），挂 `cache_control: ephemeral`；**DYNAMIC 段** = 「该产品线绑定的 1 个 WhatsApp 号码」（即便只有一个也装在数组里喂 buildDynamicSystemPrompt，让 prompt 模板不变）+ Meta page_id + 上传图列表
5. **模型路由**：主对话 (`ogilvy.turn`) 锁定 Sonnet 4.6（1M context）。早期版本按"上一条是否 tool_result / 是否含 stage 3/5 关键词"在 Sonnet 与 Haiku 间切——数据上两个问题：① Haiku 4.5 名义 200K，长会话主对话 history 实测触达 300K+ 灰区；② 双 prompt cache 维护，切换时省下的单价被 cache write 吃掉一半。锁 Sonnet 后单 turn input 单价 ×3.75，用 §5.5 历史压缩协议（`persist_stage_output`）控总成本。工具子调用 (`ogilvy.web_search` / `ogilvy.read_webpage`) 仍走 Haiku — short single-turn synthesis Sonnet 不增值
6. `openrouter.messages.stream({ max_tokens: 16384, provider: { order: ['anthropic'], allow_fallbacks: false }, ... })`，并把 `{ tenantId, callSite: 'ogilvy.turn', sessionId, productLine }` 透传给 `llm-client.js`，每次调用落一行 `llm_usage_logs`（含 cache token 分桶 + session_id + 产品线）用于 UsageBadge / cost-stats
7. 边流边 yield：`delta`（文本）/ `tool_call`（工具触发，名称已知立刻发）/ `plan_partial`（`draft_ad_plan` 的 JSON 每积累 ~200 字就增量 parse 一次发给前端）
8. 若本轮没有 tool_call：
   - `finish_reason === 'length'`（17 章策划案 / 阶段五双文档撞 token 上限）→ 把已生成内容压进 history、附一条"接着写、不要重复、不要总结"的合成 user 消息，进入下一次迭代续写。多次迭代的产物在内存里拼成单条 assistant 文本，最终落库为一行（不会切碎成多个气泡）
   - 否则（`stop` / `end_turn` / null）→ 持久化 + yield `done`
9. 有 tool_call → **并行执行同轮所有 tool_calls**（`Promise.all` + 事件队列，3 张素材 60s→20s）；持久化、history 追加、下一轮

### 5.2 工具清单

Ogilvy 一共 **5 个 tool**，全部定义在 [src/agents/ogilvy/index.js](./index.js) 顶部的 `TOOLS` 常量里，
dispatcher 在同一文件的 `executeTool(name, input, ctx)` 里分发。工具在
同轮可以**并行发起**（`Promise.all`），新工具只需往 `TOOLS` 加一条 schema +
在 `executeTool` 加一个 case。

| # | 工具 | 职责 | 状态 |
|---|---|---|---|
| 1 | `web_search`            | Tavily REST 主路径 + Anthropic-Haiku fallback（skill 阶段二调研） | 关键 |
| 2 | `read_webpage`          | Anthropic web_fetch via Haiku，抓取指定 URL 正文（配合 web_search） | 可选 |
| 3 | `generate_ad_creative`  | 生成 1024×1024 广告图（OpenAI gpt-image-1 + Gemini fallback） | 关键 |
| 4 | `draft_ad_plan`         | 阶段六：CTW 蒸馏后的方案落库（覆盖式更新 `plan_json`） | 关键 |
| 5 | `persist_stage_output`  | 把刚产出的长 markdown 归档到 `stage_outputs`，并在后续 history 里用 200 字 summary 替换原文（控 context window） | 关键 |

> **下线**：旧版本的 `read_skill_reference` 已移除。host-patch §6 明确告知模型"任何对它的调用都会返回 Unknown tool 错误"——6 份 references 已全部内联到 `SYSTEM_STATIC` 里，模型直接读末尾附录即可。

#### 1. `web_search` / `read_webpage` —— 调研辅助

- **什么时候调**：skill 阶段二「海外广告市场分析」明确要求基于真实数据源生成报告，模型在该阶段会主动调用获取最新行业数据；用户也可以在任意阶段明确要求调研。
- **入参**：`web_search {query}` 或 `read_webpage {url}`。
- **实现**（[tools.service.js](./tools.service.js)）：
  - `web_search` 主路径走 **Tavily REST**（`search_depth: 'advanced'` + `include_answer: true`，~$0.005/q，单次 fetch 无 LLM 中转）。失败时降级到 Anthropic native `web_search_20250305` via Haiku，~$0.02/q，per-call 日志会显式标注，方便发现还在走慢路径的部署。
  - **Session-scope 3h 缓存**：按归一化 query + session_id 去重；真实流量统计 30 天里 ~25–35% 的搜索是会话内同义重查，缓存命中直接返同样结果只加 `cached: true` 标志。
  - `read_webpage` 仍走 Anthropic `web_fetch_20250910` via Haiku（量级是 search 的 1/30，没必要再接一路）。
- **返回**：`web_search` 返回 `{query, summary, results: [{title, url, content}]}` 最多 5 条 + Tavily 直接生成的 summary（content 截 1500 字）；`read_webpage` 返回 `{url, title, content}` 约 6000 字以内。
- **成本归属**：fallback / read_webpage 的 Haiku 子调用都把 `{tenantId, callSite, sessionId, productLine}` 透传给 llm-client，落 `llm_usage_logs`，cost-stats 能切到产品线粒度。

#### 2. `persist_stage_output` —— 长产出归档 + 历史压缩

- **什么时候调**：模型产出一段超过 3000 字 / token 的"成形可独立交付"内容（10 章 CTW 策划案、完整市场分析报告、阶段五执行方案与 plan_json 文本、操作手册等），且预期下一轮不会立即被用户大改时，**主动**调一次。host-patch §5「历史压缩协议」明确触发条件。
- **入参**：`{label: string, summary: string, markdown: string}`。`markdown` 必须是刚输出原文的**逐字复制**；`summary` 200 字以内的关键结论；`label` 1 句中文标识（"阶段 3 · 10 章 CTW 策划案" / "市场分析 · 北美" / "执行方案 V2 (调整 05 章)"），同段产出多版本时手动加版本后缀。
- **副作用**：dispatcher 把元素 append 到 `autopilot_sessions.stage_outputs` jsonb 数组（[2026-05-16 migration](../../../supabase/migrations/2026-05-16-autopilot-sessions-stage-outputs.sql)）；在下一轮 `getMessagesForLLM` 重放历史时把原 assistant text 替换成 `[已存档:label]\n\nsummary`，对话仍连续但 input token 大幅下降。
- **为什么需要**：主对话锁 Sonnet 4.6（1M context）后单 turn input 单价 ×3.75；input token 越多单 turn 成本线性上涨（300K × $0.003/K ≈ $0.9/turn），且超过模型训练长度时质量退化（context rot）。Anthropic 自己也建议长会话主动压缩历史而非依赖 context 上限硬撑。
- **顺序约束**：阶段五产出 plan_json 后**先**调 `persist_stage_output` 归档整段执行方案，**再**调 `draft_ad_plan` 提交。两个工具调用顺序不能反 —— draft_ad_plan 被拒后还能改，但 plan 原文压缩在前能让会话再开新阶段时 context 有空间。
- **UI**：右栏 StageArchive 组件（详见 §6）以时间线展示 label + 时间 + 展开看完整 markdown，用户能完整回看；模型在后续轮次只能看到 summary。

> **schema 不绑定 skill 阶段**：`stage_outputs` 是有序 jsonb 数组，宿主代码不约束 label 取值、不维护阶段枚举。skill 改阶段名/数量/划分时 schema 一行不动。

#### 3. `generate_ad_creative` —— 广告图生成（关键路径）

- **什么时候调**：skill 阶段四「广告素材内容生成」会先输出素材任务清单 + 每素材完整规格的 markdown，紧接着**为清单中每一个素材并行调一次**。skill 的 references/meta-creative-specs.md 第 6 节详细规定了工具调用约定（每素材一次、同轮并行、A/B 变体差异化）。
- **入参与素材清单强对齐**（2026-05 收紧）：`headline` 必须**逐字**抄素材清单里那条 CR 的 Headline 文案，`product_description` 必须**逐字**抄那条 CR 的「图片视觉描述」段（场景 / 构图 / 氛围 / 本地化元素），不要做卖点摘要、不要简化、不要重新措辞。`language` 跟着素材清单走（沙特→Arabic、泰国→Thai 等）。tool schema 里强约束这三个字段都得逐字传入，避免模型把视觉脚本压成卖点关键词导致生图与方案描述脱节。
- **入参关键**：`reference_image_ids` 是 **1-based 序号**（引用 system prompt 动态段"用户已上传的产品图"
  列表），**不是 URL**。这是为了防止模型幻觉 URL（历史上出现过胡编 Wikimedia 链接）。
- **dispatcher 反解**：[index.js::executeTool](../src/agents/ogilvy/index.js) 里把序号映射到
  `ctx.uploadedImageUrls` 里的真实 Supabase URL，越界或缺失返回结构化错误让模型同轮重试：
  ```js
  { error: 'reference_image_ids_required' | 'reference_image_ids_invalid',
    message: '...', available_indices: [1, 2, ...] }
  ```
- **实现**（[creative.service.js](./creative.service.js)）：**两段降级链**。主路径调 OpenAI Images API 的 `gpt-image-1`（multipart POST 上传引用图，`size=1024x1024 quality=high`，~$0.17/image），失败降级到 OpenRouter `google/gemini-3.1-flash-image-preview`（chat completions 路径，把引用图当 image_url 嵌入 content，~$0.03/image）。老 doc 提到的 Gemini 2.5 / GPT-5 Image 节点已删；2 段链覆盖率足够，调用方拿到 `{error}` 时建议重试或让用户换图。
- **成本归属**：每次成功调用 `logLlmCall({method:'image.edit', ..., callSite:'ogilvy.image-gen', sessionId, productLine, costUsdOverride: calcImageCostUsd(...)})`，所以 `/product-lines/[id]/cost-stats` 能把图片生成开销单独切到一行。
- **URL 防注入**：`ALLOWED_CREATIVE_URL_PREFIX` = `${supabase.url}/storage/v1/object/public/aigc-assets/`，导出 `isAllowedCreativeUrl()` 供 launch path 校验 plan_json 里的 image_url 必须来自本系统的存储桶，挡住通过 `web_search` / `read_webpage` 注入伪造 URL 的提示攻击。
- **产物**：落 `aigc-assets` Supabase bucket + `aigc_assets` 表，session 关联放 `metadata.autopilot_session_id`（字段名沿用旧名）。返回 `{url, storage_path, model, headline, product_name}` 成功 / `{error, message}` 失败；模型再把 `url` 逐字写进 `draft_ad_plan` 的 `creative.image_url`。前端只把 `generate_ad_creative` 的成功 `tool_result` 作为图片消息渲染进对话流（headline 作图说），其它工具仍隐藏。
- **延迟**：单张 20–40s。N 条 ad 时**必须同轮并行发起**——总时间 ≈ 最慢那张。串行等于把 60s 拖成 180s。

#### 4. `draft_ad_plan` —— CTW 蒸馏后的方案落库（最终产物）

- **什么时候调**：skill 五阶段全部对话内输出完成、用户在对话里明确确认后，**一次性**调一次。host-patch 把这一步称作"阶段六：CTW 收口"——模型负责把 skill 阶段五产出的通用 Meta 方案蒸馏成单个 CTW 投放计划（单 campaign、objective 锁死 `WHATSAPP_CONVERSATIONS`、丢弃非 Meta-CTW 内容、为每条 ad 派生 welcome_message），然后调本工具提交。**一会话仅一份**，再调视为覆盖式更新。
- **入参形状**：`{summary, whatsapp: {phone_number_id}, estimated_metrics, campaigns: [...]}`，
  `campaigns.length` 必须严格 = 1（系统约束）。完整 schema 见 [index.js](../src/agents/ogilvy/index.js)
  里 `TOOLS` 中的 `draft_ad_plan.input_schema`，也就是后面 §4.2 展示的 `plan_json` 结构。
- **dispatcher 的校验链**（这是本工具复杂的地方，因为 Anthropic 不严格强制 `required`）：
  1. **skill 阶段完成度 sanity check**——会话历史里没出现过成功的 `generate_ad_creative` 调用就拒绝（`{error: 'skill_stages_incomplete'}`），防止模型 shortcut 跳过 skill 五阶段直接交付；
  2. **phone_number_id 在可用列表里**——否则 `{error: 'phone_number_id_invalid'}` 同轮让模型重试；
  3. **campaigns.length === 1**——否则 `{error: 'single_campaign_required'}`，提醒把多市场合并进
     同一 campaign 的多个 ad_sets；
  4. **结构完整性**——`validatePlanShape()` 检查 `daily_budget_cents` 放在 campaign 层（CBO），
     每个 ad_set 有 `targeting.countries + age_min + age_max`，每条 ad 有 `creative + welcome_message`；
     漏字段会在 Meta 阶段炸出费解错误，所以提前拦。
- **副作用**：把合成的 plan 写进 `autopilot_sessions.plan_json`（表名沿用旧名；整块覆盖），`status` 从
  `active` 转 `draft`。前端右侧 AdPlanCard 立刻从流式 `plan_partial` 切成最终 plan。
- **注意**：`draft_ad_plan` **不碰 Meta**。真正上架由前端"启动投放"按钮触发下面那套 launch 端点。

#### 启动相关（不是 tool，是前端按钮直发的专用端点）

| 端点 | 说明 |
|---|---|
| `stage_campaigns` ([meta-launch.service.js](../src/agents/ogilvy/meta-launch.service.js)) | 生成器：campaign → adset → creative (link_data 格式) → ad，全部 PAUSED，按层流式 yield 进度 |
| `activate_campaigns` | 生成器：campaign → adset → ad 三层逐级 PAUSED → ACTIVE。Meta 只有三层都 ACTIVE 才真正出广告 |

**为什么 launch 不走 tool-use**：stage + activate 是用户明确点"启动投放"才发生的**不可回退的钱事**
——加一层 LLM 判断没价值（方案已经定稿了），只会增加出错面。前端直接 POST 到
`/api/ogilvy/conversations/[id]/launch`，后端生成器流式返回进度。

### 5.3 API 路由

```
/api/ogilvy/
├── whatsapp-accounts          GET  列可用 WA 号码 + gate 状态（?productLine=<id> 时按产品线绑定单选；?force=1 绕 60s 缓存）
├── upload                     POST 多部分图片上传到 chat-uploads bucket
├── conversations              GET  list（按 product_line 过滤可选） / POST create（必须带 productLine）
└── conversations/[id]/
    ├── route.js               GET  详情（含 stage_outputs + product_line） + messages 历史 / DELETE 软删
    ├── messages/route.js      POST 发消息 → SSE 流
    ├── launch/route.js        POST 触发 stage → activate（SSE 流式进度）
    └── usage/route.js         GET  本会话 LLM 用量聚合（UsageBadge 数据源）
```

- **`/usage`**（2026-05 新增）：从 `llm_usage_logs` 按 `session_id` 拉所有行（含 `cache_creation_input_tokens` / `cache_read_input_tokens` / `product_line`），返回 `{totals, latest, by_call_site, by_model, context_window_tokens: 1_000_000, turn_count}` 给前端 UsageBadge。`latest` 只取最近一次 `ogilvy.turn` 行（不取 `ogilvy.web_search` / `read_webpage` —— 后者走 Haiku 的独立短 prompt，跟主对话历史无关，混进 latest 会让 1M 占比读数失真）。
- **中断流**：前端 `AbortController.abort()` 即可。SSE 的 ReadableStream `cancel()` 回调触发 `generator.return?.()`，后端清理干净。无需独立 `/stop` 端点。

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

### 5.5 Skill 驱动架构

Agent 的 system prompt 不由 ogilvy 自己写，而是从 `skills/overseas-ad-planning/` 加载。skill 是 Anthropic 标准 skill bundle 格式（目录形态），由 PM 维护、定义海外广告投放的子阶段 SOP（1.0 需求收集 / 1.5 决策辅助 / §4.C 规则查询 / 阶段 2 市场分析 / 阶段 3 策略 / 阶段 4 素材 / 阶段 5 执行方案）。**阶段六「CTW 蒸馏」由 host-patch 补充**（skill 不含），最终调 `draft_ad_plan` 提交。

**核心原则**：skill 是可热替换资产，宿主代码改动控制在 SYSTEM_STATIC、TOOLS 数组、dispatcher 三处，其余不动。

#### 文件构成

| 文件 | 作用 |
|---|---|
| `skills/overseas-ad-planning/SKILL.md` | 主文档（~10K tokens），子阶段 SOP。已 patch 改造：所有 "present_files / 落盘" 指令删除，改为对话内输出；阶段四生图改为调本系统的 `generate_ad_creative` |
| `skills/overseas-ad-planning/references/` | 6 份方法论附录（`data-sources` / `strategy-template` / `meta-creative-specs` / `meta-api-template` / `compliance-blacklist` / `creative-prompt-patterns`），合计 ~20K tokens |
| `src/agents/skills-runtime/loader.js` | 通用 skill 加载器：读 `skills/<name>/`、解析 frontmatter、构建 references 查找表。模块级缓存（按 dirPath） |
| `src/agents/skills-runtime/index.js` | 极薄 export，`loadSkill(name)` 唯一对外接口 |
| `src/agents/ogilvy/skill-host-patch.md` | CTW 收口指令：运行环境约束（无文件系统）、工具白名单、阶段六 CTW 蒸馏规则、动态段消费规则、§5 历史压缩协议、§6 references 全量内联说明。属于集成层，与 skill 解耦 |

#### System prompt 拼装（references 已全量内联）

```
[STATIC, cache_control=ephemeral]
  ├── SKILL.systemPrompt    (= SKILL.md body, ~10K tokens)
  ├── HOST_PATCH            (skill-host-patch.md, ~1.5K tokens)
  └── REFERENCES_INLINED    (6 份 references 拼接 ~20K tokens，作为"附录 · 参考资料"节挂在末尾)

[DYNAMIC]
  ├── 当前产品线绑定的 WhatsApp 号码（数组包装的单元素）
  ├── Meta page_id
  └── 用户已上传的产品图序号列表
```

**为什么改回内联**：早期版本暴露过 `read_skill_reference` 工具，模型按阶段需要时主动拉。代价是每次调用把 10–20K 字符的 reference 塞进 tool_result 进 history，**永久占位**，下一轮整段还要重新缓存读一次。改全量内联后：references 一次性占 ~20K static prompt → `cache_control: ephemeral` 命中后按 0.1× input 价格读，等价于 ~$0.0003/turn 的稳定常驻成本，模型再频繁查阅也只读 cache 不走工具往返。`read_skill_reference` 工具下线，host-patch §6 明确告知模型"任何对它的调用都会返回 Unknown tool 错误"，并复述 6 份 reference 已在末尾附录。

> 老版本 doc 提到的"常驻段省 ~20K，未用到的 reference 完全不付费"在数据上没成立——`/admin/llm-usage` 显示几乎每个会话都会拉至少 3 份 reference 进 history，叠加后成本反超内联方案。

#### Skill 升级流程

1. 直接编辑 `skills/overseas-ad-planning/` 目录下的 SKILL.md / references
2. 重启 next.js 服务（loader 在进程内模块级缓存，重启后重新读盘）

#### CTW 收口的 sanity check

`draftAdPlan()` dispatcher 在执行前检查会话历史是否出现过成功的 `generate_ad_creative` 调用，没有则拒绝（`error: 'skill_stages_incomplete'`）。这是为了防止模型在 skill 五阶段未完成时 shortcut 直接交付。`phone_number_id` 必须 = 产品线绑定的号码（fail-safe 在 `runOgilvy` 入口已 enforce，dispatcher 这里二次校验冗余兜底）。

### 5.6 WhatsApp 号码网关

[whatsapp-accounts.service.js](./whatsapp-accounts.service.js)：

1. 经 `getMetaAccountForUser(userId)`（单租返 env，多租可换实现）拿 token + ad_account_id + page_id
2. 调 `fetchAccountAssets()` 遍历 Page → Business → WABAs → phone_numbers
3. 过滤：`verified_name` 非空且非 `"Test Number"` + `quality_rating !== 'RED'`
4. 返回状态：`ok / no_waba / no_phone / only_test_or_unverified / token_error / not_configured`
5. 进程内 60s 缓存（负缓存 10s）。**`prewarmWhatsAppAccountsForUser` 已删除** —— 项目强绑产品线后，新建会话不再需要预热全量号码列表（号码在产品线配置时就已绑死）

**号码绑定流程换了一层**：

- 旧版（≤ 2026-05-07）：会话不绑产品线，前端创建会话时前置拉全量 WA 号码，多号码情况下 Agent 在 prompt 里列出让用户对话选，单号码自动用。
- 新版（2026-05-17 起）：会话强绑产品线 → 产品线在 `product_lines.wa_phone_number_id` 上事先配好唯一号码 → `runOgilvy` 入口用 `getWhatsAppNumberById(userId, wa_phone_number_id)` 在 Meta 端验证可用性 → 装进单元素数组喂 `buildDynamicSystemPrompt`，模型看到的就是"只有这一个号码可用"，自然不会再问选哪个。

产品线没绑号 / 绑的号 Meta 端不可用 / 会话本身缺 product_line（迁移前老数据），三种情况都在 `runOgilvy` 入口 fail-safe `yield error` 中断本轮——这比"回退到随便挑一个号码"安全得多。

前端在 ProductLinePicker 里把"无 has_phone"的产品线置灰禁选；进到聊天后 `WhatsAppGateCard` 只在 Meta 账户层完全不可用时才出现（`getMetaAccountForUser` 失败），不再充当多号码选择器。

---

## 6. 前端架构

```
app/(app)/ogilvy/
├── page.js                             入口（Suspense + OgilvyApp）
├── OgilvyApp.js                        顶层容器，三列网格 + 新建项目 ProductLinePicker 模态
├── ogilvy.module.css                   全部样式
├── hooks/
│   └── useMessageStream.js             SSE 订阅 + tool 并发进度汇总
└── components/
    ├── WhatsAppGateCard.js             账号未就绪拦截（Meta 账户级，不再做多号码选择器）
    ├── AdPlanCard.js                   计划卡片（核心）
    ├── AdCreativePreview.js            (2026-05 新) Facebook 信息流风格的单广告本地预览，pre-launch 用
    ├── StageArchive.js                 (2026-05 新) persist_stage_output 归档时间线，右栏顶端可折叠
    └── UsageBadge.js                   (2026-05 新) Claude Code statusline 风格 token / cost 浮标，停在 chat 区右下角
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
- 第二行：**产品线 chip**（monospace + accent-dim 背景，2026-05-17 新增）+ `国家 · 预算 · 相对时间`（"2 小时前"/"3/14"）

避免了老版本 "你好" / "hi" 这类零信息量标题。"新项目"按钮先弹 ProductLinePicker 强制选产品线（无可用 WA 号码的产品线置灰禁选），创建后 `product_line` 写入 `autopilot_sessions` 不可改。

### 6.3 聊天区

消息从 DB `autopilot_messages`（表名沿用旧名）顺序重放。`role=tool` 行默认不渲染——**唯一例外**是 `generate_ad_creative` 的成功 `tool_result`：把图片以 headline 作图说插进对话流，让用户在等方案落地的同时直接看到生成出的素材。其它工具（`draft_ad_plan` / `persist_stage_output` / `web_search` / `read_webpage`）仍隐藏。流式中：
- `delta` 累积成 `streamingText`，打字机效果
- `tool_call`/`tool_result` 聚合成 `toolStatus` 栏显示 "生成广告图 2/3…"（对 `generate_ad_creative` 特别优化 x/N 展示）
- `plan_partial` 进 `streamingPlan` state，右栏 AdPlanCard 优先显示它（partial > confirmed）

Composer：paperclip 上传（多图）+ 自适应 textarea + 发送/停止按钮互切。**UsageBadge 浮在 chat 区右下角**（composer 上方 ~56px 位置）：

- 显示 `latest.total_input / 1M ctx · pct% · cumulative_cost`，颜色 token：< 50% ok / < 80% warn / ≥ 80% danger
- 数据源 `/api/ogilvy/conversations/[id]/usage`，refreshKey 每次 streaming 结束 + 800ms 后 fetch（避开 llm-client.js 的 fire-and-forget 落表延迟）
- hover 弹 popover：当前 latest input 分量（prompt / cache_create / cache_read）+ 上轮 output + 上轮成本 + 累计成本 + `by_model` + `by_call_site`
- "当前上下文" 只看最近一次 `ogilvy.turn` 的 `total_input`（不混入 `web_search` / `read_webpage` 的独立短 prompt，否则 1M 占比读数会失真）

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

### 6.5 StageArchive（右列顶端，可折叠）

数据源 `autopilot_sessions.stage_outputs` jsonb 数组。倒序展示（最新在上），每条 `{id, label, summary, markdown, created_at}` 渲染成可折叠 item：collapsed 显示 label + 时间，expanded 显示 summary + 完整 markdown（用 `<Markdown>` 组件）。空时整个组件不渲染，避免无产出时占据右栏视觉权重。

跟 AdPlanCard 的关系：StageArchive 在上方，AdPlanCard 在下方。当模型还在产出阶段策划案时（draft_ad_plan 尚未触发），AdPlanCard 可能完全空白，StageArchive 已经在记录方案文本了——这能让用户在等终稿期间有东西可读。

### 6.6 AdCreativePreview（启动前 FB 信息流模拟）

`role="figure"`，单个 ad 在 Facebook 信息流里的本地预览。pre-launch 阶段没有 ad id 不能调 Meta Ad Preview API，所以用 CSS 手搓近似 — 目标是"用户能感知到这条创意上线后大概什么样"，不是像素级还原。

数据全部来自 `plan_json`：业务名 / 电话 → `plan.whatsapp.{verified_name, display_number}`，文案 → `ad.creative.{primary_text, headline}`，图 → `ad.creative.image_url`，CTA 锁死 "WhatsApp"。avatar 用 verified_name 首字母 + 字符串哈希定颜色。点击放大走 AdPlanCard 同一个 lightbox。

---

## 7. 性能与延迟优化

AI 轮询 + 图生成是延迟大头。交付顺序做了以下优化，把端到端从 2-4 分钟压缩到 40-70s：

| # | 优化 | 机制 | 实测 |
|---|---|---|---|
| 1 | **同轮 tool_calls 并行** | `Promise.all` + 事件队列，tool_call 事件按并发发出、tool_result 按到达顺序发出，最后按调用顺序持久化 | 3 张素材：60s → 20s |
| 2 | **Prompt 拆静/动 + cache_control** | system 拆两段，静态段标 `cache_control: ephemeral`，provider 固定 `anthropic`（避免 Bedrock 剥除 flag） | 命中时省 70%+ input tokens |
| 3 | **引用图索引化** | `reference_image_urls` → `reference_image_ids: [1,2]`，dispatcher 反解。完成 tokens 大幅下降；顺带杜绝"URL 幻觉"（曾胡编 Wikimedia URL） | 每 tool_call 省 ~400 tokens |
| 4 | **主对话锁 Sonnet 4.6（1M ctx）** | 早期按"上一条是否 tool_result"在 Sonnet / Haiku 间切，数据上暴露 Haiku 200K 灰区 + 双 prompt cache 浪费两个问题，回滚后单 prompt cache 命中率高；工具子调用 (`web_search` / `read_webpage`) 仍走 Haiku | 长会话不再触达 Haiku 200K 灰区 |
| 5 | **流式进度 + 渐进 plan** | `tool_call` 事件在 name 一到手就发（不等 args 满）；`plan_partial` 每 ~200 字试探性 `tryPartialJson()` 并 yield | 用户等待期间"看到字段在填" |
| 6 | **流看门狗** | `src/llm-client.js` 里 `STREAM_IDLE_TIMEOUT_MS=30s / STREAM_TOTAL_TIMEOUT_MS=180s`；任一超 → AbortController | 堵住之前 200s+ 僵死 |
| 7 | **长输出续写**（2026-05） | `max_tokens: 16384` 覆盖 17 章策划案 / 阶段五双文档；撞 `finish_reason='length'` 时把已生成内容压进 history + 合成"接着写"user 消息进入下一迭代，分片在内存中拼接、最终持久化为单条 assistant 消息 | 长方案不再被截断、不再切碎成多个气泡 |
| 8 | **历史压缩协议**（2026-05） | 长产出（10 章策划案 / 完整市场分析 / 阶段五双文档）由模型主动调 `persist_stage_output` 归档；下一轮历史里以 200 字 summary 替代原文。`stage_outputs` jsonb 持久化全文供 UI 回看 | session 不再因为 history 撑爆 200K context window 退化 |
| 9 | **References 全量内联**（2026-05） | `read_skill_reference` 下线，6 份 references 一次性拼入 `SYSTEM_STATIC` 末尾「附录」节内，吃 cache 命中价（0.1× input） | 单 turn 省一次工具往返 + ~5K tokens 重复 history 占位 |
| 10 | **Tavily search 主路径**（2026-05） | `web_search` 改 Tavily REST + session-scope 3h 缓存（25–35% 同义重查命中），Haiku fallback 保留 | 单次 search $0.02 → $0.005；session 内重查 0 成本 |

`listWhatsAppAccountsForUser` 60s 进程内缓存仍在；预热路径（`prewarmWhatsAppAccountsForUser`）已删——产品线绑定模型下不再需要全量列号码。

---

## 8. 成本与归因（2026-05）

LLM 用量埋点透过 [src/llm-client.js](../../llm-client.js) 的 `logLlmCall` 写入 `llm_usage_logs`，每次调用一行，含 `tenant_id / session_id / product_line / call_site / model / prompt_tokens / completion_tokens / cache_creation_input_tokens / cache_read_input_tokens / cost_usd`。Ogilvy 的所有 4 个 callSite 都会透传 `{tenantId, sessionId, productLine}`：

| call_site | 来源 | 单价量级 |
|---|---|---|
| `ogilvy.turn`        | 主对话（Sonnet 4.6）          | $0.003/K input × prompt + cache write/read，~$0.005-0.02/turn 稳态 |
| `ogilvy.web_search`  | Anthropic-Haiku fallback（仅当 Tavily 失败/未配置） | ~$0.02/q（Tavily 主路径不进表，直接走 Tavily 计费） |
| `ogilvy.read_webpage`| Anthropic-Haiku via OpenRouter | ~$0.01/url |
| `ogilvy.image-gen`   | OpenAI Images / Gemini fallback | $0.17 (gpt-image-1) / $0.03 (gemini)，用 `costUsdOverride` 灌进 cost_usd 列 |

两个聚合视图：

- **`/api/ogilvy/conversations/[id]/usage`**（per-session） → UsageBadge 数据源。详见 §5.3。
- **`/api/product-lines/[id]/cost-stats`**（per-product-line） → 「成本分析」tab 数据源（[app/(app)/product-lines/[id]/cost-stats/CostStatsTab.js](../../../app/(app)/product-lines/[id]/cost-stats/CostStatsTab.js)），按 `call_site` 前缀切两块：**medici 类**（`medici.qualify` / `kb.*` / `knowledge.teach.extract` / `contacts.profile.summary` / `report-generator.*`）+ **ogilvy 类**（`ogilvy.*` 全部 4 个），medici / ogilvy 平级展示。返回结构 `{medici, ogilvy, medici_prev, ogilvy_prev, volume}`，其中 ogilvy 段还会单独切出 `reasoning_usd / image_usd` 两个分桶（前者是 turn + web_search + read_webpage，后者就是 image-gen）。

**时间窗与 leadhub 共用** [lib/date-range-presets.js](../../../lib/date-range-presets.js)：`all / yesterday / 1d / 7d / 30d / 365d / custom`，北京时区 yesterday-aligned。`resolvePrevDateRange` 给上一窗的成本数字便于环比对比。

`volume` 跟成本一起返回 5 项：`conversations / msgs_in / msgs_out / leads_qualified / kb_docs`——前端能算"每条 qualified lead 成本"、"每个 KB 文档摊销"这类衍生指标。

Founder 视图 **`/admin/llm-usage`** 是全租户聚合（按 model / callSite / tenant 切）+ 时间窗，用于运维监控；它不切产品线。两套报表互补不替代。

---

## 9. 品牌（2026-04 refresh）

- Logo：`public/brand/prome-logo.png` (820×260 tight-cropped wordmark) + `public/brand/prome-mark.png` (单 P 标)
- 侧栏 hover 展开：collapsed 60px 仅 mark；expanded 240px 切全 wordmark；`.ni.active` 是灰底上的白色浮卡（阴影 + accent 色图标/文字）
- Theme tokens ([app/v5-theme.css](app/v5-theme.css))：
  - `--accent: #2563eb`（royal blue；老值是 FB 蓝 `#1877f2`）
  - `--bg: #f4f6fa`（冷调浅灰）
  - `--bg3: #eef4ff`（蓝调 hover surface）
  - `--r/--rl/--rxl: 8/10/14`（之前 6/8/12，整体更柔）
  - `--shadow`：两层柔 elevation（1px crisp + 3px halo）

---

## 10. 上线前清单

1. **Supabase SQL editor 跑 migration**：[2026-04-16-autopilot.sql](../../../supabase/migrations/2026-04-16-autopilot.sql)（建表）+ [2026-05-12-autopilot-soft-delete.sql](../../../supabase/migrations/2026-05-12-autopilot-soft-delete.sql) + [2026-05-13-llm-usage-cache-tokens.sql](../../../supabase/migrations/2026-05-13-llm-usage-cache-tokens.sql) + [2026-05-15-llm-usage-session-id.sql](../../../supabase/migrations/2026-05-15-llm-usage-session-id.sql) + [2026-05-16-autopilot-sessions-stage-outputs.sql](../../../supabase/migrations/2026-05-16-autopilot-sessions-stage-outputs.sql) + [2026-05-16-llm-usage-product-line.sql](../../../supabase/migrations/2026-05-16-llm-usage-product-line.sql) + [2026-05-17-autopilot-sessions-product-line.sql](../../../supabase/migrations/2026-05-17-autopilot-sessions-product-line.sql)
2. **回填脚本**（可选但建议）：`supabase/operations/2026-05-16-backfill-llm-usage-product-line.sql` + `supabase/operations/2026-05-17-backfill-ogilvy-product-line.sql`，让历史 ogilvy 会话和 LLM 调用都能正确挂回产品线，cost-stats 不丢历史
3. **确认 env**：
   - `META_SYSTEM_TOKEN`（需 `whatsapp_business_management` + `ads_management` + `business_management`）
   - `META_AD_ACCOUNT_ID`、`META_PAGE_ID`
   - `OPENROUTER_API_KEY`
   - `OPENAI_API_KEY`（gpt-image-1 主路径，缺了 Ogilvy 会直接 `config_missing` 拒绝出图）
   - `TAVILY_API_KEY`（强烈建议，web_search 主路径；缺了会自动回退到 Anthropic Haiku 5× 价格）
4. **首访 `/ogilvy`**：
   - 点"新项目" → ProductLinePicker 弹出，已绑 WA 号码的产品线可选
   - 侧栏 logo 显示为 Prome Engine；hover 展开显示 wordmark
5. **E2E 冒烟**：新项目（选产品线）→ "推广 XX 到 TH+ID，预算 $30/天" → 上传 1-2 张产品图 → 等 AI 出 plan → 期间观察 StageArchive 是否有阶段产出归档 → 右列 AdPlanCard 填满 → 点启动 → 卡片 staged → launched → 三级链接显现 → 去 Meta Business 确认三层都 ACTIVE / IN_PROCESS → 回 `/product-lines/[id]/cost-stats` 看本次 session 的 ogilvy 段成本是否切到对应产品线

---

## 11. 已知风险与短板

| 项 | 说明 | 处理 |
|---|---|---|
| SSE 不支持续传 | 刷新中断后，已持久化消息不丢；in-flight delta 丢失 | 可接受；未来加 Redis Stream + lastEventId |
| 素材生成失败 | 两段降级链（OpenAI gpt-image-1 → Gemini Flash Image）仍可能全败 | 错误透传，Agent 会建议重试或让用户手动上传产品图 |
| stage 部分失败 | 中途失败留下 orphan PAUSED 资源 | 目前透传错误让用户手动清理；未来加 rollback tool |
| 单租户 | env token 共享，多用户共用同一 Meta 账户 | 多租户接口已抽象 `getMetaAccountForUser(userId)`，未来换 OAuth + `user_meta_accounts` 表 |
| OpenRouter 路由抖动 | 偶尔路由到慢通道（曾见 15 tok/s） | 已 pin `provider: ['anthropic']`；再有问题 watchdog 30s idle 超时兜底 |
| 老表未清理 | `campaign_briefs` / `orchestrator_*` 冷冻存档 | 无新写入，零迁移；后续可定期归档到冷备 |
| product_line 历史空数据 | 2026-05-17 之前创建的会话 `product_line=NULL`，进 `runOgilvy` 会被 fail-safe 拦截 | 操作建议跑 backfill 脚本（RevoPanda 实测全部回填到 'vehicle'）；未回填的会话事实上不可用 |
| llm_usage_logs 老数据无 product_line | 2026-05-16 之前的调用 `product_line` 列为 NULL，cost-stats 看不到 | 同上，按时间窗反推回填；未回填部分挂在"未归属"桶里 |

---

## 12. 已清理的旧代码

PR 4 清理清单（已执行）：
- 删 `app/(app)/campaign-studio/ChatTab.js` + `CampaignStudioScreen` 里的 `ai` tab
- 删 `app/api/campaign/**`、`app/api/cron/recover-orchestrator/`、`app/api/aigc/`
- 删 `src/campaign-orchestrator.service.js` / `campaign-intake.service.js` / `research-agent*.service.js` / `strategy-agent.service.js` / `execution-agent.service.js` / `creative-plan.service.js` / `reference-collector.service.js` / `aigc.service.js`（核心能力已内联到 `src/agents/ogilvy/creative.service.js`）
- 删 `lib/repositories/campaign-brief.repository.js` / `orchestrator.repository.js` / `fix-knowledge.repository.js`
- 保留 `src/meta-account.service.js` / `src/meta-ads-mcp-client.js`（新路径继续用）
- Supabase 老表不 drop，冷冻存档

2026-05 又清掉一批：

- 删 `read_skill_reference` 工具的 schema + dispatcher 分支（[index.js](./index.js) 头部注释保留删除原因）
- 删 `prewarmWhatsAppAccountsForUser`（产品线绑定模型下不再需要预热全量号码列表）
- 删 stage-aware 模型路由分支（主对话锁 Sonnet 后这套逻辑没意义）

净删约 6000+ 行遗留代码，Ogilvy 核心 service 文件加 `src/agents/skills-runtime/` 合计 ~50KB。

---

## 13. 参考

线上 CTWA 广告参考（字段对齐用）：
- ad: `120243642837920034`
- campaign: `120235612159890034`
- objective / optimization_goal / destination_type / CTA / promoted_object 全部与本系统产出一致
