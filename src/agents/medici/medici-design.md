# Medici · 智能客服接待 Agent · 产品 & 工程设计

`src/agents/medici/` — WhatsApp 询盘的接待官。每条客户消息进来，它同时完成**回复客户**、**分类意图**、**评估商机**、**抽取线索**、**决定路由**这五件事。

> 文档版本：2026-05-14（envelope 真源收口到 `output-schema.js::buildEnvelopeSchema`；references 收敛到模型实际用的 5 份；dev-only 验收/测试场景挪出 bundle；CONTRACT 删除 marketplace 包装）

---

## 1. 产品定位

一句话：**一次 LLM 调用，从一条 WhatsApp 消息同时产出"回给客户的话 + 线索结构 + 给销售的判断"**。

Medici 是 LeadHub 询盘流水线的"大脑"。它不关心：
- 消息怎么到的（Webhook / 队列聚合是 [queue-processor](../../../lib/queue-processor.js) 的事）
- 人工接管判断（queue-processor 在它上游判掉）
- 未绑定号码的兜底回复（Strategy C，queue-processor 拦截）
- 响应发不发得出去、线索写不写得进库（queue-processor 在它下游处理）

它只关心：**给我一条或一批客户消息 + 这条号码对应的 product_line 配置，我返回一份结构化 JSON**。

### 为什么叫 Medici

美第奇家族——佛罗伦萨银行家兼外交家，用同一段对话同时做生意和谈判。Medici Agent 每次调用同时**回应客户**（外交）和**评估商机**（银行），恰好对得上。

---

## 2. 在流水线中的位置

```
 WhatsApp Webhook
      │
      ▼
 message_queue  (DB，SKIP LOCKED 并发保护)
      │
      ▼
┌──────────────────────── queue-processor ─────────────────────────┐
│  1. acquire pending messages                                     │
│  2. 人工接管检查 → 早退                                           │
│  3. 聚合消息内容                                                  │
│  4. loadMediciConfig(conversation) → agentConfig                   │
│  5. 未绑定号码 → Strategy C 早退                                  │
│  6. 构造 contextInfo（missing_fields / prior_state / 广告素材等） │
│  ──────────────────────                                          │
│  7. ★ runMedici({ history, input, context, agentConfig, trace }) │
│  ──────────────────────                                          │
│  8. processMessageForConversation (写 message + lead)            │
│  9. sendMessage → WhatsApp                                       │
│ 10. executeConversationRouting（非 CONTINUE 时）                  │
│ 11. markAsCompleted                                              │
└──────────────────────────────────────────────────────────────────┘
```

Medici = 第 7 步。**前 1-6 为它准备输入，后 8-11 消化它的输出**。

---

## 3. 调用契约

唯一入口：`runMedici(opts)` 来自 [index.js](./index.js)。详尽 TS 类型见 [types.md](./types.md)。

### 输出 envelope

字段 / 枚举 / required 真源在 [output-schema.js](./output-schema.js)（`buildEnvelopeSchema` + `ENVELOPE_REQUIRED` + `*_ENUM`）。skill 阶段 → `inquiry_quality` / `route` 的映射、特殊路由、attachments 规则真源在 [skill-host-patch.md](./skill-host-patch.md) §3 / §5 / §7。

简单概览：`{ conversation_intent, conversation_intent_summary, inquiry_quality, business_value, leads, route, next_message, handoff_summary, attachments }`。`leads[]` 字段集由 product_line 的 `output_schema` 决定，非标字段自动落到 `lead.details`。

### 不变量

- **每轮必须以一次 `submit_response` tool call 结束**。即使模型没调任何 KB 工具，也必须通过这个工具返回结构化输出。纯文本助手回复一律被丢弃。
- **`agentConfig.dynamic_injection` 必填**。缺了就抛 `Error`——未绑定号码应该在上游被 Strategy C 拦掉，进到 Medici 本身就说明调用方漏了解析。
- **Medici 不写库**。持久化完全是调用方的责任。方便单元测试 / dev-tools/medici-simulator 做零副作用演练。

---

## 4. 内部架构

```
src/agents/medici/
├── index.js                ★ Agent 运行时（~600 行，一眼扫完）。分段用 ───── 注释分割：
│                              · Constants
│                              · Skill bundle + host patch (loaded once)
│                              · Prompt assembly        (buildPriorStateLines / buildDynamicContext / buildSystemBlocks)
│                              · Messages (multimodal)  (buildClaudeContent / buildMessages / markHistoryForCache)
│                              · Tools                  (loadAgentTools / READ_SKILL_REFERENCE_TOOL / buildSubmitResponseTool)
│                              · LLM transport          (callClaude / safeParseJson)
│                              · Post-process           (normalizeAgentResponse / stripEmptyStringFields)
│                              · Orchestrator           (runMedici)
│                              · Tool dispatcher        (dispatchTool — 路由到 read_skill_reference / KB 工具)
├── skill-host-patch.md    ★ 宿主收口 prose。skill 是通用方法论，本补丁把它校准到 LeadEngine：
│                              envelope 形状、阶段→quality/route 映射、工具白名单、转人工底线
├── config.js               product_line 行 → agentConfig 装配 + 60s 缓存：
│                              · assembleDynamicInjection         (row → 动态注入字段包)
│                              · assembleOutputSchema             (row → submit_response input_schema)
│                              · assembleQualificationConfig
│                              · assembleLineConfig               (合三为一)
│                              · getMediciConfig / invalidateMediciCache  (60s 缓存)
│                              · loadMediciConfig(conversation)   (queue-processor 入口)
├── output-schema.js        GENERIC_LEAD_OUTPUT_SCHEMA + envelope enums (INTENT / INQUIRY_QUALITY /
│                              BUSINESS_VALUE / ROUTE / ENVELOPE_REQUIRED) + resolveOutputSchema
├── kb-tools.js             KB tool 适配器（包装外部共享的 kb-search.service.js）
├── send-attachments.js     attachments[] → WhatsApp 图片发送（queue-processor 调）
├── medici-design.md        本文
└── types.md                运行时契约（TS 类型 + invariants + "我想改 X 去哪个文件" 对照表）

skills/
├── ai-reception-deal/                  ★ skill bundle（目录形态）：通用 AI 接待谈单方法论
│                                          内含 SKILL.md + references/{stages-definition,
│                                          kb-usage-rules, tool-priority-rules, handover-rules,
│                                          response-style}.md
├── ai-reception-deal.CONTRACT.md       PM/RD 契约（接口约束）
├── ai-reception-deal.ACCEPTANCE.md     dev-only 最小验收集
└── ai-reception-deal.TEST-SCENARIOS.md dev-only 典型测试场景
```

**设计原则**：Agent 运行时一整套逻辑放一个文件（index.js），一眼能扫完整流程——
模仿 [Ogilvy](../ogilvy/ogilvy-design.md) 的做法。拆成 sidecar 只在以下情况：

- **方法论 prose**（`skills/ai-reception-deal/`）—— PM 维护的业务规则包，不进代码 review；可热替换
- **宿主收口 prose**（`skill-host-patch.md`）—— RD 维护，把 skill 校准到 LeadEngine 的 envelope / 工具 / 路由
- **纯数据常量**（`output-schema.js`）—— 塞进 index.js 会压垮阅读体验
- **配置装配层**（`config.js`）—— DB 行 → agentConfig 的纯转换 + 缓存，被 queue-processor 和 /product-lines 后台 UI 共同消费
- **独立工具服务**（`kb-tools.js` / `send-attachments.js`）—— 外部数据层接入

### 4.1 系统 prompt 三段拼装

```
SYSTEM_STATIC = SKILL.systemPrompt      ← skills/ai-reception-deal/ bundle
              + '\n---\n'
              + HOST_PATCH               ← skill-host-patch.md
   ↑ cache_control: ephemeral，所有 product_line 共享同一份缓存

SYSTEM_DYNAMIC = buildDynamicContext({
   injection: agentConfig.dynamic_injection   ← 由 product_lines 行装配
              · LINE_NAME / CATALOG_DESCRIPTION / DOMAIN_GLOSSARY
              · BUSINESS_VALUE_GUIDANCE / MESSAGE_STYLE_EXAMPLES
              · LEAD_FIELDS_HINTS / GOOD/QUALIFY/PROOF_FIELDS
   missing_fields, prior_state            ← 当前会话上下文
   ad_referral                            ← 客户点的 Meta 广告
   available_assets                       ← kb_assets is_sendable=true 的图
})
   ↑ 不缓存，每轮都新鲜
```

**为什么是这种分层**：CONTRACT.md（aaa 包随附）明确要求 skill 不得把 `BUSINESS_VALUE_GUIDANCE / LEAD_FIELDS_HINTS / CURRENT KNOWN FIELDS / CURRENT MISSING FIELDS / PRIOR STATE` 写死到自身文本——这些必须由宿主动态注入。本架构正好满足。

### 4.2 单次调用数据流

```
runMedici(opts)
  │
  ├─ 1. buildMessages(history, input)
  │     └─ 每条 msg 走 buildClaudeContent：
  │        · text 直出
  │        · WhatsApp 图片 metadata → downloadWhatsAppMediaBuffer → base64 内联
  │     └─ markHistoryForCache：给最后一条 history 打 cache_control
  │
  ├─ 2. resolveOutputSchema(agentConfig)   ← agent 自定义优先，否则 GENERIC
  │
  ├─ 3. loadAgentTools({ tenantId, productLineId })
  │     └─ buildKbTools (./kb-tools.js)
  │     KB 表已加 product_line_id 列，按 (tenant_id, product_line_id) 直接索引
  │
  ├─ 4. loadAvailableAssets({ tenantId, productLineId })
  │     └─ kb_assets where is_sendable=true
  │
  ├─ 5. tools = [...agentTools, READ_SKILL_REFERENCE_TOOL, submit_response]
  │     最后一个工具打 cache_control: ephemeral
  │
  ├─ 6. buildDynamicContext({ injection, missing_fields, prior_state, ad_referral, available_assets })
  │     └─ buildSystemBlocks(SYSTEM_STATIC, dynamicContext)
  │        [0] SKILL + HOST_PATCH        cache_control: ephemeral  (缓存)
  │        [1] 动态 context              (不缓存，每轮都新鲜)
  │
  ├─ 7. ★ Tool-use 循环（runMedici 内联，见 4.3）
  │
  └─ 8. 输出归一化（runMedici 内联）
        ├─ 自定义 schema → normalizeAgentResponse
        │  · agent-specific 字段名 → canonical DB 列 + 非标列字段存进 details JSONB
        └─ 全部 lead 去掉 "" 字段
```

### 4.3 tool-use 循环

```
callClaude(tools, tool_choice: auto)
  │
  ├─ finish_reason === 'tool_calls' ?
  │    ├─ toolCalls 含 submit_response → parsed = args，break（本轮结束）
  │    │
  │    └─ 否则：Promise.all 并行跑本轮全部 tool_calls
  │         → dispatchTool(name, input, ctx)
  │         · read_skill_reference → SKILL.references.get(name)
  │         · 6 个 KB typed tools (lookup_product / quote_price /
  │           lookup_shipping / lookup_policy / find_asset / check_constraint)
  │           → executeKbTool(...)（带 gap-capture 包装）
  │         每次触发 onToolEvent({type:'tool_call' / 'tool_result', ...})
  │         结果按调用顺序拼到 messages
  │         再次 callClaude
  │
  └─ 循环上限 MAX_TOOL_ITERATIONS = 5
       超限/模型自己停了 → force-submit 兜底
       （附一条 "please submit" user 消息 + tool_choice 锁死 submit_response）
       再失败 → throw
```

### 4.4 工具清单

| # | 工具 | 注册条件 | 职责 |
|---|---|---|---|
| 1 | `submit_response`     | 永远 | 产出最终结构化 JSON（envelope） |
| 2 | `read_skill_reference`| 永远 | 按需读 skill 的 references/*.md（stages-definition 等 8 份） |
| 3 | `lookup_product`     | KB 有任意活跃数据 | 按 SKU / 型号 / 属性查产品 |
| 4 | `quote_price`        | 同上 | 精确报价（FOB / CIF / DDP，含边界检查）|
| 5 | `lookup_shipping`    | 同上 | 目的港运费 / 船期 |
| 6 | `lookup_policy`      | 同上 | 政策 / 资质 / 公司 / 销售话术；free_text 触发 Q&A snippet |
| 7 | `find_asset`         | 同上 | 找图（tag 优先 + caption 语义兜底）|
| 8 | `check_constraint`   | 同上 | 议价 / 让步 / 非标付款边界检查 |

#### `submit_response` —— 强制收尾工具

- **input_schema** = 当前 product_line 的 `output_schema`（由 `lead_fields` 装配）
- **forcer**：跑满 5 轮还没调它 → 附 `"Please call submit_response..."` user 消息 + `tool_choice: {type:'tool', name:'submit_response'}` 硬锁
- **为什么要它**：统一下游输出形状——`queue-processor` / `lead.repository` 永远拿到 schema 校验过的 JSON

#### `read_skill_reference` —— skill references 按需取用

- **可用名字**：`stages-definition` / `kb-usage-rules` / `tool-priority-rules` / `handover-rules` / `response-style`
- **dispatcher**：`SKILL.references.get(name)`，找不到时返回 `{error: 'reference_not_found', available: [...]}`
- **为什么按需取**：把 5 份 reference 全塞进 system prompt 会多 ~5K tokens × 每轮，按需取只在该会话用到时才付一次成本（且会进入 tool_result history 缓存）
- **真实命中率值得观察**：cache 命中后 1 token ≈ 0.1 token 计价，全 inline 稳态约 +500 tokens/轮。若平均每会话拉 ≥3 份 references，应改为全 inline；用 `/medici-simulator` 的 trace 统计后再决定

#### 6 个 KB typed tools

注册见 [kb-tools.js](./kb-tools.js)，实现见 [src/kb-tools.service.js](../../kb-tools.service.js)。每个工具返回 typed result：成功带结构化数据，失败有明确语义（`not_found` / `missing_fields` / `needs_human` / `unknown`）—— medici 做 if-else 决策，不评估相似度。

`executeKbTool` 包装层在每次 tool 返回 "no" 结果时回写 `kb_knowledge_gaps`（按 question_signature 聚合，参见 [src/kb-gaps.service.js](../../kb-gaps.service.js)）。

`lookup_policy({free_text})` 会先搜 `kb_qa_snippets`（销售自填的 Q&A），命中阈值 0.75，没命中再走四层向量检索。Q&A snippet 由 QaTab 维护，纠正建议（LearningTab）也会落到这里。

### 4.5 Prompt Cache 策略

| 块 | cache_control | 失效时机 |
|---|---|---|
| `system[0]` SKILL + HOST_PATCH | ephemeral | skill bundle 替换或 host-patch.md 修改后重启进程 |
| `system[1]` 动态 context | — | 每轮都变，从来不缓存 |
| `tools[*]` | 只最后一条打 | tool 列表变化时 |
| `messages[history]` 末尾 | ephemeral | 每次请求自然前推 |

prompt cache 是 Anthropic 原生机制。`callClaude` 用 `provider: { order: ['anthropic'], allow_fallbacks: false }` 锁住——Bedrock 会剥离 `cache_control`，所以**不能 fallback**。

---

## 5. skill bundle 维护

`skills/ai-reception-deal/` 是目录形态，结构与 Ogilvy 一致：

```
ai-reception-deal/
├── SKILL.md
└── references/
    ├── stages-definition.md
    ├── kb-usage-rules.md
    ├── tool-priority-rules.md
    ├── handover-rules.md
    └── response-style.md
```

PM 直接编辑目录下的 markdown → 重启 Next.js 服务即生效（[skills-runtime/loader.js](../skills-runtime/loader.js) 在进程内模块级缓存）。

PM 与 RD 的接口契约见 [`skills/ai-reception-deal.CONTRACT.md`](../../../skills/ai-reception-deal.CONTRACT.md)：
- skill 负责方法论（阶段定义 / KB 使用规则 / 转人工原则）
- 宿主负责工程（envelope schema / 工具注册 / 动态注入 / 路由 / 持久化）
- skill 不得把 `BUSINESS_VALUE_GUIDANCE / LEAD_FIELDS_HINTS` 写死，必须接受宿主动态注入
- dev-only 制品（验收集 / 测试场景）住在 bundle 之外的 sibling 文件，不进 references/，模型不读

---

## 6. 知识库（Knowledge Base）

Medici 的 6 个 KB typed tools 吃的就是这里的数据。KB 是 **(tenant_id, product_line_id)-scoped**——所有 `kb_*` 表都有这两列。运营在 `/product-lines/[id]` 的「知识库」tab 里维护，单文件 [KnowledgeBaseTab.js](../../../app/(app)/product-lines/[id]/knowledge-base/KnowledgeBaseTab.js) 顶部用 segmented control 切三段：

- **总览** — 健康度 + 各层覆盖度 + 知识盲区 chip + 复核队列待处理数
- **录入** — 3 张卡：文件上传（PDF/docx + xlsx 模板自动分流）/ 对话式（两步：抽取 → 确认入库）/ 单独图片上传
- **内容** — 已有文档 / Q&A / 图片资产三张列表

2026-05-06 把"录入"从 5 卡瘦到 3 卡：删了独立的 Q&A 直填卡（改在"内容 → Q&A"里直接编辑）和独立的 Excel 模板卡（合并进文件上传）。对话式录入拆成 `/api/knowledge/teach`（LLM 抽取，不落库）+ `/api/knowledge/teach/commit`（用户确认后落库），让运营在按下入库前能看到要写哪些条目。

2026-05-08 进一步放宽录入：不再要求严格 Excel 模板（已删 `/api/knowledge/import-template`、`/api/knowledge/template/[kind]`、`kb-excel-template.service.js`）。所有上传统一走 LLM 抽取——产品 / 物流层会同时跑一遍结构化抽取塞 `kb_products` / `kb_shipping_routes`，但任意列名 / 缺字段 / 自然语言文本都接受，缺信息时字段保持 NULL，不会拒收行。同步把分类学从 6 层（company / product / logistics / compliance / sales / competitive）合并为 4 层（company / product / logistics / sales）：旧的「合规与认证」归到 company，「竞品情报」归到 sales。`kb_documents.layer` / `kb_knowledge_points.layer` 的 CHECK 约束沿用旧六值不动以兼容历史数据，应用层只放行四层；存量行用 [migrations/2026-05-08-kb-collapse-to-four-layers.sql](../../../supabase/migrations/2026-05-08-kb-collapse-to-four-layers.sql) relabel 一次。

### 6.1 数据模型

| 表 | 存什么 | 写入方 | 读取方 |
|---|---|---|---|
| `kb_documents` | 上传的源文件元数据（filename、layer、status、storage_path） | `/api/knowledge/upload` | 总览 health + 内容 → 已有文档 |
| `kb_knowledge_points` | 文档切块后的双语文本 + 两条 embedding；带 `confidence`（verified / extracted_high / extracted_low） | upload + teach/commit | `lookup_policy` 兜底向量检索 + 总览分层统计 |
| `kb_products` | 结构化商品行；带 `effective_date / expiry_date / confidence / source_doc_id` | LLM 抽取（任意上传文件，宽松 schema） | `lookup_product` / `quote_price` |
| `kb_shipping_routes` | 结构化运费路由；同样的 validity/confidence 列 | LLM 抽取（任意上传文件，宽松 schema） | `lookup_shipping` / `quote_price` CIF/DDP 分支 |
| `kb_pricing_rules` | 议价 / 折扣 / 付款条款规则 | 当前没 UI 直填，可由 SQL 维护 | `check_constraint` |
| `kb_qa_snippets` | 销售自填 Q&A（多种问法 + 标准答 + 适用条件） | 内容 → Q&A 列表内联编辑 | `lookup_policy({free_text})` 命中阈值 0.75 |
| `kb_assets` | 可对外发送的图片 + 结构化标签（type / view / color / scenario / linked_skus） + caption_embedding | 录入 → 单独图片上传 + 文件上传时从 PDF/docx 自动抽取嵌入图（vision caption） | `find_asset` (tag 优先，semantic 兜底) |
| `kb_pending_review` | 低置信抽取 / 冲突写入隔离队列 | upload pipeline 抽取冲突时入队 | 总览复核入口 + `/api/knowledge/pending-review` |
| `kb_knowledge_gaps` | medici 答不上的问题，按 question_signature 聚合 | `executeKbTool` 自动回写（gap-capture）| 总览盲区 chip + `/api/knowledge/gaps` |
| `kb_corrections` | 销售改写过的 medici 回复 → 建议采纳为 Q&A | `/api/knowledge/corrections` POST | 总览纠正入口 |

**四层分类学**：`company / product / logistics / sales`。旧的 `compliance` / `competitive` 已合并到 company / sales（详见 [migrations/2026-05-08-kb-collapse-to-four-layers.sql](../../../supabase/migrations/2026-05-08-kb-collapse-to-four-layers.sql)）。

### 6.2 增 / 删 / 查

详见 [/api/knowledge/*](../../../app/api/knowledge) 实现。本文不再展开（与本次 skill 迁移无关）。

### 6.3 图片资产（被动外发）

Medici 在客户主动要图时回传知识库里的图片，例如"能看下实物吗？" / "再来一张图"。

- **入库**：录入 → 单独图片上传 → `POST /api/knowledge/assets`；文档上传管线也会自动从 PDF/docx 抽取嵌入图（vision caption + 入库为 kb_assets），运营基本不用单独传
- **注入**：`runMedici` 启动时与 `loadAgentTools` 并行调 `loadAvailableAssets`，把 `[{id, description, mime_type}]` 写进 `dynamicContext` 的 AVAILABLE ASSETS 块
- **发送**：Medici 在 `attachments[]` 给出 `{asset_id, caption?}` → queue-processor 文本回复发完后调 [send-attachments.js](./send-attachments.js)

被动策略：默认不发图，只有客户明确请求才挑 asset_id。

---

## 7. "我想改 X，去哪个文件"

| 场景 | 改哪里 |
|---|---|
| 通用接待方法论（阶段定义 / 转人工规则 / KB 使用规则） | `skills/ai-reception-deal/` 内的 SKILL.md / references/*.md（PM owned） |
| 宿主收口（envelope 字段、阶段映射、工具白名单） | `skill-host-patch.md` |
| 提示词文案（某产品线的目录 / 业务价值口径 / 字段说明） | `/product-lines/[id]` 后台 UI |
| 通用 lead schema 加字段 | `output-schema.js::GENERIC_LEAD_OUTPUT_SCHEMA` |
| 某产品线独有字段 | `/product-lines/[id]` → `lead_fields` JSON |
| 加 per-turn dynamic context 字段 | `index.js` → Prompt assembly 段的 `buildDynamicContext` |
| 加图 / 语音 / 文件等模态 | `index.js` → Messages 段的 `buildClaudeContent` |
| 加新的 KB tool | `kb-tools.js`（底层加到 `src/kb-search.service.js`） |
| 改配置缓存 TTL | `config.js` 里 `TTL_MS` |
| 加新的 lead_field 类型 | `config.js::leadFieldToJsonSchemaProp` |
| 改 per-conversation 配置解析 | `config.js::loadMediciConfig` |
| 换模型 / 改超时 / 改重试 | `index.js` → LLM transport 段 |
| 有新的 legacy 输出格式要兼容 | `index.js` → Post-process 段的 `normalizeAgentResponse` |
| 改整体编排顺序 | `index.js` → Orchestrator 段 |

---

## 8. 测试

### 端到端冒烟

dev-tools 里的 **Medici 调试台** (`/medici-simulator`) 直接调 `runMedici`，全流程同生产但零 DB 写入。每次改 skill / 改 host-patch / 改提示词 / 改 tool / 改输出形态都先在这里过一遍再发。

路由：`app/api/medici-simulator/send/route.js` → `runMedici({...})`。

**Tool 可视化**：simulator 调 `runMedici` 时注入 `onToolEvent` 回调，把每次 tool_call（含入参）和 tool_result（截断后的返回）插进 trace 数组，前端用蓝/绿色高亮显示。运营 / RD 可以直接看到 Claude 调了哪些 KB 工具、查了什么、命中了什么。

---

## 9. 性能 & 成本

| 指标 | 数量级 |
|---|---|
| 一次 runMedici 延迟 | 1.5–4s（直接 submit_response）· 3–8s（有 KB tool 调用，视迭代次数） |
| input tokens | 典型 3k–7k（SKILL + HOST_PATCH ~10K，缓存命中后 ~500；history 10-20 条） |
| output tokens | ≤ 4096 (`MAX_TOKENS`) |
| 缓存命中率 | 静态段稳定状态下 > 80%（Sonnet 缓存价格 = input 的 10%） |
| 模型 | `claude-sonnet-4-6`（固定，`callClaude` 里） |

`callClaude` 透传 `{ tenantId, callSite: 'medici.qualify' }` 给 [llm-client.js](../../llm-client.js)，每次调用 fire-and-forget 落 `llm_usage_logs` 一行（input / output / cache hit tokens + 计价）。Founder 在 `/admin/llm-usage` 看按租户 / callSite / 模型聚合的成本（今日 / 7天 / 30天）。

成本优化点都收敛在 `index.js` 的 LLM transport 段：换 Haiku、分拆合成轮、调低 `MAX_TOKENS`。

---

## 10. 一次迭代需要哪些人

- **改产品话术**（某产品线）→ 运营在 `/product-lines/[id]` UI 改，60s 内生效，不需要 RD
- **改方法论**（阶段定义 / 转人工规则）→ PM 直接编辑 `skills/ai-reception-deal/` 下的 SKILL.md / references → 重启服务
- **改宿主收口**（envelope / 工具白名单 / 阶段映射）→ RD 改 `skill-host-patch.md` → 重启服务
- **加字段 / 改分类逻辑** → RD 改 `lead_fields` schema 或 `index.js` 的 Prompt assembly 段
- **加工具** → RD 写新方法到 `kb-tools.js`，`index.js` 的 `dispatchTool` 自动带上
- **换模型 / 改架构** → 全在 `index.js`，分段注释找到对应段

**契约稳定的好处**：queue-processor、session.js、lead.repository.js 都不需要因 Medici 内部变化而改。改 Medici 的人只要保证 `runMedici` 的输出 envelope 形状不变，下游自动跟上。
