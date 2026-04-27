# Medici · 智能客服接待 Agent · 产品 & 工程设计

`src/agents/medici/` — WhatsApp 询盘的接待官。每条客户消息进来，它同时完成**回复客户**、**分类意图**、**评估商机**、**抽取线索**、**决定路由**这五件事。

> 文档版本：2026-04（从 `src/claude.service.js` 抽离 → 拆 7 文件 → 合并为 4 文件的当前形态）

---

## 1. 产品定位

一句话：**一次 LLM 调用，从一条 WhatsApp 消息同时产出"回给客户的话 + 线索结构 + 给销售的判断"**。

Medici 是 LeadHub 询盘流水线的"大脑"。它不关心：
- 消息怎么到的（Webhook / 队列聚合是 [queue-processor](../lib/queue-processor.js) 的事）
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

唯一入口：`runMedici(opts)` 来自 [src/agents/medici/index.js](../src/agents/medici/index.js)。

### 输入

```ts
{
  history:      Array<StoredMessage>      // 之前的对话，旧到新
  input:        string | StoredMessage | Array<StoredMessage>
                                          // 最新用户输入。单条文本 / 带 metadata
                                          // 的单条 / 队列聚合的多条
  context?: {
    missing_fields?: string[]             // 本线还缺哪些 lead 字段
    prior_state?: {                       // 上一轮的分类快照——阻止模型随便降级
      conversation_intent?: string[]
      inquiry_quality?:  'BAD' | 'GOOD' | 'QUALIFY' | 'PROOF'
      business_value?:   'LOW' | 'AVERAGE' | 'HIGH'
      car_model?: string; qty_bucket?: string
      destination_country?: string; company_name?: string
    }
    car_recommendation?: string           // 关键词命中的车型目录提示
    ad_referral?:        string           // 客户点进来的 Meta 广告素材
  }
  agentConfig: {                          // 必填——product_line 已解析好的配置
    tenant_id: string                     // 必填。KB 工具按 (tenant_id, product_line) 索引
    product_line: string                  // 必填。slug，等于 product_lines.id
    system_prompt: string                 // 必填。缺了直接抛
    output_schema?: object                // 可选，缺则用 GENERIC_LEAD_OUTPUT_SCHEMA
    qualification_config?: object
  }
  trace?: { traceId?: string; conversationId?: string; waId?: string }
}
```

### 输出

无论走哪条代码路径，信封结构完全一致：

```ts
{
  conversation_intent:        Array<'personal_consumer' | 'business_inquiry' |
                                    'business_cooperation' | 'other'>
  conversation_intent_summary: string
  inquiry_quality:            'BAD' | 'GOOD' | 'QUALIFY' | 'PROOF'
  business_value:             'LOW' | 'AVERAGE' | 'HIGH'
  leads:                      Array<Lead>   // 字段由 product_line 的 output_schema 决定
                                            // 非标字段自动落到 lead.details
  route:                      'CONTINUE' | 'HUMAN_NOW' | 'FAQ_END'
  next_message:               string        // ≤180 字符，WhatsApp 口吻
  handoff_summary:            string        // 转人工时给销售的一段话
  attachments:                Array<{       // 要随回复发出的图片资产
    asset_id: string                        //   kb_assets.id（来自动态上下文里的
    caption?: string                        //   AVAILABLE ASSETS 列表）
  }>
}
```

> `attachments` 的发送由 [queue-processor](../../../lib/queue-processor.js) 在文本回复之后逐条调
> `sendMediciAttachments` 完成。Medici 自身不发 WhatsApp 消息，只负责"决定是否要发图、发哪张"。被动策略：
> 没明确请求图就保持 `attachments: []`。详见 §5。


### 不变量

- **每轮必须以一次 `submit_response` tool call 结束**。即使模型没调任何商品/KB 工具，也必须通过这个工具返回结构化输出。纯文本助手回复一律被丢弃。
- **`agentConfig.system_prompt` 必填**。缺了就抛 `Error`——未绑定号码应该在上游被 Strategy C 拦掉，进到 Medici 本身就说明调用方漏了解析。
- **Medici 不写库**。持久化完全是调用方的责任。方便单元测试 / dev-tools/medici-simulator 做零副作用演练。

---

## 4. 内部架构

```
src/agents/medici/
├── index.js           ★ Agent 运行时（~600 行，一眼扫完）。分段用 ───── 注释分割：
│                         · Constants
│                         · Prompt assembly        (resolveSystemPrompt / buildDynamicContext / buildSystemBlocks)
│                         · Messages (multimodal)  (buildClaudeContent / buildMessages / markHistoryForCache)
│                         · Tools                  (loadAgentTools / buildSubmitResponseTool / markLastToolForCache)
│                         · LLM transport          (callClaude / safeParseJson)
│                         · Post-process           (normalizeAgentResponse / stripEmptyStringFields)
│                         · Orchestrator           (runMedici — 含 tool-use loop 内联)
├── config.js          Medici 的 agentConfig 装配 + 60s 缓存 + per-conversation 解析：
│                         · assembleSystemPrompt / assembleOutputSchema / assembleQualificationConfig
│                         · assembleLineConfig                                  (row → agentConfig)
│                         · getMediciConfig / invalidateMediciCache             (60s 缓存)
│                         · loadMediciConfig(conversation)                      (queue-processor 入口)
├── base-prompt.js     BASE_PROMPT_TEMPLATE + 各种 enum 常量（纯数据，158 行模板文本）
├── output-schema.js   GENERIC_LEAD_OUTPUT_SCHEMA + resolveOutputSchema（纯数据）
├── kb-tools.js        KB tool 适配器（包装外部共享的 kb-search.service.js）
├── types.md           契约文档 + "我想改 X 去哪个文件" 对照表
└── __tests__/
    ├── internals.test.js      （prompt + post-process 纯函数测）
    ├── config.test.js         （assemble 的四个契约）
    └── output-schema.test.js
```

**设计原则**：Agent 运行时一整套逻辑放一个文件（index.js），一眼能扫完整流程——
模仿 [Ogilvy](ogilvy-design.md) 的做法。拆成 sidecar 只在以下三种情况：

- **纯数据常量**（`output-schema.js` / `base-prompt.js`）——塞进 index.js 会压垮阅读体验；
- **配置装配层**（`config.js`）——DB 行 → agentConfig 的纯转换 + 缓存，被 queue-processor
  和 /product-lines 后台 UI 共同消费，跟 agent 运行时是不同的生命周期；
- **独立工具服务**（`kb-tools.js`）——Medici 调用的外部数据层接入（包装共享的
  `kb-search.service.js`，后者被 `/api/knowledge/*` 也复用）。

### 4.1 单次调用数据流

```
runMedici(opts)
  │
  ├─ 1. buildMessages(history, input)
  │     └─ 每条 msg 走 buildClaudeContent：
  │        · text 直出
  │        · WhatsApp 图片 metadata → downloadWhatsAppMediaBuffer → base64 内联
  │     └─ markHistoryForCache：给最后一条 history 打 cache_control
  │        (后续请求里，从这条往前的全部走 Anthropic prompt cache)
  │
  ├─ 2. resolveSystemPrompt(agentConfig)   ← 必填，缺则抛
  ├─ 3. resolveOutputSchema(agentConfig)   ← agent 自定义优先，否则 GENERIC
  │
  ├─ 4. buildSystemBlocks(prompt, dynamicCtx)
  │     └─ 两块：
  │        [0] 静态产品线 prompt    cache_control: ephemeral  (缓存)
  │        [1] 动态 context         (不缓存，每轮都新鲜)
  │
  ├─ 5. loadAgentTools({ tenantId, productLineId })
  │     └─ buildKbTools (./kb-tools.js，包装外部 src/kb-search.service.js)
  │     KB 表已加 product_line_id 列（见 §9 已修复 #13），按
  │     (tenant_id, product_line_id) 直接索引，无中间 UUID 桥
  │
  ├─ 6. ★ Tool-use 循环（runMedici 内联，见 4.2）
  │     tools = [...agentTools, submit_response]，每轮必以 submit_response 收尾
  │
  └─ 7. 输出归一化（runMedici 内联）
        ├─ 自定义 schema → normalizeAgentResponse
        │  · agent-specific 字段名 → canonical DB 列 + 非标列字段存进 details JSONB
        │  · 这是 product_line 自定义 lead_fields 落库的兜底
        └─ 全部 lead 去掉 "" 字段
```

### 4.2 tool-use 循环（直接写在 runMedici 函数体内）

```
callClaude(tools, tool_choice: auto)
  │
  ├─ finish_reason === 'tool_calls' ?
  │    ├─ toolCalls 含 submit_response → parsed = args，break（本轮结束）
  │    │
  │    └─ 否则：Promise.all 并行跑本轮全部 tool_calls
  │         → executeKbTool(name, input, agentId, {conversationContext})
  │         每次触发 onToolEvent({type:'tool_call' / 'tool_result', ...})
  │         结果按调用顺序拼到 messages（provider 要求每个 tool_call 有配对 tool_result）
  │         再次 callClaude
  │
  └─ 循环上限 MAX_TOOL_ITERATIONS = 5
       超限/模型自己停了 → force-submit 兜底（同样在 runMedici 里内联）
       （附一条 "please submit" user 消息 + tool_choice 锁死 submit_response）
       再失败 → throw
```

**三条关键设计：**

1. **强制 submit_response**：每轮必须以 `submit_response` tool_call 收尾——下游拿到的一律是 tool args（严格符合 output_schema 的 JSON）。避免"模型自由发挥写一段话当回复"，所有客户可见回复都走 schema 校验。即便产品/KB 工具为空（新建的产品线还没灌数据），tools 列表也永远有 `submit_response`，所以**不存在"没工具就走别的路径"这种分支**——永远一条代码路径。

2. **同轮 tool_calls 并行**（对齐 Ogilvy）：Claude 同一轮可能同时发多个工具调用（例如两次不同角度的 `search_knowledge`）。串行跑会让次要工具被丢弃、浪费迭代。当前实现用 `Promise.all` 并行执行，结果按调用顺序持久化。

3. **KB 多轮查询重写**：`executeKbTool` 收到从 runMedici 构造的 `conversationContext`（用户/助手的原文 turns，最多末尾 8 轮 + 当前用户输入），交给 `searchKnowledge → rewriteQuery`。客户问"那价格呢？"时，KB 能被重写成"200 马力拖拉机的价格"去检索，而不是"价格呢"裸查。

### 4.3 工具清单

Medici 的工具分两档：**1 个总是注册的 submit_response**（每轮必收尾）+ **最多 2 个按 KB 数据条件
注册的知识库工具**（[kb-tools.js](../src/agents/medici/kb-tools.js)）。工具是否出现在 Claude 的 tools
列表里取决于该 agent_id 下的数据——没数据就不注册，Claude 不会"看到"不能用的工具。

| # | 工具 | 注册条件 | 职责 |
|---|---|---|---|
| 1 | `submit_response`   | 永远 | 产出最终结构化 JSON（intent / quality / value / leads / route / next_message） |
| 2 | `search_knowledge`  | `kb_knowledge_points` 有该 agent 的 active 记录 | 知识库混合检索 |
| 3 | `calculate_price`   | `kb_products` 有该 agent 的 active 记录 | 精确报价计算 |

> 历史：早期存在 `search_products` / `query_products` 两个商品检索工具（由 [product-search.js]
> 提供，底层打 `product_specs / product_embeddings` 两张表）。2026-04 确认为废弃实验代码，一并删除。
> DB 表按"旧数据库表不动"的规矩保留但 dormant，见 §8.1。

#### 1. `submit_response` —— 强制收尾工具（关键）

- **什么时候调**：**每轮必须以它收尾**。模型想回复客户就通过这个工具的 args 提交结构化 JSON，
  Medici 拿到 args 后走后处理 + 返回给 queue-processor。
- **input_schema**：等于当前 product_line 的 `output_schema`（由 `lead_fields` 装配而成）。
  所有 JSON 形状的校验由这个工具的 schema 承担。
- **实现**：定义在 [index.js::buildSubmitResponseTool](../src/agents/medici/index.js)，打了
  `cache_control: ephemeral`，和 agentTools 列表共享一个缓存边界。
- **forcer**：若 Claude 跑满 `MAX_TOOL_ITERATIONS=5` 还没调 submit_response，Medici 在 force-submit
  兜底分支里附一条 `"Please call submit_response..."` user 消息 + `tool_choice: {type:'tool', name:'submit_response'}`
  硬锁，最后一轮一定拿到结构化输出；若还失败 → throw，这一批 queue 消息会被标记 failed 等重试。
- **为什么要一个工具来做收尾**：统一下游的输出形状——`queue-processor` / `lead.repository` /
  `medici-simulator` 永远拿到 schema 校验过的 JSON，不会遇到"模型写了一段话当回复"这种路径。

#### 2. `search_knowledge` —— 知识库混合检索

- **什么时候调**：客户问公司信息、物流政策、认证、销售话术、竞品情报等。
- **入参**：`{query, layers?, top_k?}`。`layers` 可选，能限定到
  `company / product / logistics / compliance / sales / competitive` 六层中的某几层。
- **实现**：包装在 [kb-tools.js::executeKbTool](../src/agents/medici/kb-tools.js)，底层调
  [src/kb-search.service.js::searchKnowledge](../src/kb-search.service.js)——这是 `/api/knowledge/*`
  也在用的共享基础设施。流程：
  1. **多轮 query 重写**（关键）：Medici 把 `conversationContext`（历史 user/assistant 原文
     末尾 8 轮 + 当前 input）传给这个工具。`rewriteQuery` 调 Haiku 把"价格呢"这种指代不全的
     query 还原成"200 马力拖拉机价格"再去检索。
  2. **语言检测 + 翻译**：中文 query 翻成英文做向量检索（知识点大部分是英文存储的）。
  3. **分层向量检索 + 权威度加权**：`kb_knowledge_points` 里中英双语 embedding 各打一次，
     合并，按 `authority_level (1-5)` 二次加权。
- **返回**：`JSON.stringify([{content, layer, authority_level, source, ...}, ...])`。

#### 3. `calculate_price` —— 精确报价（仅当有商品数据时注册）

- **什么时候调**：客户问具体型号的价格，agent 需要避免自己瞎猜。
- **入参**：`{sku, quantity?, destination_port?, trade_term?}`。`trade_term` ∈ `FOB / CIF / DDP`，
  默认 FOB。CIF/DDP 必须传 `destination_port`。
- **实现**：`kb-search.service::calculatePrice` 查 `kb_products` 基础价 + `kb_pricing_rules`
  的数量折扣规则，CIF/DDP 场景再叠加海运 + 关税估算。
- **返回**：价格明细 breakdown，包含 base_price / discount / shipping / total。
- **为什么要它**：Claude 自己算价格不可靠，且运营希望价格有单一真源。给 Claude 一个"一定会
  调用权威数据源"的工具，比在 prompt 里写"不要猜价格"有效得多。

#### 工具的可观察性

运营 / RD 在 [`/dev-tools/medici-simulator`](/dev-tools/medici-simulator) 里发消息时，Medici 通过可选的
`onToolEvent` 回调（见 runMedici 签名）把每次 tool_call（含完整入参）和 tool_result（截断到
400 字符的预览）推到前端 trace 面板，**蓝色**条目是 `tool_call`，**绿色**是 `tool_result`。
RD 可以直接看到"Claude 问了 search_knowledge 什么 query、命中了哪几条知识点"——知识库问答
的调试能力由此覆盖，不再需要独立的"AI 知识问答" tab。

### 4.4 Prompt Cache 策略

| 块 | cache_control | 失效时机 |
|---|---|---|
| `system[0]` product_line 静态 prompt | ephemeral | product_line 配置保存（60s 内生效） |
| `system[1]` 动态 context | — | 每轮都变，从来不缓存 |
| `tools[*]` | 只最后一条打 | agent 的 KB/商品 tool 列表变化时 |
| `messages[history]` 末尾 | ephemeral | 每次请求自然前推 |

prompt cache 是 Anthropic 原生机制。这里要求 OpenRouter 固定路由到 Anthropic：

```js
provider: { order: ['anthropic'], allow_fallbacks: false }
```

Bedrock 会剥离 `cache_control`，所以**不能 fallback**。

---

## 5. 知识库（Knowledge Base）

Medici 的 `search_knowledge` / `calculate_price` 两个工具吃的就是这里的数据。KB 是 **agent-scoped**——所有 `kb_*` 表都有 `agent_id` FK，运营通过 `/product-lines/[id]` 的"知识总览 / 上传知识" tab 管理。

### 5.1 数据模型

| 表 | 存什么 | 写入方 | 读取方 |
|---|---|---|---|
| `kb_documents` | 上传的源文件元数据（filename、layer、status、storage_path） | `/api/knowledge/upload` | UploadTab 文档列表 + OverviewTab health |
| `kb_knowledge_points` | 文档切块后的双语文本 + 两条 embedding（en + 原文） | upload + teach | `search_knowledge` tool + OverviewTab 分层统计 |
| `kb_products` | Excel 解析出的结构化商品行（sku、model、fob_price_usd 等） | upload Excel 分支 | `calculate_price` tool |
| `kb_shipping_routes` | Excel 解析出的运费路由（destination_port、cost_per_unit_usd、transit_days） | upload Excel 分支 | `calculate_price` CIF/DDP 分支 |
| `kb_knowledge_gaps` | 命中率低 / 置信度低的检索记录（盲区清单） | `search_knowledge` 检索时回写 | OverviewTab 盲区面板 + gaps API |
| `kb_assets` | 可对外发送的图片资产（`asset_type='product_image'`、`is_sendable=true`） | `/api/knowledge/assets` (POST) + AssetTab UI | Medici `loadAvailableAssets` → 注入动态上下文 + queue-processor `sendMediciAttachments` → WhatsApp |
| `kb_glossary` / `kb_pricing_rules` / `kb_product_assets` | **DORMANT**（见 §8.2） | — | — |

**六层分类学**：`company / product / logistics / compliance / sales / competitive`。运营上传文档时选层，`search_knowledge` 可选按层过滤。

### 5.2 增（Add）

两条入库路径：

#### a. 文件上传

```
UploadTab → POST /api/knowledge/upload  (multipart form)
 └─ kb-file-parsers: xlsx / pdf / docx / csv / txt → 纯文本
 └─ kb-upload.service::processDocument
     ├─ 插 kb_documents (status=processing)
     ├─ detectLanguage → 非英文 translateToEnglish
     ├─ Sonnet 切块 + 每块打标 layer + 元信息
     ├─ generateEmbedding × 2（英文 + 原文）
     ├─ 批插 kb_knowledge_points (status=active)
     ├─ 如果是 Excel 且命中产品 / 物流表头 → 额外解析写入 kb_products / kb_shipping_routes
     └─ 更新 kb_documents.status=ready
```

**SKU 冲突兜底**：Excel 里同 SKU 不同价时返回 `conflicts` 数组，UploadTab 弹出"使用新值 / 保留旧值 / 共存"三选；选好走 `/api/knowledge/conflicts/resolve`。

#### b. 对话式录入（Teach）

```
UploadTab 文本框 → POST /api/knowledge/teach  { agent_id, message }
 └─ Sonnet 抽取 extracted_knowledge[]（每条带 content / content_en / layer / metadata）
 └─ 对每条：
     ├─ detectLanguage；非英文 translateToEnglish
     ├─ generateEmbedding × 2
     └─ insert kb_knowledge_points (status=active)   ← 直接 active，无 draft 确认
 └─ 返回 { reply, inserted_count, extracted_knowledge }
```

运营在文本框里写"我们 A100 拖拉机 FOB $12500，MOQ 5 台，交期 45 天..."，点"提交知识"——几秒后 `search_knowledge` 就能检索到。

> 历史：2026-04 之前 teach 走 `draft → PUT confirm → active` 两步；但 UI 从没有配确认按钮、`draft_ids` 字段名还跟 UI 读的 `drafts_created` 对不上——这个功能**事实上没工作过**。本次简化为直接 active。

### 5.3 删（Delete）

```
UploadTab 删除按钮 → DELETE /api/knowledge/documents?doc_id=xxx
 └─ getDocumentById (取 storage_path)
 └─ deleteDocumentById → CASCADE 删除关联的 kb_knowledge_points / kb_products / kb_shipping_routes
```

> 小债：Supabase Storage 里的原始文件目前**未一并清理**，只删了 DB 行。未来加一轮 storage 清理即可。

另一条"软删除"是 `kb_knowledge_gaps`：OverviewTab 的"忽略"按钮走 PUT 改 status → `ignored`，记录保留作审计。

### 5.4 查（Read）

两类消费者，共享 `kb-search.service.js` 底层：

#### a. Medici 的 `search_knowledge` tool（详情见 §4.3）

流程链：
1. 若有 `conversationContext` → Haiku `rewriteQuery`（补全指代，例 "价格呢" → "200 马力拖拉机价格"）
2. detectLanguage；非英文 → `translateToEnglish` 再走英文 embedding 分支
3. 两个 RPC：`search_kb_points_en` + `search_kb_points_original`，各拉 top-K
4. **加权融合**：`similarity × 0.4 + authority(1–5) × 0.35 + freshness(180 天衰减) × 0.25`
5. 可选 `layers` 过滤
6. 返回 `[{content, layer, authority_level, source, final_score}, ...]`

#### b. UI 运营面板（OverviewTab）

`/api/knowledge/health` 聚合：
- **六层 coverage**：每层按知识点数分桶（0 / >5 / >20 / >50 → 0 / 25% / 50% / 70% / 90%）
- **总覆盖率** = 有知识点的层数 ÷ 6
- **过期文档**：status=ready 且超过 30 天未更新
- **AI 建议**：空层补资料 / 弱层补材料 / 过期文档提醒
- **total_documents / total_knowledge_points / total_products** 三个总数卡

`/api/knowledge/gaps`（GET + PUT）驱动盲区面板——按 `occurrence_count` 倒序展示最多 100 条。

### 5.5 图片资产（被动外发）

Medici 可以在客户**主动要图**时回传知识库里的图片，例如"能看下实物吗？" / "再来一张图"。

**入库**：AssetTab → `POST /api/knowledge/assets` (multipart) →
- 校验 `image/jpeg|png|webp|gif`，≤5MB
- 上传到 Storage `kb-assets/${agentId}/${ts}_${filename}`
- 插 `kb_assets`（`asset_type='product_image'`、`is_sendable=true`）；插库失败回滚 storage

**注入**：`runMedici` 启动时与 `loadAgentTools` 并行调 `loadAvailableAssets(agentId)`，把 `[{id, description, mime_type}]` 写进 `context.available_assets`。`buildDynamicContext` 渲染 `AVAILABLE ASSETS` 块 + 一段附件规则（默认不发图、客户明确请求时再挑 asset_id）。

**发送**：Medici 在 `attachments[]` 里给出 `{asset_id, caption?}` → queue-processor 文本回复发完后调 `sendMediciAttachments`（`src/agents/medici/send-attachments.js`）：
1. 按 id 取 `kb_assets` 行 + 校验 `is_sendable`
2. 从 Storage 下载 buffer
3. `sendMedia(waId, 'image', buffer, mime, filename, caption, phoneNumberId)`
4. 写一条 `role=assistant, sentBy=bot` 的消息（`metadata.kb_asset_id` 留痕）

单条失败只 warn 不抛——文本已经送达，多发图只是锦上添花。

### 5.6 端点全景（清理后）

共 **7 个**活端点，都在 `/api/knowledge/*`：

| 端点 | 方法 | UI / 消费方 |
|---|---|---|
| `/upload` | POST | UploadTab 文件上传 |
| `/documents` | GET / DELETE | UploadTab 文档列表 + 删除 |
| `/conflicts/resolve` | POST | UploadTab Excel 冲突弹窗 |
| `/teach` | POST | UploadTab 对话式录入 |
| `/assets` | GET / POST / DELETE | AssetTab 图片资产管理 |
| `/health` | GET | OverviewTab |
| `/gaps` | GET / PUT | OverviewTab 盲区面板 |

---

## 6. "我想改 X，去哪个文件"

| 场景 | 改哪里 |
|---|---|
| 提示词文案（某产品线） | `/product-lines/[id]` 后台 UI（DB 侧，不动代码） |
| BASE_PROMPT 模板本身（所有产品线） | `base-prompt.js` |
| 新增一个 per-turn context 字段 | `index.js` → Prompt assembly 段的 `buildDynamicContext` |
| 加图 / 语音 / 文件等模态 | `index.js` → Messages 段的 `buildClaudeContent` |
| 通用 lead schema 加字段 | `output-schema.js::GENERIC_LEAD_OUTPUT_SCHEMA` |
| 某产品线独有字段 | `/product-lines/[id]` → `lead_fields` JSON |
| 改 per-conversation 配置解析逻辑 | `config.js::loadMediciConfig` |
| 改配置缓存 TTL | `config.js` 里 `TTL_MS` |
| 加新的 lead_field 类型 | `config.js::leadFieldToJsonSchemaProp` |
| 新增 KB tool | `kb-tools.js`（底层能力加到 `src/kb-search.service.js`） |
| 换模型 / 改超时 / 改重试 | `index.js` → LLM transport 段 |
| 有新的 legacy 输出格式要兼容 | `index.js` → Post-process 段的 `normalizeAgentResponse` |
| 改整体编排顺序 | `index.js` → Orchestrator 段 `runMedici` |

---

## 7. 测试

### 单元测试（vitest）

- `internals.test.js` · prompt 必填校验 + dynamic context 拼装 + post-process 的 legacy 分支
- `config.test.js` · row → agentConfig 装配（system_prompt / output_schema / qualification_config）
- `output-schema.test.js` · 通用 schema 不变量 + agent 自定义优先级

```bash
npx vitest run src/agents/medici
```

### 端到端冒烟

dev-tools 里的 **Medici 调试台** (`/dev-tools/medici-simulator`) 直接调 `runMedici`，全流程同生产但零 DB 写入。每次改提示词 / 改 tool / 改输出形态都先在这里过一遍再发。

路由：`app/api/dev-tools/medici-simulator/send/route.js` → `runMedici({...})`。

**Tool 可视化**：simulator 调 `runMedici` 时注入 `onToolEvent` 回调，把每次 tool_call（含入参）和 tool_result（截断后的返回）插进 trace 数组，前端用蓝/绿色高亮显示。运营 / RD 可以直接看到 Claude 调了哪些 KB 工具、查了什么、命中了什么——知识库问答的测试能力被这里覆盖了，`/product-lines/[id]` 不再有独立的"AI 知识问答"tab。

---

## 8. 废弃 / 技术债

---

## 9. 已修复

### 2026-04-28 round

| # | 问题 | 修复 |
|---|---|---|
| 11 | `normalizeAgentResponse` 的 `rfq_items` / 顶层 `customer_profile` 两条历史分支 —— product_lines 重构后 output_schema 都是按 `lead_fields` 自动拼的，永远不会再产出那种形状，遥测也确认 0 命中 | 删 Case 1 + Case 2，只保留 Case 3 catch-all（自定义 `lead_fields` 落 `details` JSONB 兜底） |
| 12 | `kb-tools.js` 的 `pricingCount` 查询 + description 撒谎 —— 只用来在 description 里加一句 "Quantity discount rules are available."，但 `calculatePrice` 实际不读 `kb_pricing_rules`，那句话是 LLM 看着会被误导的死提示 | 删 `pricingCount` 查询；description 改成"insurance fixed at 0.3%"实情 |
| 13 | `agentConfig.id` 的 slug↔UUID 桥（旧 §8.2）—— `product_lines.id` 是 slug，`agents.id` 是 UUID，`kb_*` 全部按 `agent_id` 索引，导致每条 KB 路径都得先 `findAgentIdByProductLine` 反查一次，外加 agentConfig 里挂着两套 ID | 给 `kb_documents / kb_knowledge_points / kb_products / kb_shipping_routes / kb_assets / kb_knowledge_gaps` 等表加 `product_line_id TEXT` 列 + 一次性 backfill + `(tenant_id, product_line_id)` 索引 + INSERT/UPDATE trigger 自动从 agent_id 反查填值；新增 `search_kb_knowledge_en(p_tenant_id, p_product_line_id, …)` overload；所有 KB 查询路径切到按 `(tenant_id, product_line_id)` 过滤；`loadMediciConfig` / simulator 不再查 agents 表填 `agentConfig.id`；`hasKnowledgeBase / buildKbTools / executeKbTool / searchKnowledge / vectorSearch / structuredProductSearch / calculatePrice / loadAvailableAssets` 全部签名改成 `{ tenantId, productLineId }`；老 `agent_id` 列保留不动 |

### 2026-04 round

| # | 问题 | 修复 |
|---|---|---|
| 1 | `send_asset` 工具是空壳——注释声称 queue-processor 会 check pending assets 发到 WhatsApp，但实际没有任何代码实现；Claude 会错误地以为素材已发 | 从 tool 列表整条下掉 |
| 2 | 多轮 KB 搜索丢 context——`executeKbTool(name, input, agentId)` 第 4 参数 `context` 从未被 Medici 传入，导致 `searchKnowledge` 里的 query rewrite（把"价格呢"还原成"200 马力拖拉机价格"）始终跑不起来 | runMedici 构造 `conversationContext`（history user/assistant 原文 + 当前用户输入，末尾 8 轮），传给 `executeKbTool` |
| 3 | 同轮多 tool_calls 被丢——`toolCalls[0]` 只取第一个，Claude 同时调 `search_knowledge + search_products` 时第二个被忽略，浪费迭代 | `Promise.all` 并行跑全部（对齐 Ogilvy 模式）；若 `submit_response` 混在里面，作为 final 返回，忽略同轮其他 |
| 4 | `searchShippingRoutes` dead import | 删 |
| 5 | `search_products` 默认 top_k=3、`search_knowledge` 默认 top_k=5 不一致 | 都统一为 5 |
| 6 | Medici 调试台 看不到 tool 调用过程（KB / 产品工具是黑盒） | runMedici 新增 `onToolEvent` 可选回调；simulator 把 tool_call（含入参）+ tool_result（截断预览）拼进 trace，前端蓝/绿色高亮 |
| 7 | 删掉 `/product-lines/[id]` 的"AI 知识问答" tab + `/api/knowledge/test-chat/**` 三个 API——它测的是"KB + 通用 RAG prompt"，既不是 Medici 真实行为，也不是 KB 覆盖度的正确测法；Medici 调试台 + tool 可视化已覆盖这个场景 | 删 ChatTab、三个 API、lib/api/knowledge.js 里的 listSessions/getSession/sendMessage/deleteSession |
| 8 | `product-search` 模块（`search_products / query_products` 两个工具）+ `app/api/product-assets/` 四个 route，整块是之前 RD 做的商品检索实验，事实上没被调用过 | 删 `src/agents/medici/product-search.js` + `app/api/product-assets/` 整目录；index.js 的 `loadAgentTools` / dispatcher 去掉商品分支；`isKbTool` 死导出一并删；DB 侧的表/RPC/bucket 保留 dormant（见 §8.1）|
| 9 | **KB 的 teach 功能完全坏了**：lib 客户端发 `content` 字段但 API 读 `message`，每次点"提交知识"都 400；即便修好 POST，UI 也没有确认 draft 的按钮，而 API 把知识插成 `status='draft'` → `search_knowledge` 过滤 `status='active'` 看不到——**teach 写入的知识点永远不会被 Claude 读到** | Option A 简化：字段名对齐成 `message`；POST 直接插 `status='active'`（删 draft 层和 PUT 方法）；UI 计数从错的 `drafts_created` 改成 `inserted_count` |
| 10 | KB 一半端点是死代码：`/{auto-learn, feishu-import, glossary, pricing-rules, calculate-price}` 全无调用方（UI / cron / Medici 都不碰），`src/kb-auto-learn.service.js` + `src/kb-feishu-import.service.js` 同理 | 砍掉 5 个无调用端点；删 2 个 service 文件（共 ~420 行）；`kb-search` 的 `searchShippingRoutes` 死函数 + `translateWithGlossary` 的空表 glossary 查询 + `calculatePrice` 的空表 pricing_rules 查询全部简化；repository 删 3 个永远返 0 的 count 函数，OverviewTab 去掉 2 个永远 0 的数字卡；配套 DB 表（`kb_glossary / kb_pricing_rules / kb_product_assets`）dormant 保留（见 §8.2）|

---

## 10. 性能 & 成本

| 指标 | 数量级 |
|---|---|
| 一次 runMedici 延迟 | 1.5–4s（直接 submit_response）· 3–8s（有 KB tool 调用，视迭代次数） |
| input tokens | 典型 2k–5k（system prompt + 10-20 条 history） |
| output tokens | ≤ 4096 (`MAX_TOKENS`) |
| 缓存命中率 | 静态 prompt + 工具定义稳定状态下 > 80%（Sonnet 缓存价格 = input 的 10%） |
| 模型 | `claude-sonnet-4-6`（固定，call-loop.js 里） |

成本优化点都收敛在 `index.js` 的 LLM transport 段：换 Haiku、分拆合成轮、调低 `MAX_TOKENS`、改重试策略。

---

## 11. 一次迭代需要哪些人

- **改产品话术** → 运营在 `/product-lines/[id]` UI 改，60s 内生效，不需要 RD
- **改分类逻辑 / 加字段** → RD 改 `lead_fields` + 可能动 `index.js` 的 Prompt assembly 段
- **加工具** → RD 写新方法到 `kb-tools.js`（底层能力加到 `src/kb-search.service.js`），index.js 的 `loadAgentTools` 自动带上
- **换模型 / 改架构** → 全在 `index.js`，分段注释找到对应段

**契约稳定的好处**：queue-processor、session.js、lead.repository.js 都不需要因 Medici 内部变化而改。改 Medici 的人只要保证 `runMedici` 的输出 JSON 形状不变，下游自动跟上。
