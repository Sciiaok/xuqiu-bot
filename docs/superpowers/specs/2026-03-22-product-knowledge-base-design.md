# Product Knowledge Base - Architecture & Implementation Design

## Overview

为 lead_engine_next 增加产品知识库功能：后台上传 PDF 产品资料，解析后存入 Supabase，chatbot 对话时自动检索产品信息辅助回答客户询盘。

## 核心问题

客户通过 WhatsApp 询问产品参数（"有没有 200 马力的拖拉机"、"DF2004E 多重"），chatbot 目前无法获取产品知识，只能做询盘收集。需要一个产品知识检索层，让 Claude 在对话中能引用真实产品数据。

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    后台管理界面                           │
│  上传 PDF → 选择 agent(product_line) → 触发解析          │
└────────────────────────┬────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│              PDF Upload & Parse API                      │
│  /api/product-docs/upload                                │
│                                                          │
│  1. 存原件 → Supabase Storage (product-docs bucket)      │
│  2. opendataloader-pdf 解析 → Markdown + 结构化表格       │
│  3. 分 chunks → OpenAI embedding                         │
│  4. 双路存储:                                             │
│     ├── product_specs 表 (结构化参数, JSONB)              │
│     └── product_embeddings 表 (pgvector)                 │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│              Chatbot 对话时 (claude.service.js)           │
│                                                          │
│  客户提问 → Claude 选择工具:                              │
│  ├── search_products (语义搜索)                          │
│  │   问题 embedding → pgvector cosine similarity         │
│  │   → top-k 产品信息注入 context                        │
│  │                                                       │
│  └── query_products (精确查询)                           │
│      Claude 生成 SQL WHERE → 查 product_specs            │
│      → 匹配结果注入 context                              │
│                                                          │
│  Claude 基于检索到的产品信息 + 对话历史 → 回复客户        │
└─────────────────────────────────────────────────────────┘
```

## Database Schema

### 1. 启用 pgvector 扩展

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### 2. product_documents 表 (文档元数据)

```sql
CREATE TABLE product_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,          -- Supabase Storage 路径
  doc_type TEXT NOT NULL DEFAULT 'general',  -- spec_sheet | manual | brochure | general
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'error')),
  error_message TEXT,
  page_count INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_product_documents_agent ON product_documents(agent_id);
CREATE INDEX idx_product_documents_status ON product_documents(status);
```

### 3. product_specs 表 (结构化参数, 供精确查询)

```sql
CREATE TABLE product_specs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES product_documents(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  model TEXT NOT NULL,                 -- 产品型号 e.g. "DF2004E"
  brand TEXT,                          -- 品牌
  product_line TEXT NOT NULL,          -- 对应 agents.product_line
  specs JSONB NOT NULL DEFAULT '{}',   -- 所有参数存这里 (灵活适配不同产品线)
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_product_specs_agent ON product_specs(agent_id);
CREATE INDEX idx_product_specs_model ON product_specs(model);
CREATE INDEX idx_product_specs_product_line ON product_specs(product_line);
CREATE INDEX idx_product_specs_specs ON product_specs USING GIN(specs);
```

**specs JSONB 结构示例 (agri_machinery):**

```json
{
  "engine_type": "SDEC Engine SC7H220.2G2 Stage II",
  "working_type": "Vertical, water-cooled, four-stroke, turbocharged, intercooled",
  "nominal_power_kw": 147,
  "rated_power_kw": 162,
  "nominal_speed_rpm": 2200,
  "dimensions_mm": "5465x2960x3080",
  "min_mass_kg": 7375,
  "wheel_base_mm": 2900,
  "speed_range_kmh": "2.46-37.61",
  "gearbox_shifts": "16/16",
  "gearbox_type": "Synchronizer, Engagement Bushing",
  "pto_speed_rpm": "540/1000",
  "brake_type": "Wet, disk",
  "hydraulic_outputs": 4,
  "steering": "fully hydraulic front wheel steering",
  "fuel_tank_l": 400,
  "cabin": "Luxurious cab with air conditioning, radio, back-up camera",
  "front_tyre": "16.9-24",
  "rear_tyre": "20.8-38"
}
```

### 4. product_embeddings 表 (向量搜索)

```sql
CREATE TABLE product_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES product_documents(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  chunk_text TEXT NOT NULL,            -- 原文 chunk
  chunk_index INT NOT NULL,            -- chunk 在文档中的顺序
  embedding vector(1536) NOT NULL,     -- OpenAI text-embedding-3-small
  metadata JSONB DEFAULT '{}',         -- model, page_number 等
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_product_embeddings_agent ON product_embeddings(agent_id);
CREATE INDEX idx_product_embeddings_embedding
  ON product_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
```

### 5. Supabase Storage bucket

```sql
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-docs', 'product-docs', false)
ON CONFLICT (id) DO NOTHING;

-- 仅允许认证用户上传和读取
CREATE POLICY "product-docs auth read"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'product-docs');

CREATE POLICY "product-docs auth upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'product-docs');
```

## PDF 解析流程

### 解析工具: @opendataloader/pdf

- npm 包名: `@opendataloader/pdf` (v2.0.2)
- **系统依赖: 需要 Java 11+ 在 PATH 中** (底层是 Java 引擎)
- 本地运行无需 GPU, 无外部 API 调用
- 支持表格提取 (产品规格表的核心需求)
- 输出 Markdown (用于 embedding chunks) 和 JSON (用于结构化提取)
- API: `convert(files, { outputDir, format })` — 文件输入/输出模式

### 解析流程

```
1. 上传 PDF → 存入 Supabase Storage
2. 创建 product_documents 记录 (status: processing)
3. opendataloader-pdf 解析:
   ├── 输出 Markdown → 按段落/表格分 chunks (每 chunk ~500 tokens)
   └── 输出 JSON (表格原始 key-value)
4. 字段标准化 (OpenAI gpt-4o-mini):
   └── 原始 key-value → 标准化 JSON → product_specs.specs JSONB
5. Embedding 生成:
   └── 每个 chunk → OpenAI text-embedding-3-small → product_embeddings
6. 更新 product_documents status → ready
```

### 字段标准化 (步骤 4 详解)

opendataloader-pdf 提取的是 PDF 中的原始字段名，格式不统一：

```json
{"Nominal power(kw）": "147", "Rated Power(kw)": "162", "Min mass (kg)": ">7375"}
```

通过一次 gpt-4o-mini 调用标准化为规范的 JSONB：

```json
{"nominal_power_kw": 147, "rated_power_kw": 162, "min_mass_kg": 7375}
```

```javascript
async function normalizeSpecFields(rawKeyValues, productLine) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a product spec normalizer. Convert raw PDF-extracted key-value pairs into a clean JSON object.
Rules:
- snake_case field names in English
- Append unit suffix: _kw, _mm, _kg, _rpm, _l, _kmh
- Parse numeric values (remove ">", "≥", units text), keep as numbers
- Keep text values as strings
- Product line: ${productLine}`
      },
      {
        role: 'user',
        content: JSON.stringify(rawKeyValues)
      }
    ]
  });
  return JSON.parse(response.choices[0].message.content);
}
```

**成本:** 单次调用 < $0.001 (gpt-4o-mini)，仅在上传解析时执行一次。
**优势:** 自动适配各种 PDF 格式的字段名差异，无需维护硬编码映射表。

### Chunk 策略

对于产品规格表 PDF (如 2004E.pdf):
- 整个规格表作为一个 chunk (通常 < 500 tokens)
- chunk 前加上型号标识: `"[DF2004E] Model: DF2004E\nEngine Type: SDEC..."`

对于多页产品手册:
- 按段落/章节分 chunks
- 每个 chunk 带上产品型号的 metadata 标注

## Claude Tool Use 集成

### 当前架构

`claude.service.js` 中 `getResponse()` 使用 `json_schema` output format，Claude 返回结构化 JSON（leads, route, next_message 等）。

### 改造方案

在 `getResponse()` 中增加 `tools` 参数，让 Claude 可以在生成回复前调用产品知识查询工具:

```javascript
const tools = [
  {
    name: 'search_products',
    description: '语义搜索产品知识库。当客户用自然语言描述需求时使用。返回最相关的产品信息。',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索查询，用客户的自然语言描述，如"200马力拖拉机"'
        },
        top_k: {
          type: 'number',
          description: '返回结果数量，默认3'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'query_products',
    description: `精确查询产品参数数据库。当客户问具体参数比较时使用。
表: product_specs, 字段: model(型号), brand(品牌), specs(JSONB参数)。
specs 字段说明根据 product_line 动态注入（见下方）。`,
    input_schema: {
      type: 'object',
      properties: {
        sql_where: {
          type: 'string',
          description: "WHERE 子句, 如: specs->>'nominal_power_kw' > '150'"
        }
      },
      required: ['sql_where']
    }
  }
];
```

### 动态 specs 字段说明

每个 agent（product_line）的 `query_products` tool description 动态拼接该产品线已有的 JSONB key 列表。

**数据来源:** 直接从 `product_specs` 表查询该 agent 下所有已存在的 JSONB key:

```sql
SELECT DISTINCT jsonb_object_keys(specs)
FROM product_specs
WHERE agent_id = $1
ORDER BY 1;
-- → nominal_power_kw, rated_power_kw, speed_range_kmh, fuel_tank_l, ...
```

```javascript
async function getSpecFieldsForAgent(agentId) {
  const { data } = await supabase.rpc('get_spec_fields', { p_agent_id: agentId });
  return data; // ["fuel_tank_l", "nominal_power_kw", "rated_power_kw", ...]
}

// 注入到 tool description
const specFields = await getSpecFieldsForAgent(agentId);
if (specFields.length > 0) {
  queryProductsTool.description += `\nspecs JSONB 可查询字段: ${specFields.join(', ')}`;
}
```

零配置: 上传新产品 PDF 解析入库后，字段列表自动更新，无需手动维护。字段命名需在解析阶段做好标准化（如统一用 `_kw`, `_mm`, `_rpm` 后缀标注单位），让 Claude 能从字段名推断含义。

### Tool Use 调用流程

```
1. Claude 收到客户消息
2. Claude 判断是否需要产品信息:
   - 需要 → 调用 search_products 或 query_products
   - 不需要 → 直接回复 (纯询盘收集)
3. 系统执行 tool:
   - search_products → embedding + pgvector 查询 → 返回 top-k chunks
   - query_products → 执行 SQL → 返回匹配的产品记录
4. Claude 收到 tool result → 生成最终回复 (含产品信息)
5. 系统解析 JSON 输出 (leads, route, next_message)
```

### API 调用变化

**限制:** Anthropic API 不支持 `tools` 和 `output_config.format.json_schema` 同时使用。

**解决方案:** 把最终 JSON 响应也定义为一个 tool (`submit_response`)，所有输出都通过 tool_use 返回，无需 `output_config`。

```javascript
// 将 output_schema 转为 submit_response tool
const submitResponseTool = {
  name: 'submit_response',
  description: '提交最终回复。在收集完所有需要的产品信息后调用此工具提交回复。必须作为最后一步调用。',
  input_schema: outputSchema,  // 复用现有的 JSON_SCHEMA
};

const allTools = [...productTools, submitResponseTool];

// 改为: 纯 tool_use 模式 (移除 output_config)
let response = await anthropic.messages.create({
  model: config.anthropic.model,
  max_tokens: 4096,
  system: systemBlocks,
  messages: messages,
  tools: allTools,
});

// 处理 tool_use 循环
while (response.stop_reason === 'tool_use') {
  const toolUse = response.content.find(c => c.type === 'tool_use');

  // submit_response = 最终回复，跳出循环
  if (toolUse.name === 'submit_response') {
    return toolUse.input;  // 这就是之前 json_schema 返回的结构
  }

  // 其他工具 (search_products, query_products) → 执行并继续
  const toolResult = await executeProductTool(toolUse.name, toolUse.input, agentId);
  messages.push({ role: 'assistant', content: response.content });
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult }] });
  response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: systemBlocks,
    messages: messages,
    tools: allTools,
  });
}
```

**优势:** 单次 API 调用链即可完成工具调用 + 结构化输出，无需额外请求。
**注意:** system prompt 需要指示 Claude "完成所有产品查询后，调用 submit_response 提交最终回复"。

### SQL 安全性

`query_products` 中 Claude 生成的 SQL WHERE 子句需要安全处理:

```javascript
async function executeQueryProducts(sqlWhere, agentId) {
  // 1. 仅允许查询 product_specs 表
  // 2. 强制加上 agent_id 过滤 (不允许跨产品线查询)
  // 3. 使用参数化查询拼接, 防止注入
  // 4. 只允许 SELECT, 不允许 UPDATE/DELETE/DROP
  // 5. 设置查询超时 (5s)

  const safeQuery = `
    SELECT model, brand, specs
    FROM product_specs
    WHERE agent_id = $1
    AND (${sanitizeSqlWhere(sqlWhere)})
    LIMIT 10
  `;
  return await supabase.rpc('query_product_specs', {
    p_agent_id: agentId,
    p_where_clause: sqlWhere,
  });
}
```

建议通过 Supabase RPC (PostgreSQL function) 执行，在数据库层面做安全限制:

```sql
CREATE OR REPLACE FUNCTION get_spec_fields(p_agent_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
AS $$
  SELECT array_agg(DISTINCT key ORDER BY key)
  FROM product_specs, jsonb_object_keys(specs) AS key
  WHERE agent_id = p_agent_id;
$$;

CREATE OR REPLACE FUNCTION query_product_specs(
  p_agent_id UUID,
  p_where_clause TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSONB;
BEGIN
  -- 安全检查: 拒绝危险关键字
  IF p_where_clause ~* '(drop|delete|update|insert|alter|truncate|;|--|/\*)' THEN
    RAISE EXCEPTION 'Invalid query';
  END IF;

  EXECUTE format(
    'SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT model, brand, product_line, specs
      FROM product_specs
      WHERE agent_id = %L AND (%s)
      LIMIT 10
    ) t',
    p_agent_id,
    p_where_clause
  ) INTO result;

  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;
```

## API Endpoints

### POST /api/product-docs/upload

上传并解析 PDF 文件。

```
Request: multipart/form-data
  - file: PDF 文件
  - agent_id: UUID (关联的 agent)

Response: 200
  {
    "document_id": "uuid",
    "status": "processing"
  }
```

### GET /api/product-docs

获取文档列表（按 agent 过滤）。

```
Query: ?agent_id=uuid
Response: 200
  [{
    "id": "uuid",
    "filename": "2004E.pdf",
    "agent_id": "uuid",
    "doc_type": "spec_sheet",
    "status": "ready",
    "page_count": 1,
    "specs_count": 1,
    "created_at": "..."
  }]
```

### DELETE /api/product-docs/[id]

删除文档及其关联的 specs 和 embeddings（级联删除）。

### GET /api/product-docs/[id]/specs

查看某文档解析出的结构化参数。

## 新增文件结构

```
src/
  product-knowledge.service.js    -- PDF 解析 + embedding 生成
  product-search.service.js       -- search_products + query_products 实现
app/api/
  product-docs/
    upload/route.js               -- 上传 API
    route.js                      -- 列表 API
    [id]/route.js                 -- 删除 / 详情 API
    [id]/specs/route.js           -- 查看解析结果
supabase/migrations/
  019_product_knowledge_base.sql  -- 建表 + pgvector + RPC
```

## 对现有代码的改动

| 文件 | 改动 |
|------|------|
| `src/claude.service.js` | `getResponse()` 增加 tools 参数 + tool_use 循环处理 |
| `package.json` | 新增 `@opendataloader/pdf`, `openai` 已有 (用于 embedding) |

## Token 成本估算

| 操作 | 频率 | 成本 |
|------|------|------|
| PDF 解析 (opendataloader) | 上传时一次 | 免费 (本地运行) |
| Embedding 生成 | 上传时一次 | ~$0.0001/chunk (text-embedding-3-small) |
| 查询 embedding | 每次对话 | ~$0.0001/query |
| Claude tool_use | 每次对话 | 增加 ~200 tokens (tool definition) |

日常对话成本增加极小: 主要是 tool definition 的 tokens (~200) + 偶尔的 tool result tokens。

## 实现优先级

1. **P0**: 数据库 migration (pgvector + 建表)
2. **P0**: PDF 上传 + 解析 + 存储 API
3. **P0**: Claude tool_use 集成 (search_products)
4. **P1**: query_products (精确查询, 含 SQL RPC)
5. **P1**: 后台管理界面 (文档列表, 上传, 删除)
6. **P2**: 批量上传, 解析状态通知
