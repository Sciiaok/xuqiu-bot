# LeadEngine

WhatsApp 智能获客 + AI 广告投放一体化平台。基于 Next.js 全栈架构，集成 WhatsApp Cloud API 自动接待询盘、Claude AI 多轮对话线索孵化、以及端到端的 Meta Ads 广告投放自动化。

## Tech Stack

| 层级 | 技术 |
|------|------|
| Framework | Next.js 16 (App Router, RSC) |
| Frontend | React 18, CSS Modules, next-intl (i18n) |
| Backend | Next.js API Routes + Node.js ES Modules |
| Database | Supabase (PostgreSQL + pgvector + RLS + Realtime) |
| Cache / Stream | Redis (ioredis) — SSE event stream, distributed lock |
| LLM | Anthropic Claude (direct / OpenRouter), Gemini, MiniMax |
| External | WhatsApp Cloud API, Meta Marketing API (MCP), Firecrawl, SerpAPI, OpenAI Whisper |
| Process | PM2 (5 进程: app + 4 cron) |
| Deploy | tar + scp + PM2 restart (`scripts/deploy.sh`) |
| Test | Vitest (unit), Playwright (e2e) |

---

## Architecture Overview

### Use Case Diagram — 系统全貌

```mermaid
graph TB
    subgraph Actors
        Customer["Customer<br/>(WhatsApp)"]
        Operator["运营人员<br/>(Web Dashboard)"]
    end

    subgraph LeadEngine["LeadEngine Platform"]
        UC1["WhatsApp 自动接待<br/>多轮对话 + 线索孵化"]
        UC2["AI 线索评分 & 分级<br/>GREET → QUALIFY → PROOF"]
        UC3["询盘管理 & 数据看板<br/>LeadHub / Analytics"]
        UC4["AI 广告投放编排<br/>Campaign Studio"]
        UC5["产品知识库<br/>Knowledge Base"]
        UC6["AI 报告生成<br/>Reports"]
    end

    subgraph External["External Services"]
        WA["WhatsApp Cloud API"]
        Claude["Claude AI<br/>(Anthropic / OpenRouter)"]
        Meta["Meta Marketing API"]
        Firecrawl["Firecrawl<br/>网页抓取"]
        Feishu["Feishu Bot<br/>飞书通知"]
    end

    Customer -->|发送消息| UC1
    UC1 -->|评分孵化| UC2
    UC2 -->|高意向通知| Operator
    Operator --> UC3
    Operator --> UC4
    Operator --> UC5
    Operator --> UC6

    UC1 <--> WA
    UC1 <--> Claude
    UC4 <--> Meta
    UC4 <--> Claude
    UC4 <--> Firecrawl
    UC2 --> Feishu
```

### Layered Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Browser  (React 18 + CSS Modules + SSE Client + next-intl) │
├──────────────────────────────────────────────────────────────┤
│  Next.js App Router                                          │
│  ┌────────────────┐ ┌──────────────┐ ┌────────────────────┐  │
│  │ Pages  app/()/ │ │ API Routes   │ │ Middleware         │  │
│  │ RSC + CSR      │ │ app/api/*    │ │ Auth + i18n        │  │
│  └────────────────┘ └──────┬───────┘ └────────────────────┘  │
├────────────────────────────┼─────────────────────────────────┤
│  Service Layer  (src/)     │                                 │
│  ┌───────────┐ ┌───────────┴─────┐ ┌──────────────────────┐ │
│  │ WhatsApp  │ │  Campaign       │ │ Agent Router /       │ │
│  │ Service   │ │  Orchestrator   │ │ Runtime (tool-use)   │ │
│  └───────────┘ │  (5-phase AI)   │ └──────────────────────┘ │
│                └─────────────────┘                           │
├──────────────────────────────────────────────────────────────┤
│  Utility Layer  (lib/)                                       │
│  ┌────────┐ ┌───────┐ ┌────────────┐ ┌───────────────────┐  │
│  │ SSE    │ │ Redis │ │ Queue      │ │ Repositories      │  │
│  │ stream │ │       │ │ Processor  │ │ (Supabase CRUD)   │  │
│  └────────┘ └───────┘ └────────────┘ └───────────────────┘  │
├──────────────────────────────────────────────────────────────┤
│  Infrastructure                                              │
│  ┌───────────────┐  ┌────────┐  ┌──────────────────────┐    │
│  │ Supabase      │  │ Redis  │  │ PM2  (5 processes)   │    │
│  │ PG + pgvector │  │        │  │                      │    │
│  └───────────────┘  └────────┘  └──────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

**分层约定：**
- `app/api/*` — 只做参数校验 + 调用 `src/` 服务 + 拼响应，不写复杂业务
- `src/` — 重业务（调 LLM / Meta API / WhatsApp），不得 import React / Next
- `lib/` — 前后端共用的工具和数据仓储，可被 `src/` 和 `app/` 同时引用
- `lib/repositories/` — 所有 Supabase CRUD 封装，统一数据访问入口

---

## Directory Structure

```
LeadEngine/
├── app/                         # Next.js App Router
│   ├── (app)/                   #   认证后页面 (Sidebar layout)
│   │   ├── analytics/           #     数据看板
│   │   ├── campaign-studio/     #     AI 投放工作台
│   │   ├── leadhub/             #     询盘管理
│   │   ├── agents/              #     Agent 配置
│   │   ├── knowledge-base/      #     产品知识库
│   │   └── reports/             #     AI 报告
│   ├── api/                     #   API Route Handlers (~60 routes)
│   │   ├── webhook/             #     WhatsApp Webhook 入口
│   │   ├── campaign/            #     Campaign Orchestrator (SSE)
│   │   ├── ads/                 #     Meta Ads 数据查询
│   │   ├── contacts/            #     联系人 CRUD
│   │   ├── leads/               #     线索 CRUD / 同步
│   │   ├── knowledge/           #     知识库 CRUD / 搜索
│   │   └── cron/                #     PM2 Cron 内部端点
│   └── components/              #   共享 UI 组件
│       ├── PhaseCards/          #     Campaign 阶段可视化卡片
│       ├── Sidebar/             #     导航侧边栏
│       ├── Markdown/            #     Markdown 渲染器
│       └── DataTable/           #     可排序/筛选表格
│
├── src/                         # Backend 业务逻辑层
│   ├── config.js                #   统一环境变量配置
│   ├── llm-client.js            #   LLM 抽象层 (Claude/Gemini/MiniMax)
│   ├── whatsapp.service.js      #   WhatsApp Cloud API 封装
│   ├── agent-router.service.js  #   多 Agent 路由 (按产品线分流)
│   ├── agent-runtime.service.js #   Agent 执行引擎 (tool-use loop)
│   ├── campaign-orchestrator.service.js  #  5 阶段投放编排
│   ├── campaign-intake.service.js        #  需求收集 Agent
│   ├── research-agent-v2.service.js      #  市场调研 Agent
│   ├── strategy-agent.service.js         #  策略规划 Agent
│   ├── creative-plan.service.js          #  创意规划 Agent
│   ├── aigc.service.js                   #  AI 图片生成 (OpenRouter)
│   ├── execution-agent.service.js        #  Meta 广告创建 Agent
│   ├── meta-ads-mcp-client.js            #  Meta Ads MCP Client
│   └── kb-*.service.js                   #  知识库系列服务
│
├── lib/                         # 工具层 & 数据访问层
│   ├── supabase-server.js       #   Server-side Supabase client
│   ├── redis.js                 #   Redis singleton (stream/lock/signal)
│   ├── sse.js                   #   SSE 推送 (generator → ReadableStream → Redis)
│   ├── consume-sse.js           #   SSE 消费 (browser reconnect)
│   ├── queue-processor.js       #   消息聚合队列
│   └── repositories/            #   Repository 层 (Supabase CRUD)
│
├── supabase/migrations/         # 数据库 Schema 迁移 (20+ SQL)
├── scripts/                     # 运维脚本 & Cron 入口
│   ├── deploy.sh                #   一键部署
│   ├── cron-sync-leads.js       #   线索同步 (30s)
│   ├── cron-process-queue.js    #   队列兜底 (10s)
│   ├── cron-generate-reports.js #   AI 报告
│   └── cron-recover-orchestrator.js # 编排恢复
├── tests/                       # unit / integration / e2e
└── ecosystem.config.cjs         # PM2 进程配置
```

---

## Core Flows

### Flow 1 — WhatsApp 消息处理

客户从 WhatsApp 发消息到线索入库的全链路：

```mermaid
sequenceDiagram
    participant C as Customer (WhatsApp)
    participant WH as POST /api/webhook
    participant Q as message_queue (Supabase)
    participant QP as Queue Processor
    participant AR as Agent Router
    participant AI as Claude (tool-use loop)
    participant DB as Supabase
    participant F as Feishu Bot

    C->>WH: 发送消息 (text / image / audio / doc)
    WH->>WH: 解析消息类型 + 提取广告归因 (referral)
    WH->>DB: upsertContact + upsertConversation + insertMessage
    WH->>Q: enqueueMessage (process_after = now + 2s)

    Note over Q: 2s 聚合窗口<br/>合并同一客户的连续消息

    Q->>QP: 触发 (Webhook 回调 / Cron 10s 兜底)
    QP->>DB: RPC acquire_queue_messages<br/>(SELECT FOR UPDATE SKIP LOCKED)
    QP->>AR: routeToAgent(contact, messages)
    AR->>AI: Claude 选择最佳 Agent (按产品线匹配)
    AI-->>AR: agent_id

    QP->>AI: Agent Runtime 多轮对话
    Note over AI: tool-use loop:<br/>搜索知识库 / 计算报价 /<br/>提取线索字段 / 评分

    AI-->>QP: 回复文本 + 线索数据 + score_delta

    QP->>DB: updateLead (score, stage, route, fields)
    QP->>C: 发送 WhatsApp 回复

    alt route = HUMAN_NOW (高意向)
        QP->>F: 飞书通知 → 人工接管
    end
    alt route = FAQ_END
        QP->>QP: 自动关闭对话
    end
```

**关键设计点：**

| 设计 | 说明 |
|------|------|
| **消息聚合** | 客户连续发多条消息时等 2s 合并为一次 LLM 调用，降本提效 |
| **分布式锁** | `SELECT FOR UPDATE SKIP LOCKED` 保证多实例不重复处理 |
| **Agent 路由** | Claude 根据对话上下文 + 产品信号自动选择 Agent（汽配/农机等） |
| **线索评分** | 每轮对话更新 score/stage/route，达阈值触发飞书通知人工 |
| **Cron 兜底** | `queue-cron` 每 10s 检查，防止 Webhook 回调丢失 |

### Flow 2 — AI 广告投放编排 (Campaign Studio)

从用户输入需求到广告上线的 5 阶段自动化流程：

```mermaid
sequenceDiagram
    participant U as 运营人员 (Browser)
    participant API as POST /api/campaign/orchestrate/:id
    participant SSE as GET .../stream (SSE)
    participant O as Orchestrator Agent (Claude)
    participant R as Research Agent
    participant S as Strategy Agent
    participant CP as Creative Plan Agent
    participant CR as AIGC Service
    participant EX as Execution Agent
    participant Meta as Meta Ads API
    participant Redis as Redis Stream

    U->>API: 发送需求消息 (文字 + 图片)
    API->>Redis: 初始化 SSE Stream
    U->>SSE: 建立 SSE 连接

    rect rgb(240, 248, 255)
    Note over O: Phase 0: Intake — 需求收集
    O->>U: 追问预算 / 市场 / 产品 / 落地页
    U->>O: 补充信息
    O->>O: save_brief() → brief_completed
    end

    rect rgb(240, 255, 240)
    Note over O: Phase 1+2: 可并行 (mergeGenerators)
    par Research
        O->>R: run_phase("research")
        R->>R: Firecrawl + Google Trends + 竞品分析
        R-->>Redis: research_section 逐模块实时推送
        R-->>O: 9 模块调研报告
    and Meta Assets
        O->>Meta: get_meta_assets (Page / Pixel / 账户)
        Meta-->>O: 资产列表
    end
    end

    O->>S: run_phase("strategy")
    S-->>O: 媒体计划 (预算分配 / 受众 / 版位)

    O->>CP: run_phase("creative_plan")
    CP-->>O: 3 组创意任务规格

    rect rgb(255, 248, 240)
    Note over CR: Phase 4: Creative — 并发生成
    O->>CR: run_phase("creative")
    CR->>CR: OpenRouter 批量生成图片
    CR-->>Redis: creative_item 逐张实时推送
    CR-->>O: 素材 URLs
    end

    O->>U: approval_required (执行审批)
    U->>O: 确认执行

    O->>EX: run_phase("execution")
    EX->>Meta: 创建 Campaign + AdSet + Ad (PAUSED)
    EX-->>O: 广告 IDs
    O->>U: completed ✓
```

**Phase 依赖关系 & 编排规则：**

```mermaid
graph LR
    Intake["Intake<br/>需求收集"] --> Research["Research<br/>市场调研"]
    Intake --> Assets["Get Meta Assets<br/>账户资产"]
    Research --> Strategy["Strategy<br/>预算策略"]
    Assets --> Strategy
    Strategy --> CreativePlan["Creative Plan<br/>创意规划"]
    CreativePlan --> Creative["Creative<br/>素材生成"]
    Creative --> Execution["Execution<br/>广告创建"]

    style Intake fill:#e3f2fd
    style Research fill:#e8f5e9
    style Assets fill:#e8f5e9
    style Strategy fill:#fff3e0
    style CreativePlan fill:#fce4ec
    style Creative fill:#f3e5f5
    style Execution fill:#e0f2f1
```

| 设计 | 说明 |
|------|------|
| **并行执行** | `mergeGenerators()` 合并多个 async generator，互不依赖的阶段并发 |
| **实时预览** | Research/Creative 阶段通过 SSE 逐模块/逐张推送，前端渐进渲染 |
| **级联失效** | 上游重跑时自动清除下游结果（strategy 重跑 → creative + execution 失效）|
| **审批卡点** | Execution 前必须用户确认，广告创建后默认 PAUSED |
| **错误修复** | 阶段失败时先查 `fix_knowledge` 历史方案，修复后记录经验 |

### Flow 3 — SSE 实时推送 & 断线重连

```mermaid
sequenceDiagram
    participant B as Browser
    participant Stream as GET .../stream
    participant Redis as Redis Stream (TTL 4h)
    participant Worker as Orchestrator<br/>(Next.js after())

    Worker->>Redis: XADD sse:{briefId} event1
    Worker->>Redis: XADD sse:{briefId} event2

    B->>Stream: GET ?lastEventId=0-0
    Stream->>Redis: XRANGE sse:{briefId} 0-0+ (补发历史)
    Redis-->>B: event1, event2 (replay)

    loop Real-time streaming
        Stream->>Redis: XREAD BLOCK 30000 (阻塞等待新事件)
        Worker->>Redis: XADD event3
        Redis-->>Stream: event3
        Stream-->>B: SSE data: event3
    end

    Note over B: 网络断开...
    Note over B: 自动重连，携带 lastEventId

    B->>Stream: GET ?lastEventId=event2-id
    Stream->>Redis: XRANGE (从断点补发)
    Redis-->>B: event3 (补发遗漏)
    Stream->>Redis: XREAD BLOCK (继续实时)
```

**设计要点：**
- SSE 事件持久化到 Redis Stream（4h TTL），断线重连自动从 `lastEventId` 补发
- `after()` (Next.js) 让编排在 HTTP 响应返回后异步执行，不阻塞请求
- `XREAD BLOCK` 使用独立 Redis 连接，避免阻塞主连接池

---

## Data Model

### Core Tables (ER Diagram)

```mermaid
erDiagram
    contacts ||--o{ conversations : has
    conversations ||--o{ messages : contains
    conversations ||--o| leads : generates
    agents ||--o{ conversations : serves

    contacts {
        uuid id PK
        text wa_id UK "WhatsApp E.164"
        text bsuid UK "Business Scoped User ID"
        text name
        text company_name
        jsonb metadata
    }

    conversations {
        uuid id PK
        uuid contact_id FK
        uuid agent_id FK
        text status "active / idle / closed"
        int message_count
        bool is_human_takeover
        text meta_ad_id "广告归因"
    }

    messages {
        uuid id PK
        uuid conversation_id FK
        text role "user / assistant / operator"
        text content
        int score_delta
        jsonb metadata "media_url / referral"
    }

    leads {
        uuid id PK
        uuid conversation_id FK
        text stage "GREET / QUALIFY / PROOF"
        int score "0-100"
        text route "CONTINUE / HUMAN_NOW / FAQ_END"
        text destination_country
        jsonb extracted_fields
    }

    agents {
        uuid id PK
        text name
        text product_line UK
        text system_prompt
        jsonb qualification_config
    }

    campaign_briefs ||--|| orchestrator_sessions : drives
    campaign_briefs {
        uuid id PK
        uuid user_id FK
        text status "draft / collecting / completed"
        jsonb brief "budget / countries / products"
    }

    orchestrator_sessions {
        uuid id PK
        uuid brief_id FK
        text status "intake / running / completed / failed"
        text current_phase
        jsonb phase_results
    }

    orchestrator_sessions ||--o{ orchestrator_messages : logs
    orchestrator_messages {
        uuid id PK
        uuid session_id FK
        text phase
        text role "user / assistant / tool / event"
        text tool_name
        jsonb tool_input
        jsonb tool_result
        int message_index
    }
```

### Knowledge Base Tables

```mermaid
erDiagram
    kb_documents ||--o{ kb_knowledge_points : contains
    agents ||--o{ kb_documents : owns

    kb_documents {
        uuid id PK
        uuid agent_id FK
        text filename
        text layer "company / product / logistics"
        text source_type "file / feishu / chat_extract"
        text status "pending / processing / ready"
    }

    kb_knowledge_points {
        uuid id PK
        uuid doc_id FK
        text content_original
        text content_en
        vector embedding_original "1536d"
        vector embedding_en "1536d"
        text layer
        int authority_level "1-5"
    }

    kb_products {
        uuid id PK
        text sku UK
        text product_name
        jsonb specs "GIN indexed"
        numeric fob_price_usd
    }

    kb_shipping_routes {
        uuid id PK
        text origin_port
        text destination_country
        numeric cost_per_unit_usd
        int transit_days
    }
```

### Key Design Patterns

| 模式 | 说明 |
|------|------|
| **双标识符联系人** | `wa_id` + `bsuid` 至少一个非空，查询时 bsuid 优先 |
| **消息聚合队列** | `message_queue` + `SELECT FOR UPDATE SKIP LOCKED` 分布式锁 |
| **对话 Agent 作用域** | 同联系人 × 同 Agent 最多 1 个活跃对话（部分唯一索引）|
| **pgvector 双语嵌入** | `kb_knowledge_points` 中英文双向量，分层 RPC 检索 |
| **级联失效** | 编排上游阶段重跑 → 自动 delete 下游 `phase_results` |

---

## PM2 Process Model

生产环境由 PM2 管理 5 个常驻进程，配置见 `ecosystem.config.cjs`：

```
┌──────────────────────────────────────────────────────────────┐
│  PM2 Daemon                                                  │
│                                                              │
│  ┌────────────────────────┐  Port 3002, fork, max 1GB        │
│  │  1. lead-engine-next   │  Next.js 主进程                  │
│  └────────────────────────┘                                  │
│  ┌────────────────────────┐  setInterval 30s, max 256MB      │
│  │  2. lead-sync-cron     │  线索同步                        │
│  └────────────────────────┘                                  │
│  ┌────────────────────────┐  setInterval 10s, max 256MB      │
│  │  3. queue-cron         │  消息队列兜底                     │
│  └────────────────────────┘                                  │
│  ┌────────────────────────┐  每分钟检查, 08:00 CST 触发       │
│  │  4. report-cron        │  AI 报告生成                     │
│  └────────────────────────┘                                  │
│  ┌────────────────────────┐  setInterval 60s, max 256MB      │
│  │  5. orchestrator-recovery│ 编排会话恢复                   │
│  └────────────────────────┘                                  │
│                                                              │
│  日志: logs/{app,lead-sync,queue-cron,report-cron,           │
│              orchestrator-recovery}-{out,error}.log           │
└──────────────────────────────────────────────────────────────┘
```

### Process 1: `lead-engine-next` — Next.js 主进程

Next.js App 本身，承载所有前端页面渲染（SSR/RSC）和 API Route Handlers。

```mermaid
graph LR
    Browser["Browser"] -->|HTTP| Next["lead-engine-next :3002"]
    WA["WhatsApp Cloud API"] -->|POST /api/webhook| Next
    Next -->|read/write| DB["Supabase"]
    Next -->|XADD/XREAD| Redis["Redis"]
    Next -->|API call| Claude["Claude AI"]
    Next -->|API call| Meta["Meta Ads API"]
```

**职责：**
- 前端页面 SSR + 静态资源服务
- 所有 API Routes（~60 个），包括 WhatsApp Webhook 接收、Campaign SSE 推流、CRUD 等
- Campaign Orchestrator 的实际执行体（通过 `after()` 异步运行，不阻塞 HTTP 响应）
- 对外唯一暴露端口（3002），4 个 cron 进程均通过 HTTP 调用此进程的 `/api/cron/*` 端点

### Process 2: `lead-sync-cron` — 线索同步到外部 SCM

**脚本：** `scripts/cron-sync-leads.js` → `POST /api/cron/sync-leads`

每 30 秒将运营人员审核通过（approved）的线索同步到外部 SCM 系统（REVO）。

```mermaid
flowchart TD
    A["setInterval 30s"] --> B["查询 leads 表<br/>approved=true, 近 24h"]
    B --> C{"已成功同步?<br/>(lead_sync_logs)"}
    C -->|是| Skip["跳过"]
    C -->|否| D{"有可重试的<br/>失败记录?"}
    D -->|是| E["incrementRetryCount<br/>→ 重试"]
    D -->|否| F["createSyncLog<br/>→ 首次同步"]
    E --> G["调用外部 SCM API<br/>(REVO_SCM_API_KEY)"]
    F --> G
    G --> H["updateSyncLog<br/>(success / failed)"]
    H -->|failed & retry < 3| A
```

**内部逻辑：**
1. 查询 `leads` 表中 `approved=true` 且近 24h 的记录
2. 对比 `lead_sync_logs` 表，过滤已成功同步的，识别可重试的失败记录
3. 调用外部 REVO SCM API 批量推送（每批最多 100 条）
4. 将同步结果（success/failed/external_id）写回 `lead_sync_logs`
5. 失败记录保留，下一轮自动重试（最多 3 次）

### Process 3: `queue-cron` — 消息队列兜底处理

**脚本：** `scripts/cron-process-queue.js` → `GET /api/cron/process-queue`

每 10 秒扫描 `message_queue` 表，处理因 Webhook 回调丢失或进程崩溃而未消费的消息。这是消息处理链路的**兜底保障**——正常情况下消息由 Webhook 直接触发处理。

```mermaid
flowchart TD
    A["setInterval 10s"] --> B["releaseStaleLocks()<br/>清理超时 30s 的锁"]
    B --> C["getConversationsWithPendingMessages()<br/>查 message_queue<br/>status=pending & process_after < now"]
    C --> D{"有待处理<br/>的对话?"}
    D -->|否| Done["静默返回"]
    D -->|是| E["对每个 conversation_id"]
    E --> F["processConversationQueue()"]
    F --> F1["acquire_queue_messages<br/>(SELECT FOR UPDATE SKIP LOCKED)"]
    F1 --> F2["合并同一客户的多条消息"]
    F2 --> F3["Agent Router → 选择 Agent"]
    F3 --> F4["Agent Runtime → Claude tool-use loop"]
    F4 --> F5["发送 WhatsApp 回复"]
    F5 --> F6["更新 lead score / stage / route"]
    F6 --> F7["标记 queue status=completed"]
```

**内部逻辑：**
1. `releaseStaleLocks()` — 通过 RPC 释放锁定超过 30s 的任务（处理进程崩溃场景）
2. 查询 `message_queue` 中 `status=pending` 且 `process_after < now` 的对话
3. 对每个对话调用 `processConversationQueue()`：
   - 原子获取任务（`SELECT FOR UPDATE SKIP LOCKED`，多实例安全）
   - 聚合同一客户的连续消息为一次 LLM 调用
   - Agent Router 选择产品线 Agent → Agent Runtime 执行多轮 tool-use
   - 发送 WhatsApp 回复，更新线索评分，高意向触发飞书通知

### Process 4: `report-cron` — AI 报告自动生成

**脚本：** `scripts/cron-generate-reports.js` → `POST /api/cron/generate-reports`

每分钟检查时间，在每天 **08:00 CST（北京时间）** 触发一次报告生成。根据日期自动决定生成哪些类型的报告。

```mermaid
flowchart TD
    A["setInterval 60s"] --> B{"当前是<br/>08:00 CST?"}
    B -->|否| Done["跳过"]
    B -->|是| C{"今天已运行过?"}
    C -->|是| Done
    C -->|否| D["确定报告类型"]
    D --> D1["Daily 报告 (每天)"]
    D --> D2{"周一?"}
    D2 -->|是| D3["+ Weekly 报告"]
    D --> D4{"1 号?"}
    D4 -->|是| D5["+ Monthly 报告"]
    D1 & D3 & D5 --> E["对每种类型"]
    E --> F{"ai_reports 中<br/>已存在?"}
    F -->|completed| Skip["跳过"]
    F -->|不存在| G["generateReport()<br/>AI 生成报告内容"]
    G --> H["写入 ai_reports"]
    H --> I["扫描 status=failed<br/>& retry_count < 3"]
    I --> J["retryReport()<br/>重试失败的报告"]
```

**内部逻辑：**
1. 每分钟检查是否到达 08:00 CST，防止重复执行（`lastRunDate` 去重）
2. 根据星期和日期确定生成类型：Daily（每天）、Weekly（周一）、Monthly（1 号）
3. 对每种类型调用 `generateReport()`，AI 分析询盘/线索/广告数据生成报告
4. 去重：`ai_reports` 表 UNIQUE `(type, period_start, period_end)` 防止重复
5. 自动重试：扫描 `status=failed` 且 `retry_count < 3` 的历史失败报告

### Process 5: `orchestrator-recovery` — Campaign 编排会话恢复

**脚本：** `scripts/cron-recover-orchestrator.js` → `GET /api/cron/recover-orchestrator`

每 60 秒扫描卡住的 Campaign 编排会话（服务器崩溃、超时等），从断点自动恢复。

```mermaid
flowchart TD
    A["setInterval 60s"] --> B["查询 orchestrator_sessions<br/>status=running<br/>updated_at < 5 分钟前<br/>updated_at > 24 小时内"]
    B --> C{"有卡住的<br/>会话?"}
    C -->|否| Done["静默返回"]
    C -->|是| D["对每个 session (最多 5 个)"]
    D --> E["orchestrate(session_id)<br/>从 checkpoint 恢复执行"]
    E --> F["drainToRedis(generator, key)<br/>事件写入 Redis Stream"]
    F --> G{"恢复成功?"}
    G -->|是| H["日志记录 recovered"]
    G -->|否| I["标记 status=interrupted<br/>防止无限重试"]
```

**内部逻辑：**
1. 查询 `orchestrator_sessions` 中 `status=running` 且 `updated_at` 超过 5 分钟的会话（卡住判定）
2. 排除超过 24 小时的会话（过旧不再恢复），每轮最多处理 5 个
3. 调用 `orchestrate(sessionId)` — 编排器内置断点恢复逻辑，读取 `phase_results` 跳过已完成阶段
4. 事件通过 `drainToRedis()` 写入 Redis Stream，前端 SSE 重连后可自动接收
5. 恢复失败的会话标记为 `interrupted`，避免下一轮继续重试造成循环

### 进程间通信关系

```mermaid
graph TB
    subgraph PM2
        Main["1. lead-engine-next<br/>:3002"]
        Sync["2. lead-sync-cron"]
        Queue["3. queue-cron"]
        Report["4. report-cron"]
        Recovery["5. orchestrator-recovery"]
    end

    Sync -->|"POST /api/cron/sync-leads"| Main
    Queue -->|"GET /api/cron/process-queue"| Main
    Report -->|"POST /api/cron/generate-reports"| Main
    Recovery -->|"GET /api/cron/recover-orchestrator"| Main

    Main -->|read/write| DB["Supabase"]
    Main -->|stream| Redis["Redis"]
```

> **设计说明：** 4 个 cron 进程本身不包含业务逻辑，仅作为定时触发器通过 HTTP 调用主进程的 `/api/cron/*` 端点。这样做的好处是：业务逻辑集中在一个进程中维护，cron 进程无需加载 Next.js 也无需直连数据库，且可通过浏览器手动调用同一端点进行测试。

---

## Quick Start

### Prerequisites

- Node.js >= 18
- Redis (local or remote)
- Supabase project (migrations applied)

### 本地开发

```bash
# 安装依赖
npm install --legacy-peer-deps

# 配置环境变量
cp .env.demo .env.local
# 编辑 .env.local 填入实际密钥 (参考下方环境变量表)

# 数据库迁移
# 在 Supabase Dashboard 或 CLI 中执行 supabase/migrations/ 下的 SQL

# 启动开发服务器
npm run dev          # http://localhost:3002

# (可选) 启动后台进程
npm run cron:start   # lead-sync
npm run queue:start  # queue-processor
```

### 部署

```bash
npm run deploy       # 打包 → scp → 远程构建 → PM2 全量重启
```

### 测试

```bash
npm test             # Vitest 单元测试
```

---

## Environment Variables

完整配置见 `src/config.js`，关键变量：

| 变量 | 用途 | 必填 |
|------|------|------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 项目 URL | Yes |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Supabase Anon Key | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Service Role (server only) | Yes |
| `OPENROUTER_API_KEY` | OpenRouter API Key (LLM + AIGC) | Yes |
| `WA_TOKEN` | WhatsApp Cloud API Token | Yes |
| `WA_PHONE_NUMBER_ID` | WhatsApp 发送号码 ID | Yes |
| `WA_VERIFY_TOKEN` | Webhook 验证令牌 | Yes |
| `REDIS_URL` | Redis 连接地址 | Yes |
| `META_SYSTEM_TOKEN` | Meta Marketing API Token | Campaign |
| `META_AD_ACCOUNT_ID` | Meta 广告账户 ID | Campaign |
| `FIRECRAWL_API_KEY` | Firecrawl 网页抓取 | Campaign |
| `SERPAPI_KEY` | SerpAPI Google Trends | Campaign |
| `OPENAI_API_KEY` | Whisper 语音转文字 | Optional |
| `DEMO_MODE` | `true` 跳过登录 | Optional |

---

## Development Conventions

- **改数据库 Schema** — 新建 `supabase/migrations/NNN_xxx.sql`，不直接在控制台改
- **新增字段前先查表关系** — 能用 JOIN 就不加冗余列（见 `CLAUDE.md`）
- **`src/` 不 import React/Next** — 必须对 runtime 中立，能被脚本和 API 同时调用
- **测试必须真跑** — 不能只做静态 review（见 `CLAUDE.md`）
- 更多约定见 `CLAUDE.md`
