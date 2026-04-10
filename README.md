# Lead Engine

基于 Next.js 14 + Supabase 的 WhatsApp 询盘处理与广告投放平台。后端串接 Meta Marketing API、Claude (via OpenRouter)、Redis 队列；前端是投放 / 客户中心 / 询盘 / 数据看板一体的运营面板。

---

## 一、代码结构

```
LeadEngine/
├── app/                    # Next.js App Router（前端 + API routes）
│   ├── (app)/              # 受保护页面（需登录）
│   │   ├── analytics/      # 数据看板
│   │   ├── reports/        # AI 报告
│   │   ├── agents/         # 智能体管理
│   │   ├── ai-automation/  # AI 自动化投放
│   │   ├── campaign-studio/# 广告数据 / 创意 pipeline
│   │   ├── leadhub/        # 询盘
│   │   ├── inbox/          # 客户中心 / 对话
│   │   ├── knowledge-base/ # 知识库
│   │   ├── layout.js       # 受保护区域布局（含 Sidebar）
│   │   └── page.js         # 根路由，重定向到 /analytics
│   ├── (auth)/             # 未登录可见
│   │   ├── login/          # /login
│   │   └── layout.js
│   ├── api/                # API Route Handlers
│   │   ├── ads/            # Meta Ads 查询 / 同步
│   │   ├── agents/         # Agent CRUD / 运行
│   │   ├── campaign/       # 投放编排 SSE
│   │   ├── contacts/       # 联系人
│   │   ├── conversations/  # 对话 / takeover
│   │   ├── cron/           # 给 PM2 cron 调用的内部接口
│   │   ├── inquiries/      # 询盘筛选 / 导出
│   │   ├── knowledge/      # 知识库搜索 / 上传
│   │   ├── leads/          # 线索 CRUD / 同步
│   │   ├── media/          # WhatsApp 媒体代理
│   │   ├── product-assets/ # 产品素材
│   │   ├── product-docs/   # 产品文档
│   │   ├── reports/        # 报告生成 / 导出
│   │   ├── send-message/   # 发送 WhatsApp 消息
│   │   └── webhook/        # WhatsApp Cloud API webhook
│   ├── components/         # 前端共享组件（Sidebar、Card、DataTable 等）
│   ├── layout.js           # 根布局（语言、Theme）
│   ├── page.js             # 根路由 → /analytics
│   ├── globals.css
│   └── v5-theme.css
│
├── src/                    # 后端服务（业务逻辑，被 API routes 调用）
│   ├── config.js           # 集中式环境配置
│   ├── claude.service.js   # Claude LLM 客户端
│   ├── llm-client.js       # 通用 LLM 抽象
│   ├── whatsapp.service.js # WhatsApp Cloud API 封装
│   ├── whatsapp-media.service.js
│   ├── whisper.service.js  # 音频转写
│   ├── feishu.service.js   # 飞书通知
│   ├── agent-router.service.js       # 智能体路由（用哪个 agent 处理）
│   ├── agent-runtime.service.js      # 智能体运行时（单轮 / 多轮推理）
│   ├── routing.service.js            # 后置路由动作（FAQ 回复 / 飞书推送）
│   ├── campaign-intake.service.js    # 广告需求采集
│   ├── campaign-orchestrator.service.js  # 广告投放全流程编排
│   ├── research-agent.service.js     # 市场调研 agent (v1)
│   ├── research-agent-v2.service.js  # 市场调研 agent (v2)
│   ├── strategy-agent.service.js     # 策略 agent
│   ├── creative-plan.service.js      # 创意规划
│   ├── execution-agent.service.js    # 投放执行 agent
│   ├── aigc.service.js               # 图片生成
│   ├── meta-account.service.js       # Meta 账号 / 广告结构
│   ├── meta-ads-mcp-client.js        # MCP 客户端
│   ├── kb-*.service.js               # 知识库搜索 / 上传 / 导入 / 自学
│   ├── product-knowledge.service.js
│   ├── product-search.service.js
│   ├── reference-collector.service.js
│   ├── inquiry-quality.js
│   └── scoring-rules.json
│
├── lib/                    # 通用工具 / 仓储层（前后端共用）
│   ├── supabase.js                 # 匿名 client（只读 public）
│   ├── supabase-browser.js         # 浏览器端 SSR client
│   ├── supabase-server.js          # 服务端 SSR client（带 auth / demo）
│   ├── redis.js                    # Redis (ioredis) 单例
│   ├── session.js                  # 会话管理
│   ├── sse.js                      # SSE server 工具
│   ├── consume-sse.js              # SSE client 工具
│   ├── demo-mode.js                # Demo 模式守卫
│   ├── i18n-utils.js
│   ├── core-trace.js               # 链路追踪
│   ├── queue-processor.js          # 消息队列处理器
│   ├── inquiries-filters.js        # 询盘筛选常量 / 标签 / 排序
│   ├── inquiry-dashboard.js        # 询盘看板聚合
│   ├── lead-extractor.js           # 从对话提取线索
│   ├── conversation-context.service.js
│   ├── agent-routing.service.js    # 对话层的 agent 分派
│   ├── referral-context.js
│   ├── car-catalog-context.js
│   ├── country-codes.js            # ISO 国家代码
│   ├── phone-country-prefixes.js   # 电话前缀 → 国家
│   ├── wa-country.js               # WhatsApp 号码归属
│   ├── repositories/               # 数据访问层（Supabase 封装）
│   ├── services/                   # 轻量业务服务
│   └── __tests__/
│
├── scripts/                # 运维 / cron / 一次性脚本
│   ├── deploy.sh                   # 部署脚本（打包 → scp → 远程 build → pm2 restart）
│   ├── cron-sync-leads.js          # 定时同步线索（PM2 服务）
│   ├── cron-process-queue.js       # 定时处理消息队列（PM2 服务）
│   ├── cron-generate-reports.js    # 定时生成报告（PM2 服务）
│   ├── cron-recover-orchestrator.js# 定时恢复 orchestrator（PM2 服务）
│   ├── seed-*.js                   # Seeds（默认 agent、demo 数据）
│   └── ...                         # 其它调试 / 迁移脚本
│
├── tests/                  # 测试
│   ├── unit/               # 单元测试（vitest）
│   ├── integration/        # 集成测试（连真 API / Supabase）
│   ├── stability/          # 稳定性测试
│   ├── eval/               # LLM 评估用例
│   └── *.mjs               # 调试脚本
│
├── supabase/               # Supabase 本地 config + SQL migrations
│   └── migrations/         # 按编号命名的 DDL 文件
│
├── i18n/                   # next-intl 配置
├── messages/               # i18n 翻译资源
├── public/                 # 静态资源
├── docs/                   # 设计文档 / 发布笔记 / 想法池
│
├── middleware.js           # Supabase auth / locale 中间件
├── next.config.js
├── ecosystem.config.cjs    # PM2 进程配置
├── package.json
├── CLAUDE.md               # AI 协作约定
└── README.md
```

### 关键架构点

- **Next.js App Router**：`app/(app)` 是路由分组（URL 里不出现 `(app)`），用来共享 layout；`app/(auth)` 同理。
- **双层后端**：`src/` 放"重业务"服务（调 LLM / Meta API / WhatsApp），`lib/` 放前后端共用的轻量工具和数据仓储。API routes 只做参数校验 + 调用 `src/` 服务。
- **鉴权**：`middleware.js` 只保护 `(app)` 下的页面，`/login` 不受保护；所有 API 路由在各自 handler 里通过 `createClient()` 取当前 user。
- **PM2 常驻进程**：Next.js 主进程 + 4 个 cron 工作进程，见 `ecosystem.config.cjs`。
- **Redis**：用于消息队列、广告看板缓存（60 min TTL）、SSE 进度缓存等，所有访问统一走 `lib/redis.js`。
- **Supabase**：所有表结构在 `supabase/migrations/` 按编号演进，改 schema 必须新建 migration 文件，不直接在控制台手改。

---

## 二、开发 / 测试 / 发布规范

### 环境准备

```bash
# 1. Node.js 20 LTS（24 未验证，低于 18 跑不起来）
node -v

# 2. 安装依赖
npm install --legacy-peer-deps

# 3. 准备环境变量
cp .env.demo .env.local   # 然后按需填入真实 key
```

关键环境变量（完整列表见 `src/config.js`）：

| 变量 | 说明 |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` | Supabase 客户端 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase 服务端（后端用，不要暴露） |
| `OPENROUTER_API_KEY` 或 `ANTHROPIC_API_KEY` | LLM |
| `WA_TOKEN` / `WA_PHONE_NUMBER_ID` / `WA_VERIFY_TOKEN` | WhatsApp Cloud API |
| `META_SYSTEM_TOKEN` / `META_AD_ACCOUNT_ID` / `META_PAGE_ID` | Meta Marketing API |
| `REDIS_URL` | Redis 连接串 |
| `DEMO_MODE` | `true` 时跳过登录直接进应用 |

### 本地开发

```bash
npm run dev        # 起 Next.js dev server，端口 3002
```

浏览器打开 http://localhost:3002 —— 根路由会自动跳转到 `/analytics`。

需要本地跑 cron 服务时：

```bash
npm run cron:start   # lead-sync
npm run queue:start  # queue processor
```

### 编码规范

- **路径引用**：API routes / 页面之间尽量用相对路径；`src/` 服务从自身相对导入即可。
- **不要在 `app/api/*` 写复杂业务**：长逻辑放 `src/`，route handler 只做入参校验 / 调用 / 拼响应。
- **不要在 `src/` 里 `import` React / Next**：`src/` 必须对 runtime 中立，能被脚本和 API 同时调用。
- **改数据库 schema**：新建 `supabase/migrations/NNN_xxx.sql`，不要修改已提交的 migration。
- **新增表字段前先查现有表关系**（见 `CLAUDE.md`）：能用 join 就不要加冗余列。
- **不添加用户没要求的 fallback / 默认值 / 额外字段**（见 `CLAUDE.md`）。

### 测试

```bash
npm test                  # vitest 全部单测（无需外部依赖）
npm run test:webhook-tdd  # webhook / 多模态关键路径 TDD 套件
```

集成测试（需要真实 `.env.local`，会调外部 API，默认不在 CI 跑）：

```bash
node tests/integration-orchestrator.mjs
node tests/integration-aigc.mjs
# ... 其它 tests/integration-*.mjs / tests/e2e-*.mjs
```

规范：

- **单测必须真跑**，不能只做静态 review 就说 "looks correct"（见 `CLAUDE.md`）。
- 新功能至少配一个单测 / 集成测试用例。
- 改动 `src/` 服务时，对应 `tests/unit/*.test.js` 要跑通。
- 涉及 LLM 输出的用 `tests/eval/` 的 eval runner，不要硬断言具体文本。

### 发布

1. **本地自检**
   ```bash
   npm run build   # 必须 0 error 才能部署
   npm test
   ```

2. **提交代码**
   ```bash
   git add -p
   git commit -m "feat(xxx): ..."
   git push
   ```

3. **部署到生产（AWS EC2）**
   ```bash
   npm run deploy
   ```
   这会执行 `scripts/deploy.sh`：打包 → scp 到服务器 → 远程解压 → `npm install --legacy-peer-deps` → `npm run build` → `pm2 restart` 所有服务。

4. **验证**
   - 打开 `http://<elastic-ip>:3002/analytics` 看页面
   - `ssh aws-leadengine "pm2 status"` 查进程状态
   - `ssh aws-leadengine "pm2 logs lead-engine-next --lines 50"` 查日志

### 回滚

`deploy.sh` 本身不带回滚。要回滚：

```bash
git revert <bad-commit>     # 或 git reset 到已知好版本
git push
npm run deploy
```

紧急情况可 ssh 到服务器 `pm2 stop <service>` 立刻停服务。

### Git 约定

- 分支命名：`feat/xxx`、`fix/xxx`、`ui/xxx`、`perf/xxx`、`chore/xxx`
- Commit message 用 Conventional Commits（`feat:` / `fix:` / `perf:` / `refactor:` / `docs:` / `chore:`）
- **不要 `--no-verify` 跳过 hooks**；hook 报错先修问题再重提
- **不要 force push 到 `main`**

---

## 三、数据库（Supabase）

项目使用单一 Supabase 云端库，所有读写都由本项目发起。以下梳理 **全部表结构** 与 **代码中对数据库的所有操作**，便于新同事快速上手。

### 3.1 表清单与 Schema

#### 对话域

**`contacts` — WhatsApp 联系人**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | UUID PK | |
| wa_id | TEXT UNIQUE | 电话号 E.164 |
| bsuid | TEXT UNIQUE | Business Scoped User ID（WA 新身份标识） |
| username | TEXT | WA username |
| name / company_name | TEXT | 资料 |
| metadata | JSONB | 扩展字段 |
| created_at / updated_at | TIMESTAMPTZ | |

约束：`wa_id` 与 `bsuid` 至少一个非空。匹配时 bsuid 优先。

**`conversations` — 对话**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | UUID PK | |
| contact_id | UUID FK | → contacts |
| agent_id | UUID FK NULL | → agents（多产品线） |
| status | TEXT | active / idle / closed |
| started_at / ended_at / last_message_at | TIMESTAMPTZ | |
| message_count | INT | |
| closed_reason | TEXT | route_human / timeout / ... |
| is_human_takeover | BOOLEAN | 人工接管标志 |
| human_takeover_at | TIMESTAMPTZ | 接管开始时间（1h 超时） |
| wa_phone_number_id | TEXT | 接收号 ID |
| meta_ad_id | TEXT | 广告归因 ID |

关键：部分唯一索引 `(contact_id, COALESCE(agent_id, zero_uuid)) WHERE status='active'` —— 同一联系人对每个 agent 最多 1 个活跃对话。

**`messages` — 消息**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | UUID PK | |
| conversation_id | UUID FK CASCADE | |
| lead_id | UUID FK NULL | |
| role | TEXT | user / assistant / operator |
| content | TEXT | |
| score_delta | INT | 本条得分贡献 |
| risk_flags | TEXT[] | 风险标记 |
| sent_at | TIMESTAMPTZ | |
| sent_by | TEXT | customer / bot / operator |
| metadata | JSONB | media_url 等 |

开启 Realtime（REPLICA IDENTITY FULL）。

**`leads` — 销售线索**

核心字段：`conversation_id`、`contact_id`、`agent_id`、`meta_ad_id`、`stage`(GREET/QUALIFY/PROOF)、`score`、`route`(CONTINUE/HUMAN_NOW/NURTURE/FAQ_END)、`inquiry_quality`、`business_value`、`conversation_intent`、`conversation_intent_summary`、`destination_country`、`destination_port`、`car_model`、`product_name`、`sku_description`、`color_quantity`(JSONB)、`qty_bucket`、`buyer_type`、`timeline`、`loading_port`、`incoterm`、`brand`、`approved`/`approved_at`/`approved_by`、`handoff_summary`、`details`(JSONB)、`extra_data`(JSONB)。

唯一：`(conversation_id, lead_key) WHERE route='CONTINUE'` —— 同对话同 (车型+目的地) 最多 1 个活跃 lead。

#### 队列与同步

**`message_queue` — 消息聚合队列**

| 字段 | 类型 | 说明 |
|---|---|---|
| id | UUID PK | |
| conversation_id / contact_id | UUID FK | |
| wa_id | TEXT | |
| content / message_type | TEXT | text / audio |
| wa_message_id | TEXT UNIQUE | 去重键 |
| status | TEXT | pending / processing / completed / failed |
| process_after | TIMESTAMPTZ | 聚合窗口终点 |
| locked_at / locked_by | | 分布式锁 |
| retry_count / error_message | | |

RPC：
- `acquire_queue_messages(p_conversation_id, p_instance_id)` — `SELECT FOR UPDATE SKIP LOCKED` 原子取任务
- `release_stale_queue_locks(p_timeout_seconds)` — 清理超时锁

**`lead_sync_logs` — 外部系统（REVO SCM）同步日志**

字段：`lead_id`(CASCADE)、`external_id`、`external_no`、`status`(pending/syncing/success/failed)、`request_payload`(JSONB)、`response_payload`(JSONB)、`error_message`、`retry_count`、`synced_at`。

#### 配置与 Agent

**`agents` — 多产品线智能体**

字段：`name`、`product_line`(UNIQUE)、`system_prompt`、`output_schema`(JSONB)、`qualification_config`(JSONB)、`ad_context_map`(JSONB)、`wa_phone_number_id`、`is_active`。部分唯一约束：每个 WA 号最多绑一个活跃 agent。

#### Campaign Orchestrator

**`campaign_briefs`** — 广告创意简报。字段：`status`(draft/collecting/completed/expired)、`brief`(JSONB)、`completion`(JSONB)、`expires_at`。

**`orchestrator_sessions`** — 编排运行会话。字段：`brief_id`、`status`(draft/running/awaiting_approval/awaiting_feedback/completed/failed)、`current_phase`、`phase_results`(JSONB)、`orchestrator_state`(JSONB)、`fix_log`(JSONB)。

**`orchestrator_messages`** — Claude API 交互历史。字段：`session_id`、`phase`、`role`(user/assistant/tool/event)、`content`、`tool_name`、`tool_use_id`、`tool_input`(JSONB)、`tool_result`(JSONB)、`attachments`(JSONB)、`message_index`。索引 `(session_id, message_index)`。

#### 知识库 v2（kb_*）

**`kb_documents`** — 文档层。`agent_id`、`filename`、`storage_path`、`layer`(company/product/logistics/compliance/sales/competitive)、`source_type`(file/feishu_doc/feishu_sheet/feishu_wiki/chat_extract/manual)、`external_id`、`sync_enabled`、`last_synced_at`、`status`(pending/processing/ready/error)、`authority_level`(1-5)、`is_authoritative`、`is_outdated`、`knowledge_points_count`。

**`kb_knowledge_points`** — 双语知识片段 + 向量嵌入。`doc_id`(CASCADE)、`agent_id`、`layer`、`content_original`、`content_en`、`source_lang`、`source_location`、`authority_level`、`effective_date`、`expires_at`、`superseded_by`(自引用)、`status`(active/expired/superseded/draft)、`embedding_original vector(1536)`、`embedding_en vector(1536)`、`metadata_json`。两套 `ivfflat vector_cosine_ops` 向量索引。RPC：`search_kb_knowledge_en / search_kb_knowledge_original(agent_id, embedding, layers, top_k)`。

**`kb_products`** — 结构化产品目录（Excel 解析）。`sku`、`product_name` / `_en`、`model`、`category`、`specs`(JSONB, GIN)、`fob_price_usd NUMERIC(10,2)`、`moq`、`lead_time_days`、`source_row`、`is_active`。

**`kb_shipping_routes`** — 物流路线。`origin_port`、`destination_port`、`destination_country`、`shipping_method`、`cost_per_unit_usd`、`transit_days`、`notes`。

**`kb_pricing_rules`** — 动态定价规则。`rule_name`、`rule_type`(quantity_discount/shipping_markup/payment_term/special_offer)、`priority`、`conditions`(JSONB)、`calculation`(JSONB)、`requires_approval`、`effective_from/until`。

**`kb_assets`** — 图片/规格书/证书等。`asset_type`、`storage_path`、`mime_type`、`file_size_bytes`、`description` / `_en`、`layer`、`linked_skus TEXT[]`(GIN)、`tags TEXT[]`、`is_sendable`。

**`kb_glossary`** — 双语术语表。`agent_id`、`term_zh`、`term_en`、`context`。

**`kb_test_messages` / `kb_knowledge_gaps`** — KB 测试会话与知识缺口跟踪。

#### 报表与其它

**`ai_reports`** — 日/周/月 AI 报告。`type`(daily/weekly/monthly/manual)、`status`(generating/completed/failed)、`agent_ids TEXT[]`、`period_start/end DATE`、`content`(JSONB)、`summary_line`、`kpi_snapshot`(JSONB)、`retry_count`、`error_message`、`generated_at`。唯一 `(type, period_start, period_end)` 限制自动报告去重。

**`inquiry_dashboard_summaries`** — 询盘仪表板 AI 总结缓存。`product_lines`(已排序逗号串)、`period_key`（"7d"/"14d"/"30d"/"custom:from:to"）、`date_from/to`、`content`(Markdown)、`generated_at`。唯一 `(product_lines, period_key)`。

**`aigc_assets`** — AI 生成创意资产。`conversation_id`(SET NULL)、`user_id`、`prompt`、`model`、`source_filename`、`product_info`(JSONB)、`storage_path`、`metadata`(JSONB)。

**`contact_notes`** — 联系人备注。`contact_id`、`body`、`author`、`created_at`。

**`fix_knowledge`** — 错误修复经验库（向量化）。配 `search_fix_knowledge` RPC。

**旧产品文档系统（已逐步淘汰）**：`product_documents`、`product_specs`、`product_embeddings`、`product_doc_operations`、`product_assets`。对应 RPC：`search_product_embeddings`、`query_product_specs`、`get_spec_fields`。

#### Storage Buckets

| Bucket | 公开 | 用途 | 策略 |
|---|---|---|---|
| `chat-media` | 否 | 对话媒体 | authenticated 全操作 |
| `product-docs` | 否 | 产品文档 PDF/Excel | authenticated |
| `kb-assets` | 否 | 知识库资产 | authenticated |
| `aigc-assets` | **是** | AI 生成资产 | public 读，authenticated 写删 |

### 3.2 代码中的数据库操作（按表分组）

> 只列关键读写点；便于查问题时定位来源。完整细节见对应 repository。

#### contacts
- `lib/repositories/contact.repository.js:10` SELECT（按 wa_id） / `:31`（按 bsuid）/ `:49`（按 id）
- `:68` INSERT 新建 / `:189` findOrCreate 竞态重试
- `:95` UPDATE 资料 / `:181` UPDATE 回填缺失的 bsuid 或 wa_id

#### conversations
- `lib/repositories/conversation.repository.js:22` SELECT 活跃对话（按 agent 作用域）/ `:51` 不限 agent / `:275` 带嵌套关系
- `:76` INSERT 新建
- `:111` UPDATE 标 idle（Cron 3 天超时）/ `:136` 关闭并记录原因 / `:167` 累加 message_count + last_message_at
- `:191` UPDATE wa_phone_number_id / `:225` UPDATE meta_ad_id
- `:318` / `:338` UPDATE 开启/结束人工接管 / `:361` / `:379` / `:412` SELECT 接管状态与超时检查
- `:427` UPDATE 绑定 agent_id（仅在未设置时）

#### messages
- `lib/repositories/message.repository.js:8` INSERT / `:37` UPDATE 评分/风险/metadata
- `:68` SELECT 分页 / `:104` 汇总 score_delta / `:122` 聚合 risk_flags

#### leads
- `lib/repositories/lead.repository.js:45` / `:65` SELECT 单条 / `:178` 列表带 join
- `:85` INSERT / `:441` 批量 INSERT（replace 策略）/ `:424` DELETE（replace 前清理）
- `:126` UPDATE 字段 / `:243` / `:266` 单/批量批准 / `:347` 综合编辑
- `:287` / `:309` SELECT 待同步 / `:329` 按 conversation+route 过滤
- API：`app/api/leads/approve/route.js`、`app/api/leads/sync/route.js`、`app/api/inquiry-dashboard/route.js`、`app/api/conversations/[id]/leads/route.js`
- 脚本：`scripts/backfill-lead-country.mjs:95` UPDATE 回填目的国

#### message_queue
- `lib/repositories/queue.repository.js:13` UPSERT 入队（wa_message_id 去重）
- `:43` RPC `acquire_queue_messages` 分布式取任务 / `:142` RPC `release_stale_queue_locks`
- `:62` SELECT 就绪检查 / `:162` SELECT 所有带 pending 的对话
- `:84` UPDATE completed / `:103` UPDATE failed + 重试

#### lead_sync_logs
- `lib/repositories/sync-log.repository.js:9` INSERT / `:30` UPDATE 状态 / `:125` 重试计数
- `:69` / `:87` / `:105` SELECT 最新/成功/可重试

#### agents
- `lib/repositories/agent.repository.js:8` SELECT 单条 / `:24` 列表
- `:44` INSERT / `:70` UPDATE 配置 / `:100` 软停用

#### Campaign Orchestrator
- `lib/repositories/campaign-brief.repository.js:90` INSERT / `:109` SELECT / `:126` UPDATE 顶级字段 / `:150` 合并 JSONB / `:173` 更新 completion
- `lib/repositories/orchestrator.repository.js:38` INSERT session / `:56`/`:67` SELECT / `:80` UPDATE / `:108` 条件 UPDATE（乐观锁）
- `:130` / `:164` INSERT 单/批量消息 / `:197` / `:229` SELECT 消息/下一个 index
- `app/api/campaign/sessions/route.js` 列表

#### 知识库 v2
- **kb_documents**：`src/kb-upload.service.js:72` INSERT / `src/kb-feishu-import.service.js` UPDATE 状态、DELETE 关联 / `app/api/knowledge/documents/route.js` 列表/删除
- **kb_knowledge_points**：`kb-upload.service.js:166` INSERT / `:323-395` 补写 embedding / `kb-auto-learn.service.js:133` 自动学习 / `app/api/knowledge/teach/route.js` 草稿 CRUD / `src/kb-search.service.js:85` RPC 向量检索
- **kb_products / kb_shipping_routes**：`kb-upload.service.js:243/299` 批量 INSERT / `kb-feishu-import.service.js:209/210` DELETE / `kb-search.service.js` 读
- **kb_pricing_rules / kb_glossary**：`app/api/knowledge/pricing-rules/route.js`、`.../glossary/route.js` CRUD
- **kb_assets**：`app/api/knowledge/assets/upload/route.js:116` INSERT
- **kb_test_messages / kb_knowledge_gaps**：`app/api/knowledge/test-chat/route.js`、`.../gaps/route.js`

#### 报表与其它
- **ai_reports**：`lib/services/report-generator.js:355` INSERT / `:382`/`:446` 写内容 / `:399`/`:463` 标记失败 / `:427` 重试重置
- **inquiry_dashboard_summaries**：`app/api/inquiry-dashboard/summary/route.js` UPSERT/SELECT 缓存
- **aigc_assets**：`src/aigc.service.js:359` INSERT / `:426` SELECT
- **contact_notes**：`app/api/contacts/[id]/notes/route.js:76` INSERT / `.../[noteId]/route.js:22` DELETE
- **fix_knowledge**：`lib/repositories/fix-knowledge.repository.js` RPC `search_fix_knowledge` / INSERT 经验 / UPDATE 成功计数

#### 旧产品文档系统（product_*）
- `app/api/product-docs/upload/route.js`、`src/product-knowledge.service.js` INSERT/UPDATE/DELETE
- RPC：`search_product_embeddings`、`query_product_specs`、`get_spec_fields`（`src/product-search.service.js`）

### 3.3 关键设计模式（上手前必读）

1. **双标识符联系人** — `wa_id` 与 `bsuid` 都可 NULL，至少一个非空。查询/匹配时 **bsuid 优先**（更可靠，WA username 场景无 wa_id）。
2. **消息聚合队列** — Webhook 入队 → `process_after` 等聚合窗口 → `SELECT FOR UPDATE SKIP LOCKED` 分布式取任务 → Cron 清理陈旧锁。避免连续消息触发多次 Claude 调用。
3. **对话多 agent 作用域** — 同联系人对 *每个 agent* 各自最多 1 个活跃对话（由部分唯一索引保证）。
4. **多 lead per conversation** — 同对话可有多个询价；Claude 刷新时走 "DELETE + 批量 INSERT" 替换策略（⚠️ 非原子，后续可改为事务 RPC）。
5. **3 天对话超时 + 1 小时人工接管超时** — 都由 Cron 检查，**读路径不触发写**，避免放大。
6. **pgvector 双语嵌入** — `kb_knowledge_points` 同时存中/英文嵌入，分层过滤的 RPC 检索。
7. **RLS** — campaign / orchestrator 等表已开启 RLS，但当前策略全开放；留作多租户隔离扩展点。
8. **架构红线**（见 `CLAUDE.md`）—— 改后端前先确认现有表关系，**优先通过 JOIN 查既有字段，而不是加冗余列**。

---

## 四、其它参考

- `CLAUDE.md` — AI 协作 / 实现风格约束
- `docs/` — 设计文档 / 发布笔记
- `ecosystem.config.cjs` — PM2 服务定义
- `middleware.js` — 受保护路由列表
