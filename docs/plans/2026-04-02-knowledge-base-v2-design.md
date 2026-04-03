# 知识库 V2 补充设计 — 六项能力增强

基于现有 `knowledge-base-prd.md` 的六层架构和 RAG 链路，补充 6 项缺失能力。

## 项目背景与输入确认

| 项目 | 确认内容 |
|------|---------|
| 产品目标 | 销售对话知识库 — 让 WA Agent 准确回答客户问题，减少转人工率 |
| 架构方案 | 新建 `kb_*` 表体系，不改造现有 `product_*` 表 |
| 向量数据库 | 复用 pgvector（Supabase 内置），规模足够 |
| Agent 集成 | 复用 tool-use 循环（`src/claude.service.js`），新增 knowledge tools |
| 多租户模式 | 团队统一管理（方案 C），按 agent_id 隔离，预留未来开放 |
| 规模 | 3 个 agent，几十到几百 SKU/agent，每天几百条消息 |
| 客户语言 | 英语 90%，其他 10% |
| 源文件语言 | 中文为主，约 40% 配有英文 |
| 已有知识来源 | 本地 Excel 表格 + 微信聊天经验 + 飞书文档 |
| 文件存储 | Supabase Storage（新建 `kb-assets` bucket） |
| 迁移策略 | 两套并存，线上 agent 不受影响，完成后逐步迁移 |

## 现有 Agent 知识架构（现状）

当前 WA Agent 的知识来自 4 层：

| 来源 | 位置 | 内容 | 局限 |
|------|------|------|------|
| 硬编码 System Prompt | `src/claude.service.js:10-145` | 意图分类、对话技巧、路由规则 | 需改代码，不可动态管理 |
| Agent 配置（DB） | `agents` 表 | 可覆盖 system_prompt、output_schema | 只支持 prompt 级别 |
| 产品文档 RAG | `product_*` 三张表 | PDF 分块 + embedding + 结构化 specs | 只支持产品，无价格/物流/话术 |
| 实时上下文注入 | `queue-processor.js` | missing_fields、prior_state | 自动生成，非知识管理 |

**缺失**：价格数据、物流运费、合规认证、销售话术、竞品情报、图片发送能力。

## 知识库 V2 — 六项能力增强

---

## 1. 多语言处理

### 问题

源文件 60% 纯中文，客户 90% 用英语提问。中文 embedding 与英文 query 的语义匹配率低。

### 方案：存储时翻译 + 查询时翻译

```
上传阶段：
  原始内容（中文）
    ↓ LLM 翻译
  英文版本（自动生成）
    ↓
  对两个版本分别做 embedding 存储

检索阶段：
  客户 query（任意语言）
    ↓ 检测语言
    ├─ 英语 → 直接检索英文 embedding
    ├─ 中文 → 直接检索中文 embedding
    └─ 其他语言 → 翻译为英语 → 检索英文 embedding

回复阶段：
  检索到的知识点（中文原文 + 英文译文）一起注入 prompt
  LLM 用客户语言生成回复
```

### 数据模型变更

`kb_knowledge_points` 表新增字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `content_original` | text | 原始语言内容 |
| `content_en` | text | 英文翻译（原文为英文则相同） |
| `source_lang` | varchar(10) | 源语言 code（zh/en/fr 等） |
| `embedding_id_original` | varchar | 原始语言 embedding |
| `embedding_id_en` | varchar | 英文 embedding |

### Vector DB 变更

```
Collection: knowledge_vectors_en     ← 英文 embedding（主检索）
Collection: knowledge_vectors_origin ← 原始语言 embedding（中文客户/内部使用）
```

### 翻译时机

- 文件上传解析后，batch 翻译所有知识点（异步，不阻塞上传流程）
- 对话式录入：实时翻译（单条，延迟可接受）
- 自动学习：提取后与确认环节一起翻译

### 翻译质量保障

- 专业术语表（`kb_glossary`）：用户可维护中英对照术语（如 "散货" → "break bulk"，"寄售" → "consignment"）
- 翻译时 LLM prompt 注入术语表，确保行业术语准确
- 用户在知识总览中可查看/修改英文译文

### 新增表

```sql
CREATE TABLE kb_glossary (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supply_chain_id uuid REFERENCES supply_chains(id),
  term_zh text NOT NULL,
  term_en text NOT NULL,
  context text,          -- 使用场景说明
  created_at timestamptz DEFAULT now()
);
```

---

## 2. 结构化数据检索

### 问题

价格表、运费表是结构化数据，纯向量检索无法处理过滤+排序类查询（如"50HP 以下、低于 $8000 的型号"）。

### 方案：双通道检索（向量 + 结构化）

```
客户 query
  ↓ 意图识别
  ├─ 语义型（"YTO 90HP 有什么特点"）→ 向量检索
  ├─ 过滤型（"50HP 以下低于 $8000"）→ 结构化查询
  └─ 混合型（"适合非洲小农场的拖拉机推荐"）→ 结构化预筛 + 向量排序
```

### 结构化数据表

从 Excel/CSV 解析出的产品、物流等数据，除了向量化，同时写入结构化表：

```sql
-- 产品结构化数据（从产品目录 Excel 解析）
CREATE TABLE kb_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id uuid REFERENCES kb_documents(id),
  supply_chain_id uuid,
  sku varchar(100),
  product_name text,
  product_name_en text,
  model varchar(100),
  category varchar(50),        -- tractor / harvester / parts 等
  specs jsonb,                 -- {"horsepower": 90, "drive": "4WD", "weight_kg": 3500, ...}
  fob_price_usd numeric(10,2),
  moq integer,
  lead_time_days varchar(20),  -- "45-60"
  source_row integer,          -- Excel 中的行号
  is_active boolean DEFAULT true,
  updated_at timestamptz DEFAULT now()
);

-- 物流结构化数据（从运费表解析）
CREATE TABLE kb_shipping_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id uuid REFERENCES kb_documents(id),
  supply_chain_id uuid,
  origin_port varchar(100),
  destination_port varchar(100),
  destination_country varchar(100),
  shipping_method varchar(50),  -- sea_bulk / sea_container / rail / air
  cost_per_unit_usd numeric(10,2),
  transit_days varchar(20),
  notes text,
  updated_at timestamptz DEFAULT now()
);
```

### Search API 变更

`POST /api/knowledge/search` 新增参数：

```json
{
  "query": "50HP 以下低于 $8000 的拖拉机",
  "supply_chain": "agri",
  "layers": ["product"],
  "top_k": 5,
  // ─── 新增 ───
  "filters": {
    "specs.horsepower": {"$lte": 50},
    "fob_price_usd": {"$lte": 8000},
    "category": "tractor"
  },
  "sort_by": "fob_price_usd",
  "sort_order": "asc"
}
```

### 检索路由逻辑（后端）

```
1. LLM 分析 query，输出：
   - search_mode: "vector" | "structured" | "hybrid"
   - extracted_filters: {...}（从自然语言中提取过滤条件）

2. 执行检索：
   - vector: 调 pgvector 语义搜索
   - structured: 转 SQL 查 kb_products / kb_shipping_routes
   - hybrid: 先 SQL 过滤候选集 → 再在候选集上做向量排序

3. 合并结果，返回给 Agent
```

---

## 3. 多轮对话上下文

### 问题

客户第二句"那 CIF 到 Mombasa 呢"脱离上下文无法检索到型号信息。

### 方案：查询改写（Query Rewrite）

```
Agent 收到客户消息
  ↓
取最近 3-5 轮对话历史
  ↓
LLM Query Rewrite：
  输入: {
    history: [
      {role: "customer", content: "YTO 90HP 4WD 多少钱"},
      {role: "agent", content: "FOB 上海 $11,500..."},
      {role: "customer", content: "那 CIF 到 Mombasa 呢"}
    ],
    current_query: "那 CIF 到 Mombasa 呢"
  }
  输出: "YTO 90HP 4WD tractor CIF price to Mombasa port Kenya"
  ↓
用改写后的 query 调用 /api/knowledge/search
```

### Search API 变更

```json
{
  "query": "那 CIF 到 Mombasa 呢",
  // ─── 新增 ───
  "conversation_context": [
    {"role": "customer", "content": "YTO 90HP 4WD 多少钱"},
    {"role": "agent", "content": "FOB 上海 $11,500, MOQ 2台..."}
  ]
}
```

后端流程：
1. 如果 `conversation_context` 不为空，先做 query rewrite
2. 用 rewritten query 执行检索
3. 同时提取上下文中已提到的 SKU/产品，作为额外 filter 条件

### Query Rewrite Prompt

```
你是一个查询改写助手。根据对话历史，将用户最新的问题改写为一个完整的、
可独立理解的检索查询。要求：
- 补全省略的主语/产品型号
- 保留具体的地名、型号、数量等关键信息
- 输出为英文（用于知识库检索）
- 只输出改写后的查询，不要解释
```

---

## 4. 报价规则引擎

### 问题

阶梯报价、CIF 计算、折扣规则需要精确计算，LLM 算数不可靠。

### 方案：规则表 + 计算接口

将报价规则从"知识点"升级为**可执行的结构化规则**，Agent 通过 tool call 调用计算接口。

### 规则数据表

```sql
CREATE TABLE kb_pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supply_chain_id uuid,
  rule_name varchar(100),
  rule_type varchar(50),       -- quantity_discount / shipping_markup / payment_term / special_offer
  priority integer DEFAULT 0,  -- 优先级，高者覆盖低者
  conditions jsonb,            -- 触发条件
  calculation jsonb,           -- 计算规则
  requires_approval boolean DEFAULT false,  -- 超出此规则需人工审批
  is_active boolean DEFAULT true,
  effective_from date,
  effective_until date,
  doc_id uuid REFERENCES kb_documents(id),  -- 来源文档
  created_at timestamptz DEFAULT now()
);
```

### 规则示例

```json
// 数量阶梯折扣
{
  "rule_name": "拖拉机数量折扣",
  "rule_type": "quantity_discount",
  "conditions": {"category": "tractor"},
  "calculation": {
    "tiers": [
      {"min_qty": 1,  "max_qty": 4,  "discount_pct": 0},
      {"min_qty": 5,  "max_qty": 9,  "discount_pct": 3},
      {"min_qty": 10, "max_qty": 19, "discount_pct": 5},
      {"min_qty": 20, "max_qty": null, "discount_pct": 8}
    ]
  },
  "requires_approval": false
}

// CIF 计算规则
{
  "rule_name": "CIF 价格计算",
  "rule_type": "shipping_markup",
  "conditions": {},
  "calculation": {
    "formula": "fob_price + shipping_cost + insurance_rate * fob_price",
    "insurance_rate": 0.003
  }
}
```

### 计算接口

**POST /api/knowledge/calculate-price**

```json
// 请求
{
  "sku": "YTO-90HP-4WD-CABIN",
  "quantity": 10,
  "destination_port": "Dar es Salaam",
  "trade_term": "CIF"
}

// 返回
{
  "breakdown": {
    "unit_fob_price": 11500,
    "quantity_discount": "5%",
    "discounted_unit_price": 10925,
    "shipping_per_unit": 1800,
    "insurance_per_unit": 34.50,
    "unit_cif_price": 12759.50,
    "total_price": 127595.00
  },
  "rules_applied": [
    {"rule": "拖拉机数量折扣", "detail": "10台, 5% off"},
    {"rule": "CIF 价格计算", "detail": "FOB + 运费 + 保险"}
  ],
  "needs_approval": false,
  "confidence": "exact"     // exact = 规则计算 | estimated = 部分数据缺失用估算
}
```

### Agent 集成

Agent 的 tool 列表中新增 `calculate_price` tool：

```
当客户询问具体价格/报价时：
1. 先从 kb_products 查到 SKU 和 FOB 价格
2. 调用 calculate_price 获得精确报价
3. 将 breakdown 格式化后回复客户

当计算结果 needs_approval=true 时：
→ 回复客户 "此报价需要销售经理确认，我会尽快给您回复"
→ 标记为 HUMAN_NOW
```

---

## 5. 知识优先级与冲突解决

### 问题

同一问题命中多个知识点时，Agent 不知道用哪个。

### 方案：三级优先级机制

```
优先级判定顺序：
  1. authority_level（用户标记的权威等级）
  2. effective_date（时间越新越优先）
  3. relevance_score（向量相似度）
```

### 数据模型变更

`kb_knowledge_points` 新增字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `authority_level` | integer | 1-5，5=最权威（用户可手动设置，默认3） |
| `effective_date` | date | 知识生效日期 |
| `expires_at` | date | 过期日期（可选） |
| `superseded_by` | uuid | 被哪个知识点取代（冲突解决后填入） |
| `status` | varchar | active / expired / superseded / draft |

`kb_documents` 新增字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `authority_level` | integer | 文档级别权威度，子知识点继承 |
| `is_authoritative` | boolean | 用户标记为"权威来源"（如最新官方价格表） |

### 运行时优先级算法

```
检索返回 top_k 结果后，重新排序：

final_score =
    relevance_score * 0.4
  + authority_weight * 0.35    -- authority_level 归一化到 0-1
  + freshness_weight * 0.25    -- 基于 effective_date 的衰减函数

过滤规则：
  - status != active → 排除
  - expires_at < today → 排除
  - superseded_by IS NOT NULL → 排除
```

### 自动冲突检测（上传时）

```
新文档上传解析后：
  ↓
对每个新知识点，检索已有知识点（同 layer + 同 supply_chain + 高相似度）
  ↓
发现冲突（如 YTO 90HP 旧价格 $11,500 vs 新价格 $12,000）
  ↓
生成冲突报告，推送给用户：
  "检测到价格冲突：YTO 90HP FOB 价格
   旧值: $11,500 (来源: 2026Q1价格表, 2026-01-15)
   新值: $12,000 (来源: 2026Q2价格表, 2026-04-01)
   [以新为准] [保留旧值] [两者共存(按时间范围)]"
  ↓
用户选择后：
  - 以新为准 → 旧知识点 status='superseded', superseded_by=新ID
  - 保留旧值 → 新知识点不入库
  - 共存 → 两者都 active，设置各自 effective_date 范围
```

---

## 6. 文件/图片资产关联与发送

### 问题

客户要产品图片或报价单，Agent 无法从知识库找到并发送文件。

### 方案：资产管理 + Agent 发送 Tool

### 资产数据表

```sql
CREATE TABLE kb_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supply_chain_id uuid,
  asset_type varchar(50),       -- product_image / spec_sheet / quotation_template / certificate / brochure
  filename varchar(255),
  file_url text,                -- Supabase Storage URL
  mime_type varchar(100),
  file_size_bytes integer,
  description text,
  description_en text,
  -- 关联
  layer varchar(20),
  linked_skus text[],           -- 关联的 SKU 列表
  linked_knowledge_ids uuid[],  -- 关联的知识点 ID
  -- 元数据
  tags text[],
  is_sendable boolean DEFAULT true,  -- 是否可直接发送给客户
  created_at timestamptz DEFAULT now()
);

-- 产品图片关联（多对多）
CREATE TABLE kb_product_assets (
  product_id uuid REFERENCES kb_products(id),
  asset_id uuid REFERENCES kb_assets(id),
  is_primary boolean DEFAULT false,  -- 主图
  sort_order integer DEFAULT 0,
  PRIMARY KEY (product_id, asset_id)
);
```

### 上传流程扩展

```
文件上传时，检测文件类型：
  ├─ Excel/PDF/Word/MD → 走现有知识解析流程
  ├─ 图片（JPG/PNG/WEBP）→ 存入 kb_assets
  │   ↓ Vision API 识别图中产品 → 自动关联到 kb_products 中的 SKU
  └─ ZIP 包 → 解压
      ├─ 图片文件 → 同上
      └─ 文档文件 → 走知识解析
```

### Search API 变更

检索结果中附带关联资产：

```json
{
  "results": [
    {
      "content": "YTO 90HP 4WD Cabin Tractor, FOB: $11,500",
      "layer": "product",
      "relevance_score": 0.94,
      "assets": [
        {
          "asset_id": "uuid",
          "type": "product_image",
          "filename": "YTO-90HP-4WD-front.jpg",
          "file_url": "https://xxx.supabase.co/storage/...",
          "is_primary": true,
          "is_sendable": true
        },
        {
          "asset_id": "uuid",
          "type": "spec_sheet",
          "filename": "YTO-90HP-规格书.pdf",
          "file_url": "https://xxx.supabase.co/storage/...",
          "is_sendable": true
        }
      ]
    }
  ]
}
```

### Agent 发送 Tool

Agent 工具集新增 `send_asset`：

```json
// Agent tool definition
{
  "name": "send_asset",
  "description": "发送产品图片、规格书、报价单等文件给客户",
  "parameters": {
    "asset_id": "要发送的资产 ID",
    "recipient_phone": "客户 WhatsApp 号码",
    "caption": "附带的说明文字（可选）"
  }
}
```

Agent 行为规则：
- 客户问"有没有图片" → 检索产品关联的 `product_image`，调用 `send_asset`
- 客户问"发个报价单" → 调用 `calculate_price` 生成报价 → 填入报价模板 → 发送
- 客户问"有没有认证证书" → 检索 `certificate` 类型资产

---

## 汇总：数据模型全景

### 新增表（相对原 PRD）

| 表名 | 用途 |
|------|------|
| `kb_glossary` | 中英术语对照表，翻译时引用 |
| `kb_products` | 产品结构化数据（从 Excel 解析） |
| `kb_shipping_routes` | 物流路线结构化数据 |
| `kb_pricing_rules` | 可执行的报价规则 |
| `kb_assets` | 文件/图片资产 |
| `kb_product_assets` | 产品-资产多对多关联 |

### 原有表新增字段

| 表 | 新增字段 |
|----|---------|
| `kb_knowledge_points` | `content_original`, `content_en`, `source_lang`, `embedding_id_en`, `authority_level`, `effective_date`, `expires_at`, `superseded_by`, `status` |
| `kb_documents` | `authority_level`, `is_authoritative` |

### 新增 API

| 接口 | 用途 |
|------|------|
| `POST /api/knowledge/calculate-price` | 精确报价计算 |
| `POST /api/knowledge/assets/upload` | 上传图片/文件资产 |
| `GET /api/knowledge/assets/{sku}` | 获取产品关联资产 |
| `POST /api/knowledge/send-asset` | Agent 调用，发送文件给客户 |
| `GET /api/knowledge/glossary` | 获取术语表 |
| `POST /api/knowledge/glossary` | 维护术语表 |

### Search API 增强

原 `POST /api/knowledge/search` 新增参数：
- `conversation_context` — 多轮对话上下文
- `filters` — 结构化过滤条件
- `sort_by` / `sort_order` — 排序
- 返回结果新增 `assets` 字段

---

## 7. 初始知识迁移方案

### 三个知识来源的导入路径

#### A. 本地 Excel 表格

最直接的来源，优先导入。

```
用户在知识库管理页上传 Excel
  ↓
后端解析（层级自动识别或手动选择）：
  ├─ 产品目录类 → kb_products（结构化）+ kb_knowledge_points（向量化）
  ├─ 价格表类 → kb_products.fob_price_usd + kb_pricing_rules
  ├─ 运费表类 → kb_shipping_routes
  └─ 其他类 → kb_knowledge_points（通用知识点）
  ↓
LLM 翻译为英文 → 双语 embedding
  ↓
健康度评估 → 提示缺口
```

#### B. 飞书文档

通过飞书 API 拉取文档内容，转化为知识点。

```
管理页面输入飞书文档 URL 或选择飞书知识库节点
  ↓
后端调用飞书 Open API：
  ├─ 云文档 → GET /docx/v1/documents/{id}/raw_content → 提取正文
  ├─ 电子表格 → GET /sheets/v3/spreadsheets/{id}/values → 提取结构化数据
  └─ 知识库 → GET /wiki/v2/spaces/{id}/nodes → 遍历节点
  ↓
内容进入标准解析流程（同文件上传）
  ↓
记录 feishu_doc_token，支持后续同步更新
```

数据模型：`kb_documents` 新增字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `source_type` | varchar(20) | file / feishu_doc / feishu_sheet / feishu_wiki / chat_extract |
| `external_id` | varchar(200) | 飞书 doc_token / sheet_token 等 |
| `sync_enabled` | boolean | 是否开启定期同步 |
| `last_synced_at` | timestamptz | 上次同步时间 |

#### C. 微信聊天经验

非结构化，需要人工辅助提炼。两种方式：

**方式 1：对话式录入（推荐）**
```
团队成员在「AI 知识问答」Tab 中直接输入：
  "我们卖到坦桑尼亚的运费大概 $1800/台，海运 25-30 天"
  ↓
AI 提取结构化知识 → 用户确认 → 入库
```

**方式 2：聊天记录批量导入**
```
导出微信聊天记录（txt 格式）
  ↓ 上传到知识库
  ↓
LLM 分析对话，提取业务知识：
  ├─ 价格信息、交期承诺
  ├─ 客户常见问题和回答
  └─ 异议处理话术
  ↓
生成知识草稿（status=draft）→ 推送给团队审核
  ↓
确认后正式入库
```

### 迁移优先级

| 优先级 | 来源 | 导入内容 | 预期效果 |
|--------|------|---------|---------|
| P0 | 本地 Excel | 产品目录 + 价格表 | Agent 能直接报价，转人工率大幅下降 |
| P1 | 本地 Excel | 运费表 | Agent 能算 CIF 价格 |
| P1 | 飞书文档 | 公司介绍、售后政策、销售 SOP | 补全公司基础层和销售话术层 |
| P2 | 微信经验 | 异议处理话术、FAQ | 补全销售话术层 |
| P2 | 飞书文档 | 合规认证资料 | 补全合规层 |
| P3 | 团队录入 | 竞品情报 | 补全竞品层 |

---

## 8. 实施阶段规划

### Phase 1：基础框架（核心闭环）

**目标**：知识能上传、能检索、Agent 能用

- [ ] 数据库：创建 `kb_documents`、`kb_knowledge_points`、`kb_products`、`kb_shipping_routes` 表
- [ ] 存储：创建 `kb-assets` Supabase Storage bucket
- [ ] 上传解析：Excel/PDF/Word/MD 文件上传 → LLM 解析 → 知识点提取
- [ ] 多语言：上传时自动翻译中文→英文，双语 embedding 存储
- [ ] 向量检索：`/api/knowledge/search` 基础版（向量检索）
- [ ] Agent 集成：在 tool-use 循环中新增 `search_knowledge` tool
- [ ] 管理页面：知识总览 + 文件上传（基于现有 HTML demo 改造）

### Phase 2：精确报价 + 结构化检索

**目标**：Agent 能精确报价，能处理过滤型查询

- [ ] 结构化检索：双通道（向量 + SQL），意图路由
- [ ] 报价引擎：`kb_pricing_rules` + `/api/knowledge/calculate-price`
- [ ] Agent 新增 `calculate_price` tool
- [ ] 知识优先级：authority_level + effective_date + 冲突检测

### Phase 3：上下文 + 资产 + 高级功能

**目标**：多轮对话智能检索，文件发送，知识自动学习

- [ ] 多轮上下文：query rewrite
- [ ] 资产管理：`kb_assets` + Agent `send_asset` tool
- [ ] 飞书文档导入 + 定期同步
- [ ] 对话式录入
- [ ] 自动学习（从历史对话提取知识）
- [ ] 术语表（`kb_glossary`）
- [ ] 健康度评估 + AI 建议

---

*文档结束 · 知识库 V2 设计 · 2026-04-02*
