# API Integration Guide

## Overview

Lead Engine Next 对外暴露 RESTful API，供外部前端应用调用。认证基于 Supabase Auth JWT。

---

## 1. Authentication

### 1.1 前置配置

外部前端需要安装 Supabase JS SDK，使用**同一个 Supabase 项目**的凭证：

```bash
npm install @supabase/supabase-js
```

环境变量（与后端共享同一套）：

```env
NEXT_PUBLIC_SUPABASE_URL=<Supabase project URL>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<Supabase anon/public key>
```

### 1.2 登录获取 JWT

```js
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
)

// 登录
const { data, error } = await supabase.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'password',
})

// 获取 access_token
const { data: { session } } = await supabase.auth.getSession()
const token = session.access_token
```

### 1.3 反向代理配置

在你的 Next.js `next.config.js` 中配置 rewrites，将 `/api/*` 代理到后端：

```js
module.exports = {
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'https://<后端域名>/api/:path*',
      },
    ]
  },
}
```

### 1.4 请求时携带 JWT

所有 API 请求必须在 `Authorization` header 中携带 Bearer token：

```js
async function apiFetch(path, options = {}) {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Not authenticated')

  return fetch(`/api/${path}`, {
    ...options,
    headers: {
      ...options.headers,
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
  })
}
```

### 1.5 Token 刷新

Supabase SDK 自动处理 token 刷新。`apiFetch` 每次从 `getSession()` 获取最新 token，无需额外处理。

### 1.6 错误处理

未认证或 token 过期时，API 返回：

```json
{ "error": "Unauthorized" }
```

HTTP Status: `401`

---

## 2. SSE Streaming

部分 API 返回 Server-Sent Events 流（`Content-Type: text/event-stream`）。

### 消费示例

```js
async function streamFetch(path, body = {}) {
  const { data: { session } } = await supabase.auth.getSession()

  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  })

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n\n')
    buffer = lines.pop()

    for (const block of lines) {
      const eventMatch = block.match(/^event: (.+)$/m)
      const dataMatch = block.match(/^data: (.+)$/m)
      if (eventMatch && dataMatch) {
        const event = eventMatch[1]
        const data = JSON.parse(dataMatch[1])
        console.log(event, data)
      }
    }
  }
}
```

---

## 3. File Upload

文件上传使用 `multipart/form-data`，注意 `Content-Type` 由浏览器自动设置，不要手动指定：

```js
async function uploadFile(path, formData) {
  const { data: { session } } = await supabase.auth.getSession()

  return fetch(`/api/${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      // 不要设置 Content-Type，让浏览器自动处理 boundary
    },
    body: formData,
  })
}
```

---

## 4. API Reference

### 4.1 Campaign - 营销活动

#### POST /api/campaign/intake

创建新的 campaign brief。

- **Auth**: Bearer JWT
- **Body**: `{ id?: string }` (可选自定义 UUID)
- **Response**: `{ brief_id: string }`

#### GET /api/campaign/intake/:id

获取 brief 详情。

- **Auth**: Bearer JWT
- **Response**: `{ id, brief, completion, status, created_at, updated_at }`

#### POST /api/campaign/intake/:id/chat

与 intake 对话，收集 campaign 需求信息。

- **Auth**: Bearer JWT
- **Query**: `?stream_level=text|full` (默认 `text`)
- **Body**: `{ message: string, attachments?: array }`
- **Response**: SSE stream
- **Events**: `message`, `completion`, `error`

#### GET /api/campaign/sessions

获取所有 campaign session 列表。

- **Auth**: Bearer JWT
- **Response**:

```json
{
  "data": [
    {
      "brief_id": "uuid",
      "session_id": "uuid | null",
      "first_message": "string | null",
      "status": "intake | brief_completed | running | waiting_for_feedback | completed",
      "current_phase": "intake | research | strategy | creative_plan | creative | execution",
      "phase_index": 0,
      "completion_pct": 0,
      "created_at": "ISO",
      "updated_at": "ISO"
    }
  ]
}
```

#### POST /api/campaign/orchestrate/:id

启动/恢复编排流水线，或与编排器对话。`id` 可以是 `brief_id` 或 `session_id`。

- **Auth**: Bearer JWT
- **Body**:
  - `{}` — 启动/恢复编排流水线
  - `{ message: string, attachments?: array }` — 与编排器对话
  - `{ phases?: array }` — 指定运行阶段
- **Query**: `?start_phase=research` (从指定阶段恢复)
- **Response**: SSE stream

#### GET /api/campaign/orchestrate/:id

获取编排状态和消息历史。

- **Auth**: Bearer JWT
- **Query**: `?phase=research|strategy|chat` (按阶段过滤消息)
- **Response**:

```json
{
  "session_id": "uuid",
  "brief_id": "uuid",
  "status": "draft | running | waiting_for_feedback | completed | failed",
  "current_phase": "string",
  "phase_results_keys": ["research", "strategy"],
  "phase_results": {},
  "messages": [
    {
      "id": "uuid",
      "phase": "string | null",
      "role": "user | assistant | tool",
      "content": "string",
      "tool_name": "string | null",
      "tool_result": "object | null",
      "attachments": "array | null",
      "created_at": "ISO"
    }
  ]
}
```

#### POST /api/campaign/orchestrate/:id/feedback

用户反馈后恢复编排。

- **Auth**: Bearer JWT
- **Body**: `{ response: string }`
- **Response**: SSE stream

#### POST /api/campaign/orchestrate/:id/approve

批准执行方案并恢复编排。

- **Auth**: Bearer JWT
- **Body**: `{}` (空)
- **Response**: SSE stream

#### POST /api/campaign/upload

上传图片文件。

- **Auth**: Bearer JWT
- **Body**: FormData — `file` (JPEG/PNG/GIF/WebP, max 10MB), `session_id` (可选)
- **Response**:

```json
{
  "url": "https://...",
  "storage_path": "prefix/timestamp_random.ext",
  "filename": "original.png",
  "content_type": "image/png",
  "size": 12345
}
```

---

### 4.2 Agents - 智能体管理

#### GET /api/agents

- **Auth**: Bearer JWT
- **Query**: `?active=true` (可选，仅活跃)
- **Response**: `{ agents: [{ id, name, product_line, system_prompt, output_schema, qualification_config, ad_context_map, is_active, created_at, updated_at }] }`

#### POST /api/agents

- **Auth**: Bearer JWT
- **Body**: `{ name, productLine, systemPrompt, outputSchema?, qualificationConfig?, adContextMap? }`
- **Response**: `{ agent: {...} }` (201)

#### GET /api/agents/:id

- **Auth**: Bearer JWT
- **Response**: `{ agent: {...} }`

#### PUT /api/agents/:id

- **Auth**: Bearer JWT
- **Body**: 要更新的字段
- **Response**: `{ agent: {...} }`

#### DELETE /api/agents/:id

- **Auth**: Bearer JWT
- **Response**: `{ agent: {...} }`

---

### 4.3 Product Docs - 产品文档

#### GET /api/product-docs

- **Auth**: Bearer JWT
- **Query**: `?agent_id=uuid` (可选)
- **Response**: `[{ id, filename, agent_id, doc_type, status, error_message, page_count, created_at, updated_at }]`

#### POST /api/product-docs/upload

- **Auth**: Bearer JWT
- **Body**: FormData — `file` (PDF 或 Excel .xlsx), `agent_id`
- **Response**: `{ document_id, status: "ready" | "error", ...result }`

#### DELETE /api/product-docs/:id

- **Auth**: Bearer JWT
- **Response**: `{ success: true }`

#### GET /api/product-docs/:id/specs

- **Auth**: Bearer JWT
- **Response**: `[{ id, model, brand, product_line, specs, created_at }]`

#### GET /api/product-docs/operations

- **Auth**: Bearer JWT
- **Query**: `?agent_id=uuid, ?limit=20`
- **Response**: `[{ id, document_id, agent_id, operation, operator, details, created_at }]`

---

### 4.4 Product Assets - 产品素材

#### GET /api/product-assets

- **Auth**: Bearer JWT
- **Query**: `?agent_id=uuid, ?model=string`
- **Response**: `[{ id, agent_id, model, filename, storage_path, content_type, created_at }]`

#### POST /api/product-assets/upload

- **Auth**: Bearer JWT
- **Body**: FormData — `file` (JPEG/PNG/WebP/GIF), `agent_id`, `model`
- **Response**: `{ id, model, filename, storage_path, content_type, created_at }`

#### DELETE /api/product-assets/:id

- **Auth**: Bearer JWT
- **Response**: `{ success: true }`

#### GET /api/product-assets/models

- **Auth**: Bearer JWT
- **Query**: `?agent_id=uuid` (必填)
- **Response**: `[string]` (车型名称列表)

---

### 4.5 Inquiries - 询盘

#### GET /api/inquiries

- **Auth**: Bearer JWT
- **Query Parameters**:

| Param | Type | Description |
|-------|------|-------------|
| `dateFrom` | string | 起始日期 YYYY-MM-DD |
| `dateTo` | string | 结束日期 YYYY-MM-DD |
| `inquiryQuality[]` | string[] | 询盘质量筛选：PROOF, QUALIFY 等 |
| `businessValue[]` | string[] | 商业价值：HIGH, MEDIUM, LOW |
| `route[]` | string[] | 来源路由 |
| `customer` | string | 客户名称模糊搜索 |
| `waPrefix` | string | WhatsApp 号码前缀 |
| `country` | string | 国家筛选（`all` 或具体国家） |
| `model` | string | 车型筛选（`all` 或具体车型） |
| `agentIds[]` | string[] | Agent UUID 列表 |
| `quantityMin` | number | 最小采购数量 |
| `quantityMax` | number | 最大采购数量 |
| `limit` | number | 分页大小（默认 10） |
| `cursorTs` | string | 分页游标（ISO timestamp） |
| `cursorId` | string | 分页游标（UUID） |

- **Response**:

```json
{
  "groups": [
    {
      "meta": { "conversationId": "uuid", "waId": "string", "country": "string", ... },
      "leads": [{ "id": "uuid", ... }]
    }
  ],
  "hasMore": true,
  "nextCursor": { "ts": "ISO", "id": "uuid" },
  "totalConversations": 100,
  "totalLeads": 250,
  "approvedCount": 50
}
```

---

### 4.6 Leads - 线索

#### GET /api/leads/:id

- **Auth**: Bearer JWT
- **Response**: `{ success: true, lead: { id, contact_id, conversation_id, ... } }`

#### PATCH /api/leads/:id

- **Auth**: Bearer JWT
- **Body**: 要更新的线索字段
- **Response**: `{ success: true, lead: {...} }`

#### POST /api/leads/approve

- **Auth**: Bearer JWT
- **Body**: `{ leadIds?: string[], approveAll?: boolean, filters?: { stage?, scoreMin?, scoreMax? } }`
- **Response**: `{ success: true, approved: number, message: string }`

#### POST /api/leads/sync

- **Auth**: Bearer JWT
- **Body**: `{ leadIds?: string[], syncAll?: boolean, syncFiltered?: boolean, filters?: { stage?, scoreMin? } }`
- **Response**: `{ success: true, queued: number, synced: number, failed: number, message: string }`

---

### 4.7 Conversations - 对话

#### POST /api/conversations/:id/takeover

人工接管对话。

- **Auth**: Bearer JWT
- **Response**: `{ success: true, conversation: {...} }`

#### DELETE /api/conversations/:id/takeover

释放人工接管。

- **Auth**: Bearer JWT
- **Response**: `{ success: true, conversation: {...} }`

---

### 4.8 Send Message - 发送消息

#### POST /api/send-message

向 WhatsApp 联系人发送消息。

- **Auth**: Bearer JWT
- **Body (文本)**:

```json
{ "conversationId": "uuid", "waId": "string", "message": "hello" }
```

- **Body (媒体)**: FormData — `conversationId`, `waId?`, `file`, `caption?`
- **Response**: `{ success: true, message: string, data: { waId, conversationId, messageId, session } }`

---

### 4.9 AIGC - AI 内容生成

#### POST /api/aigc/generate

- **Auth**: Bearer JWT
- **Body**: FormData — `prompt` (必填), `file?` (PDF/image, max 20MB), `model?`, `format?` (默认 `1080x1080`), `conversation_id?`
- **Response**: `{ id, url, storage_path, model, productInfo? }`

#### GET /api/aigc/library

- **Auth**: Bearer JWT
- **Query**: `?scope=conversation|user` (必填), `?conversation_id=uuid` (scope=conversation 时必填), `?limit=50, ?offset=0`
- **Response**: `{ data: [{ id, url, ... }], total: number }`

---

### 4.10 Analytics & Ads - 数据分析

#### GET /api/analytics

- **Auth**: Bearer JWT
- **Query**: `?days=30, ?country=, ?startDate=YYYY-MM-DD, ?endDate=YYYY-MM-DD, ?humanNowDays=1`
- **Response**:

```json
{
  "kpi": { "totalConversations": 0, "qualifyRate": 0, ... },
  "dailyConversations": [],
  "qualifyRate": [],
  "dailyLeads": [],
  "dailyTakeover": [],
  "businessValueDist": [],
  "intentDistribution": [],
  "approvalRate": [],
  "avgResponseTime": [],
  "humanNowList": [],
  "countries": []
}
```

#### GET /api/ads

- **Auth**: Bearer JWT
- **Query**: `?days=30, ?startDate=YYYY-MM-DD, ?endDate=YYYY-MM-DD`
- **Response**:

```json
{
  "range": { "days": 30, "from": "ISO", "to": "ISO" },
  "totals": { "adsCount": 0, "conversationCount": 0, ... },
  "summary": [{ "metaAdId": "string", "conversationCount": 0, ... }]
}
```

---

### 4.11 Media Proxy

#### GET /api/media/whatsapp/:mediaId

代理获取 WhatsApp 媒体文件。

- **Auth**: Bearer JWT
- **Response**: Binary (image/video/audio with corresponding Content-Type)

---

## 5. Error Codes

| Status | Description |
|--------|-------------|
| 200 | OK |
| 201 | Created |
| 400 | Bad Request (参数缺失或无效) |
| 401 | Unauthorized (未认证或 token 过期) |
| 404 | Not Found |
| 500 | Internal Server Error |

## 6. Quick Reference

| Domain | Method | Endpoint | Stream |
|--------|--------|----------|--------|
| Campaign | POST | /api/campaign/intake | |
| Campaign | GET | /api/campaign/intake/:id | |
| Campaign | POST | /api/campaign/intake/:id/chat | SSE |
| Campaign | GET | /api/campaign/sessions | |
| Campaign | POST | /api/campaign/orchestrate/:id | SSE |
| Campaign | GET | /api/campaign/orchestrate/:id | |
| Campaign | POST | /api/campaign/orchestrate/:id/feedback | SSE |
| Campaign | POST | /api/campaign/orchestrate/:id/approve | SSE |
| Campaign | POST | /api/campaign/upload | |
| Agents | GET | /api/agents | |
| Agents | POST | /api/agents | |
| Agents | GET | /api/agents/:id | |
| Agents | PUT | /api/agents/:id | |
| Agents | DELETE | /api/agents/:id | |
| Product Docs | GET | /api/product-docs | |
| Product Docs | POST | /api/product-docs/upload | |
| Product Docs | DELETE | /api/product-docs/:id | |
| Product Docs | GET | /api/product-docs/:id/specs | |
| Product Docs | GET | /api/product-docs/operations | |
| Product Assets | GET | /api/product-assets | |
| Product Assets | POST | /api/product-assets/upload | |
| Product Assets | DELETE | /api/product-assets/:id | |
| Product Assets | GET | /api/product-assets/models | |
| Inquiries | GET | /api/inquiries | |
| Leads | GET | /api/leads/:id | |
| Leads | PATCH | /api/leads/:id | |
| Leads | POST | /api/leads/approve | |
| Leads | POST | /api/leads/sync | |
| Conversations | POST | /api/conversations/:id/takeover | |
| Conversations | DELETE | /api/conversations/:id/takeover | |
| Send Message | POST | /api/send-message | |
| AIGC | POST | /api/aigc/generate | |
| AIGC | GET | /api/aigc/library | |
| Analytics | GET | /api/analytics | |
| Ads | GET | /api/ads | |
| Media | GET | /api/media/whatsapp/:mediaId | |

All endpoints require `Authorization: Bearer <jwt>` header.
