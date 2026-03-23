# Campaign Intake Agent Design

> Phase 1: 需求采集 Agent — 实时 SSE API 服务

## Overview

构建一个独立的需求采集 Agent (Intake Agent)，通过多轮对话引导客户完成投放需求的结构化采集。核心是一个 SSE streaming API 服务，供主控 (Orchestrator) 调用，同时提供 Web Chat 调试界面。

### 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 入口渠道 | API 服务 + Web 调试界面 | API 为核心，Web Chat 用于 debug |
| Agent 通信 | SSE streaming | 实时响应，三级粒度控制 |
| 多 Agent 框架 | 不引入 LangGraph | 现有 Claude tool_use 足够，避免不必要复杂度 |
| 知识库 | 第一阶段不建 | 先跑通采集流程 |
| Brief schema | 完整 CampaignBrief | 缺失字段由 Agent 推荐，用户确认后填充 |
| 推荐逻辑 | Intake Agent 自身完成 | 推荐+确认本质上还是采集，不需要主控介入 |
| 会话状态 | 独立 campaign_briefs 表 | 与线索系统完全分离 |
| 认证 | 内部使用 | 主控调用 + 调试 |
| 主控消费方式 | 透传 delta + 等待 done | 过程中透传给用户，完整结果后决定下一步 |

---

## 数据模型

### campaign_briefs 表

```sql
CREATE TABLE campaign_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'collecting', 'completed', 'expired')),
  brief jsonb NOT NULL DEFAULT '{}',
  completion jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
```

- `id` 同时作为 session 标识，主控可传入自定义 UUID
- `brief` 用 JSONB 存完整 CampaignBrief，避免 schema 变动时改表
- `completion` 追踪采集进度：`{ filled: [...], missing: [...], recommended: {...} }`
- `expires_at` 支持过期逻辑

### campaign_messages 表

```sql
CREATE TABLE campaign_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id uuid NOT NULL REFERENCES campaign_briefs(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content text,
  tool_name text,
  tool_use_id text,            -- Claude tool_use protocol ID, links tool_use to tool_result
  tool_input jsonb,
  tool_result jsonb,
  message_index integer NOT NULL,
  created_at timestamptz DEFAULT now(),

  CHECK (role = 'tool' OR content IS NOT NULL)
);
```

**消息存储与 Claude API 重建：**

Claude Messages API 中 tool 调用分布在两种 role 里：
- `assistant` 消息包含 `tool_use` content block（含 `tool_use_id`）
- `user` 消息包含 `tool_result` content block（引用 `tool_use_id`）

存储策略：每个 tool 交互存为两行：
1. `role: 'assistant'`, `tool_name`, `tool_use_id`, `tool_input` — 对应 Claude 的 tool_use block
2. `role: 'tool'`, `tool_name`, `tool_use_id`, `tool_result` — 对应 Claude 的 tool_result block

重建 Claude 消息数组时，按 `message_index` 排序，将相邻的 assistant tool_use blocks 合并到同一个 assistant 消息中，tool rows 转为 `{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }`。

### Indexes & RLS

```sql
CREATE INDEX idx_campaign_messages_brief_id ON campaign_messages(brief_id);
CREATE INDEX idx_campaign_messages_order ON campaign_messages(brief_id, message_index);
CREATE INDEX idx_campaign_briefs_status ON campaign_briefs(status)
  WHERE status IN ('draft', 'collecting');

ALTER TABLE campaign_briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "campaign_briefs_auth_all" ON campaign_briefs
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

ALTER TABLE campaign_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "campaign_messages_auth_all" ON campaign_messages
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

-- updated_at 自动更新
CREATE OR REPLACE FUNCTION update_campaign_briefs_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_campaign_briefs_updated_at
  BEFORE UPDATE ON campaign_briefs
  FOR EACH ROW EXECUTE FUNCTION update_campaign_briefs_updated_at();
```

> **RLS 说明：** Phase 1 为内部使用，RLS 策略设为 permissive（与现有 product 表一致）。API route handler 中通过 Supabase service_role key 访问，不暴露给外部。未来对外开放时需要收紧 RLS 策略。

---

## API 接口

### 端点

```
POST /api/campaign/intake          -- 创建新的采集会话，返回 brief_id
POST /api/campaign/intake/:id/chat -- SSE stream，发送消息并获取实时响应
GET  /api/campaign/intake/:id      -- 获取会话状态 + brief 草稿 + completion
```

### SSE 粒度控制

通过 query param `stream_level` 控制：

| stream_level | 输出内容 | 用途 |
|---|---|---|
| `text` | 只有 `delta` 事件 | 生产/主控调用 |
| `events` | `delta` + `tool_call` + `tool_result` + `brief_update` | 集成调试 |
| `full` | 所有事件，含 `thinking` | 调试界面 |

### SSE 事件类型

```typescript
// 逐字输出
{ event: "delta", data: { text: "根据您的..." } }

// Claude 思考过程 (full only)
{ event: "thinking", data: { text: "用户提到了农机出口..." } }

// Tool 调用开始 (events + full)
{ event: "tool_call", data: {
  tool: "extract_business_profile",
  input: { ... }
}}

// Tool 调用结果 (events + full)
{ event: "tool_result", data: {
  tool: "extract_business_profile",
  result: { company_name: "XX农机", industry: "农业机械", ... }
}}

// Brief 更新 (events + full)
{ event: "brief_update", data: {
  brief: { ... },
  completion: { filled: [...], missing: [...], recommended: {...} }
}}

// 结束
{ event: "done", data: {
  brief_id: "uuid",
  status: "collecting" | "completed"
}}

// 错误
{ event: "error", data: { message: "..." } }
```

### 错误处理

- Claude API 失败（网络/限流/上下文超长）→ 发送 `error` 事件 → 关闭 stream
- 错误发生前，已执行的 tool 结果和 brief 状态已持久化到 DB
- 客户端可以用相同消息重新请求（brief 状态从 DB 恢复，不会丢失进度）
- 不支持 `Last-Event-ID` 断点续传（Phase 1 简化）

### 请求格式

```typescript
// POST /api/campaign/intake
// Response: { brief_id: "uuid" }

// POST /api/campaign/intake/:id/chat?stream_level=full
{
  message: string,
  attachments?: { type: string, url: string }[]
}
// Response: SSE event stream

// GET /api/campaign/intake/:id
// Response: { id, status, brief, completion, created_at, updated_at }
```

### 主控消费模式

两层流式串联：

```
用户 <--SSE-- 主控 (Orchestrator) <--SSE-- Intake Agent
```

- 主控以 `fetch` + `ReadableStream` 消费 Intake 的 SSE
- `delta` 事件实时透传给用户（加 `source: "intake"` 前缀）
- 等待 `done` 事件拿到完整结果后，决定是否进入下一阶段

---

## Intake Agent Service

### 文件结构

```
src/
  campaign-intake.service.js         -- 核心：Claude 调用 + tool 执行 + SSE 输出
lib/
  repositories/
    campaign-brief.repository.js     -- DB 操作：briefs + messages 的 CRUD
app/api/campaign/intake/
  route.js                      -- POST 创建会话
  [id]/
    route.js                    -- GET 获取状态
    chat/
      route.js                  -- POST SSE streaming
```

### Tool 定义

| Tool | Input | Output | 用途 |
|------|-------|--------|------|
| `update_brief` | `{ fields: Partial<CampaignBrief> }` | `{ brief, is_complete, filled[], missing[], completion_pct }` | Claude 提取到字段后写入 brief，同时返回完成度 |
| `parse_attachment` | `{ attachment_url, type }` | `{ extracted_text, products? }` | 解析上传的 PDF/图片（Phase 2，初始实现跳过） |
| `save_brief` | `{ brief }` | `{ saved: true, brief_id }` | 保存最终 brief，标记完成 |

> 合并了原来的 `extract_business_profile` 和 `validate_completeness`。Claude 已经有完整对话上下文，不需要把对话文本回传给自己。`update_brief` 接受 Claude 提取的字段，写入 DB 后返回完成度状态。

### Claude 调用流程

```
1. 加载 campaign_messages (ORDER BY message_index)
2. 构建 system prompt:
   - 角色：投放需求顾问
   - CampaignBrief schema 定义
   - 推荐策略（按行业/地区给出默认值的规则）
   - 引导策略：checklist 驱动，不机械逐条提问
3. Claude streaming call (tools + stream)
4. Tool-use 循环：
   - update_brief -> 写入提取的字段，返回完成度
   - parse_attachment -> 提取产品信息
   - save_brief -> 标记 completed，终止循环
5. 存储本轮所有 messages (user + tool + assistant)
6. SSE 输出按 stream_level 过滤
```

### 关键设计点

- **Tool 调用由 Claude 自主决定** — 不强制每轮都调，早期对话可能只是了解背景
- **`save_brief` 是终止信号** — Claude 调了这个 tool 表示采集完成，主控收到 `done` 事件后进入下一阶段
- **推荐逻辑在 system prompt 中** — 不需要单独的 tool，Claude 根据已有上下文直接推荐缺失字段的默认值
- **每轮更新 brief** — `update_brief` 的结果 merge 到 `campaign_briefs.brief`

---

## CampaignBrief Schema

```typescript
interface ProductInfo {
  name: string
  category?: string          // e.g. "拖拉机", "收割机", "SUV"
  model?: string
  description?: string
  price_range?: string       // e.g. "$5,000-$10,000"
  images?: string[]          // URLs
}

interface Attachment {
  type: 'pdf' | 'image' | 'video'
  url: string
  filename?: string
  extracted_content?: string  // parse_attachment 提取后填充
}

interface CampaignBrief {
  // 基础信息
  company_name: string
  industry: string
  products: ProductInfo[]

  // 目标市场
  target_countries: string[]
  target_audience: {
    age_range: [number, number]
    gender: 'all' | 'male' | 'female'
    interests: string[]
    job_titles?: string[]
  }

  // 投放需求
  budget_total: number
  budget_currency: string
  campaign_duration_days: number
  objectives: ('lead_gen' | 'brand_awareness' | 'traffic' | 'conversions')[]
  preferred_platforms: string[]

  // 素材
  attachments: Attachment[]
  brand_guidelines?: string
  existing_landing_pages?: string[]

  // 联系方式
  whatsapp_number?: string
  website?: string
}
```

---

## 调试界面

### 路由

```
/campaign/intake/debug
```

### 布局

左右分栏：

- **左侧 Chat 区域** — 完整 SSE 事件流渲染（thinking 灰色、tool 调用展开/折叠、assistant 回复正常显示），支持上传 PDF/图片附件
- **右侧 Brief 状态** — completion 百分比、filled/missing 字段列表、Brief JSON 实时预览（每收到 `brief_update` 事件刷新）
- **顶部** — 创建新会话 / 切换历史会话

固定 `stream_level=full`。
