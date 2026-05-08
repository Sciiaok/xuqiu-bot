# ai-reception-deal skill · 接口契约（与 LeadEngine 宿主系统）

> 本文件定义 LeadEngine 询盘接待 Agent（"宿主"，工程名 Medici）对 `ai-reception-deal` skill bundle 的接口约束。**skill 作者迭代时必须遵守，否则宿主端集成会断裂。**
>
> 本契约的存在前提是：skill 包是可热替换资产（zip 形式落到 `skills/<name>.skill`），宿主代码与 skill 内容物理隔离。只要契约不破，skill 作者可以自由迭代内容；契约破了，宿主端要同步改代码或拒绝加载。
>
> 文档版本：v1.0（2026-05-06，初版）

---

## 第一部分：bundle 文件结构

### 1.1 命名与位置

skill 包必须命名为 `ai-reception-deal.skill`，是一个标准 ZIP 文件，**zip 内有且仅有一个顶级目录**：`ai-reception-deal/`。

```
ai-reception-deal.skill (zip)
└── ai-reception-deal/
    ├── SKILL.md               # 必须，主文档
    └── references/            # 可选，按需添加
        ├── stages-definition.md
        ├── kb-usage-rules.md
        ├── tool-priority-rules.md
        ├── handover-rules.md
        ├── response-style.md
        ├── state-output-schema.md
        ├── test-scenarios.md
        └── acceptance-cases.md
```

### 1.2 SKILL.md 必须存在

主文档必须命名为 `SKILL.md`（大小写敏感），位于顶级目录根。宿主 loader 找不到这个文件会启动失败。

### 1.3 references/ 是可选目录

如果存在，必须命名为 `references/`，仅包含 `.md` 文件。宿主 loader 会扫描该目录下所有 `.md` 文件，按"去掉路径与 `.md` 后缀的 basename"作为 key 索引。

例如 `references/stages-definition.md` 会被索引为 `stages-definition`。模型用 `read_skill_reference({ name: "stages-definition" })` 工具按需取用。

**约束**：

- 不要使用子目录（如 `references/kb/foo.md`）；宿主 loader 行为对子目录文件的 key 命名不保证稳定
- 所有 reference 文件名 basename 必须唯一
- 不允许放非 `.md` 文件

### 1.4 不允许的内容

- 任何二进制资源（图片、PDF、字体等）—— 宿主不解析这些
- `package.json` / `requirements.txt` / `Dockerfile` 等运行时声明 —— 宿主不会执行任何 skill 提供的代码
- 任何 `.py` / `.js` / `.sh` 脚本 —— 同上

---

## 第二部分：SKILL.md frontmatter 规范

### 2.1 必须字段

```yaml
---
name: ai-reception-deal              # 必须等于文件名（不含 .skill 后缀）
description: >
  一句话或一段话，描述这个 skill 做什么、何时被触发。
  支持 YAML 块标量 `>` 折叠多行（loader 会拼成一行）。
---
```

宿主 loader 校验 `frontmatter.name` 必须严格等于"加载时传入的 skill 名"（即 `ai-reception-deal`）；不匹配会拒绝加载并抛错。这是为了防止你不小心把另一个 skill 的内容塞到这个槽位里。

### 2.2 不要使用其它 frontmatter 字段

宿主 loader 只读 `name` 和 `description`，其它字段会被忽略。如果未来需要添加（如 `version`、`min_host_version`），请先与宿主集成方沟通。

### 2.3 frontmatter 必须用 `---` 包裹，不要用 TOML 或 JSON 格式

loader 用一个简化的 YAML 解析器：

- 支持 `key: value` 单行
- 支持 `key: >` 块折叠多行
- 不支持嵌套 / 数组 / 锚点 / 复杂 YAML 特性

---

## 第三部分：宿主运行环境约束

skill 必须假设运行在以下环境（与 Anthropic Claude.ai 通用环境**有重大差异**）：

### 3.1 没有文件系统

- 模型**不能**写文件到 `/mnt/user-data/outputs/` 或任何路径
- 模型**没有** `Write` / `Bash` / `present_files` 等文件操作工具
- 任何让模型"保存为文件再呈现给用户"的指令都会失败

**正确做法**：所有产出通过 `submit_response` 工具一次性以结构化 JSON 提交。

### 3.2 没有 Python 沙箱

- 模型**不能**执行 Python 代码
- 不要在 skill 中输出可执行 Python 脚本作为交付物

### 3.3 没有自由对话回复，每轮必须以 `submit_response` 收尾

- **纯文本助手回复一律被丢弃**——只有写入 `submit_response.next_message` 的内容才会发给客户
- 即使本轮模型不需要查任何工具，也必须直接调一次 `submit_response` 收尾
- 详见第四部分的工具白名单和第五部分的 envelope 规范

### 3.4 客户语言 / 通道是 WhatsApp

- 客户消息以单条 WhatsApp 文本到达；可能携带 WhatsApp 媒体附件（图片）由宿主自动转成多模态 user 消息
- 客户的语言、文化背景、沟通节奏因目的国而异；skill 不要写死成英文或中文
- WhatsApp 商务对话的节奏：短、自然、专业，每轮推进 1-2 个关键问题，**不要用 emoji**（host-patch §8 强约束）

### 3.5 上下文按"会话"为单位，不是"单轮消息"

- 模型每轮收到完整的 history，可以基于多轮上下文修正之前的字段抽取
- `leads` 输出策略是"看完整对话"而非"看本轮"——同主产品 + 同目的国的 lead 应该合并而不是新增

---

## 第四部分：工具白名单

skill 在运行时，模型可以调用的工具**只有以下 8 个**，其它一律不可用。任何 skill 内文要求模型调用其它工具的指令都会导致工具调用失败。

| 工具 | 何时调 | 输入 | 输出 |
|---|---|---|---|
| `submit_response` | **每轮必收尾** | 见第五部分 envelope | `{}`（成功即结束本轮） |
| `read_skill_reference` | 按需读取 references/*.md | `{ name: string }`（不带路径前缀和 .md 后缀） | `{ name, content }` 或 `{ error, available }` |
| `lookup_product` | 按 SKU / 型号 / 属性查产品 | 见 4.1 | 见 4.1 |
| `quote_price` | 报价时**必调** | 见 4.2 | 见 4.2 |
| `lookup_shipping` | 查目的港运费 / 船期 | 见 4.3 | 见 4.3 |
| `lookup_policy` | 查政策 / 资质 / 公司 / 售后 / 销售 Q&A | 见 4.4 | 见 4.4 |
| `find_asset` | 找图（客户主动要图时） | 见 4.5 | 见 4.5 |
| `check_constraint` | 议价 / 让步前的边界检查 | 见 4.6 | 见 4.6 |

**典型性问题**：上面 6 个 KB typed tool 不是"似乎相关就调"——每个工具都返回**确定性结构**（`found:true/false` / `ok:true/false` / `decision: allowed|requires_approval|forbidden|unknown`），skill 内文应教模型基于这个确定性结构做 if-else 决策，而不是基于相似度评估。

**KB 数据为空时**：宿主在装配工具列表时会先做一次 `(tenant_id, product_line_id)` scope 下的 KB 内容存在性检测，没有任何 KB 内容时这 6 个 KB 工具**不会注册**，模型只看到 `submit_response + read_skill_reference`。skill 内文不要假设 KB 工具一定在场，应当处理"知识库为空，正面承接 + 必要时转人工"这条退路。

### 4.1 `lookup_product` 工具签名

```
lookup_product({
  sku?:   string,           // 精确或部分 SKU / 型号
  model?: string,           // 型号关键词
  attrs?: { [key]: any }    // 结构化属性过滤；支持 _lte / _gte 后缀做范围查询
                            // 例：{ horsepower_lte: 50, fuel_type: "diesel" }
})
→ 命中:    { found: true,  products: [...] }
→ 未命中:  { found: false, suggestions?: [...], missing_fields?: [...] }
```

**调用时机**：报价、确认产品规格、客户问"有没有 X"。报价前**必须**先确认产品（即先调 `lookup_product` 再调 `quote_price`）。

### 4.2 `quote_price` 工具签名

```
quote_price({
  sku:               string,                    // 必填
  quantity?:         number,                    // 默认 1
  trade_term?:       'FOB' | 'CIF' | 'DDP',     // 默认 FOB
  destination_port?: string,                    // CIF / DDP 必填
  payment_term?:     string,                    // 例 "TT 30/70" / "LC at sight"
                                                // 非标条款会触发 needs_human
})
→ 成功:   { ok: true, unit_price, total_price, breakdown, validity, source }
→ 失败:   { ok: false, missing_fields | needs_human | not_found }
```

**铁律**：客户问价格时**必调**本工具，**绝不要**自己算或猜价格。CIF / DDP 报价缺 destination_port → 反问客户补齐，不要默认到某个港口。

### 4.3 `lookup_shipping` 工具签名

```
lookup_shipping({
  destination_port: string,                     // 必填
  shipping_method?: 'sea' | 'air' | 'land',
  origin_port?:     string,
})
→ 命中:   { found: true,  route: { unit_cost, transit_days, ... } }
→ 未命中: { found: false, alternatives: [...] }   // 同国可选项
```

### 4.4 `lookup_policy` 工具签名

```
lookup_policy({
  topic?:               string,    // 已知类目（payment_terms / warranty / after_sales /
                                   // export_qualification / certification /
                                   // company_background / competitive）
  subtopic?:            string,
  free_text?:           string,    // 客户原话——会**优先**搜销售自填的 Q&A snippet
                                   // （命中阈值 0.75），未命中再走四层向量检索
  destination_country?: string,    // 国别筛选
})
→ { found: boolean, answer_text?: string, citations?: [...] }
```

**用法**：客户问"你们能做 X 吗" / "有没有 CE 认证" / "保修怎么算"等政策类问题就调本工具。`free_text` 是客户原话不要重新措辞——先匹销售人工沉淀的 Q&A，再做向量检索兜底。

### 4.5 `find_asset` 工具签名

```
find_asset({
  type?:             'product_image' | 'spec_sheet' | 'quotation_template'
                     | 'certificate' | 'brochure' | 'other',
  sku?:              string,
  view?:             string,    // 例 front / side / engine / interior /
                                // color_swatch / detail
  color?:            string,
  scenario?:         string,    // 例 factory / warehouse / loading / in_use
  natural_language?: string,    // 自由文本 fallback；做语义检索
})
→ { assets: [{ id, description, mime_type, matched_by: 'tag' | 'semantic',
              confidence?: number }, ...] }
```

**安全约束**（host-patch §7 锁定）：

- **默认不发图**——`submit_response.attachments` 默认 `[]`，仅当客户**明确要求**图片 / 照片 / 图 / 看实物 / picture 时才挑 `asset_id`
- `matched_by: 'tag'` 的命中可以直接发；`matched_by: 'semantic'` 的命中**先文字描述并请客户确认**，不要直接发
- 没有匹配的资产就礼貌说明无法提供，**不要硬塞不相关的图**

可发送的 asset 列表通过宿主动态段（`AVAILABLE ASSETS` 块）注入，每条形如 `asset_id=<uuid>  <description>`。skill 不要假设"图随便发"。

### 4.6 `check_constraint` 工具签名

```
check_constraint({
  action:   'give_discount' | 'accept_payment_term'
          | 'apply_shipping_markup' | 'apply_special_offer',
  context?: { [key]: any },     // 自由结构，例 { discount_percent: 8 }
})
→ { decision: 'allowed' | 'requires_approval' | 'forbidden' | 'unknown',
    reason: string }
```

**用法**：议价 / 让步 / 给优惠 / 接受非标付款前**必先**调本工具。`unknown` 表示无规则——涉及让步就转人工，不要自己拍板。

### 4.7 工具失败语义的处置原则

- `missing_fields` → 反问客户补齐字段
- `needs_human` / `requires_approval` / `forbidden` → 转人工（`route: HUMAN_NOW`）
- `not_found` / `decision: 'unknown'` → 不得编造，明确告诉客户需要确认或转人工
- `matched_by: 'semantic'` 的 asset → 不要直接发图，先文字描述并请客户确认

### 4.8 不可调用的工具（清单非穷尽）

以下工具在宿主环境中**不存在**，skill 不要假设它们可用：

- `present_files` / 任何文件呈现工具
- `Write` / `Edit` / `Read` / 任何文件 I/O
- `Bash` / 任何 shell / 命令执行
- Python 代码执行 / Jupyter 单元
- `web_search` / `read_webpage` —— Medici 不联网，KB 是唯一信息源
- `generate_*` 类生成工具 —— Medici 不生图、不生代码、不生文档
- 用户授权的第三方 API（Meta Graph / OpenRouter 直连等）—— 这些只能由宿主代码间接使用

---

## 第五部分：submit_response envelope（最重要的收口）

skill 主文档的 §7 和 `state-output-schema` reference 写的是 skill 自己的状态字段（`current_stage` / `known_fields` / `missing_fields` / `next_best_action` / `customer_intent_level` 等）——**那些是 skill 作者用来表达方法论的，不是宿主的提交 schema**。

宿主的 `submit_response` 工具只接受下面这套 envelope，字段名 / 枚举值必须严格对齐。详细映射在 `skill-host-patch.md` §2-3。

### 5.1 envelope 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `conversation_intent` | `Array<'personal_consumer' \| 'business_inquiry' \| 'business_cooperation' \| 'other'>` | 一个会话可同时表现多种意图 |
| `conversation_intent_summary` | `string` | 简要分析 |
| `inquiry_quality` | `'BAD' \| 'GOOD' \| 'QUALIFY' \| 'PROOF'` | 询盘质量分级，**取代**skill 的 `current_stage` |
| `business_value` | `'LOW' \| 'AVERAGE' \| 'HIGH'` | 商机价值评估 |
| `leads` | `Array<Lead>` | 抽取的线索；字段集由 product_line `lead_fields` 配置决定，宿主动态注入 |
| `route` | `'CONTINUE' \| 'HUMAN_NOW' \| 'FAQ_END'` | 路由决策，**取代** skill 的 `need_human_handover` |
| `next_message` | `string` | 给客户的最终回复（≤180 字符，WhatsApp 口吻），**取代** skill 的 `reply_to_customer` |
| `handoff_summary` | `string` | 转人工时给销售的一段话；不转人工时填空字符串 |
| `attachments` | `Array<{ asset_id, caption? }>` | 默认空数组；仅在客户明确要求图片时填 |

### 5.2 skill 阶段 → envelope 字段的映射（host-patch §3 锁定）

| skill 阶段 | `inquiry_quality` | `route` | 备注 |
|---|---|---|---|
| `inbound` | `BAD` 或 `GOOD`（视客户首轮信息量而定） | `CONTINUE` | 还没完成 leads 收集 |
| `lead_collection` | `GOOD` | `CONTINUE` | 关键字段补齐中 |
| `dealing` | `QUALIFY` | `CONTINUE` | 进入标准售前问答 |
| `negotiation` | `QUALIFY` | `CONTINUE` | 议价中 |
| `order_intent` | `PROOF` | `HUMAN_NOW` | 出现下单 / PI / 合同信号，立即转人工 |
| `human_handover` | 维持当前 quality | `HUMAN_NOW` | 命中转人工底线条件 |

特殊路由：

- `personal_consumer`（C 端、明确个人用途）→ `route: FAQ_END`，`inquiry_quality: BAD`
- 垃圾消息 / 推销 / 求职（`other` 意图）→ `route: FAQ_END`，`next_message` 留空字符串
- 客户明确要求人工 / 销售联系 → `route: HUMAN_NOW`，无视当前 quality

### 5.3 leads 输出策略

- 复盘**所有历史消息**，输出全部有效 leads（含修正、补充）
- 同主产品 + 同目的国 → 合并为 1 条 lead
- 主产品标识不明确（招呼语 / 笼统询问 / 无具体产品的目录请求）→ **不输出 lead**
- 每个 lead 的字段集严格遵循 `submit_response.input_schema`（每个产品线不同）；未知字段填空字符串或空数组（**非 null**）

### 5.4 schema 由宿主动态生成

`submit_response.input_schema` 不是 skill 写死的——宿主按当前 product_line 的 `lead_fields` 配置在每次调用时动态生成。skill 内文要求模型"输出 sku / brand / 数量"等具体字段是**禁止**的，因为换一个产品线（拖拉机 / 整车 / 配件）字段集完全不同。

skill 应该只描述"分阶段补齐成交所需关键字段"这种方法论，**具体字段名**通过宿主动态注入的 `LEAD FIELDS HINTS` / `GOOD/QUALIFY/PROOF FIELDS` 块告诉模型。

---

## 第六部分：宿主动态注入 — skill 不得写死的内容

skill 主文档与 references **禁止**包含以下"看起来像方法论但实际是 per-tenant / per-product-line"的内容。这些必须由宿主在每轮调用时通过 dynamic system block 注入：

### 6.1 完全由宿主注入的字段（禁止 skill 写死）

| 字段 | 由谁产出 | skill 内文应该 |
|---|---|---|
| `BUSINESS_VALUE_GUIDANCE` | 运营在 `/product-lines/[id]` UI 配 | 引用"按宿主注入的 BUSINESS VALUE GUIDANCE 拍板"，不写具体口径 |
| `LEAD_FIELDS_HINTS`（字段清单 + 描述）| 同上 | 描述方法论（"分步补齐、不机械追问"），不点名字段 |
| GOOD / QUALIFY / PROOF 各 tier 需要哪些字段 | 同上（`required_for` 列）| 同上 |
| `LINE_NAME` | 产品线表 | 在话术示例里用占位符，不写死"汽车 / 拖拉机" |
| `CURRENT MISSING FIELDS` | 宿主每轮算 | skill 教模型"基于当前 missing fields 决定下一问"，不假设固定字段名 |
| `PRIOR STATE`（上一轮分类）| 宿主每轮算 | skill 教模型"不要因身份词汇 (self employed / 修车工等) 误判 C 端" |
| `Ad the customer clicked` | 宿主从 conversation 元数据取 | skill 教模型"广告里的产品作隐含起点，不要复述广告原文" |
| `AVAILABLE ASSETS` | 宿主从 `kb_assets` 取 | skill 教模型"客户明确要图才挑 asset_id"，不写死任何 id |

### 6.2 半静态：可在 skill 内写"原则"但不写"清单"

- 哪些类目的问题"必须先查 KB"（价格 / 库存 / 付款 / 船期 / 资质 / 政策）—— 类目本身稳定，可以列
- 工具优先级（价格 → quote_price，运费 → lookup_shipping 等）—— 调用映射稳定，可以列
- 转人工的触发场景（合同 / PI / 深度议价 / 投诉 / 多 SKU 等）—— 边界稳定，可以列

### 6.3 完全由 skill 主导（宿主不干预）

- 阶段定义与目标（inbound / lead_collection / dealing / negotiation / order_intent / human_handover）
- 知识库使用规则（命中 / 部分命中 / 未命中的处置原则）
- 转人工时的 handoff_summary 该写什么
- 风格规范（简洁、克制、专业）
- 测试场景与验收用例

---

## 第七部分：阶段框架约束

### 7.1 必须保留的核心结构

- 六阶段命名与顺序：`inbound` → `lead_collection` → `dealing` → `negotiation` → `order_intent` → `human_handover`
- 每阶段都映射到 host-patch §3 表的某一行 `(inquiry_quality, route)` 组合
- 知识库优先原则：价格 / 库存 / 付款 / 船期 / 资质 / 政策类问题必须先调 KB 工具

### 7.2 灵活迭代的部分

- 各阶段内的具体话术示例
- KB 命中 / 部分命中 / 未命中的应对模板
- 议价场景的承接技巧
- 转人工时的 handover summary 模板
- 测试场景库

### 7.3 阶段映射不可改

如果 skill 新增 / 删除阶段，host-patch §3 的映射表也要同步改——这是**破坏性变更**，需走第八部分协调流程。

---

## 第八部分：升级流程

### 8.1 我方迭代发布流程

1. skill 作者发布新版 zip
2. 我方（宿主集成方）拿到新版后：
   - 在本地用宿主的 loader smoke test 加载校验
   - 在 `/medici-simulator`（dev-tools 里的零副作用调试台）跑几个典型场景
   - 替换 `skills/ai-reception-deal.skill` 文件
   - 重启 next.js 服务（loader 自动检测 mtime）
3. 跑一次端到端会话验证（webhook → queue-processor → runMedici → 真实 WhatsApp 回复）

### 8.2 skill 作者本地校验（建议）

skill 作者可在本地用以下方式快速验证 bundle 结构合法：

```bash
# 解压验证目录结构
unzip -l ai-reception-deal.skill

# 应看到：
#   ai-reception-deal/
#   ai-reception-deal/SKILL.md
#   ai-reception-deal/references/...
```

frontmatter 必须能被简化 YAML 解析器读懂（用 Python 的 `yaml.safe_load` 解析顶部 `---` 块通过即可）。

### 8.3 破坏性变更协调

如果 skill 新版需要打破本契约的任何约束（例如：新增 / 删除阶段、改 frontmatter 格式、要求新工具支持、改 envelope 字段），请**提前**与宿主集成方沟通，由双方共同评估并升级宿主代码。

破坏性变更的典型类目：

- 新增阶段（host-patch §3 的映射表要同步改）
- 改 inquiry_quality / route / business_value / conversation_intent 的枚举值
- 要求新的 KB tool（宿主要在 `kb-tools.js` 加 schema + 在 `executeKbTool` 加 case）
- 要求 `submit_response` envelope 加 / 减 / 改字段（宿主要改 `output-schema.js` + `config.js::assembleOutputSchema` + 下游 lead.repository）

---

## 第九部分：宿主预留的扩展位

以下是宿主目前**没有**但**可以扩展**的能力。如果 skill 迭代需要，请提案：

| 能力 | 现状 | 扩展成本 |
|---|---|---|
| 主动外发图（不等客户开口）| host-patch §7 锁定被动外发 | 中等（要重新设计 attach 触发条件，避免骚扰）|
| 语音消息 | 入站走 OpenAI Whisper → text；出站不支持 | 中等（出站需 TTS + WhatsApp media upload）|
| 视频 / 文档附件外发 | 同 4.5，仅图 | 中等 |
| 多语言主动切换 | 模型自适应，无显式控制 | 小（加 `language_hint` 注入字段）|
| 主动追单（客户超 N 小时不回）| 不主动 | 大（需要 cron + 跨会话状态） |
| 跨会话客户画像 | 当前只看本会话 history | 大（需 contact-level memory store）|
| 工具调用次数 / 单价控制 | 模型自由调，每会话最多 5 轮 tool-use | 小（已有 `MAX_TOOL_ITERATIONS`）|

---

## 第十部分：联系与反馈

- skill 内容问题、迭代建议：联系 skill 作者
- 宿主集成问题、契约更新、扩展提案：联系 LeadEngine 集成方（即本仓库维护者）
- 紧急 bug（skill 加载失败、模型行为偏离严重）：双方协商，必要时降级到上一版 skill bundle 回滚（保留旧版 zip 作为应急）

---

> 本契约 v1.0 与 skill 包 sha256 头 `a6e220e9`（2026-05-06 KB 重构版本）配套生效。后续版本升级会同步更新本文件版本号。
