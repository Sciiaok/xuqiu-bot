# Lead Engine 全功能 Launch Release（LR）

更新时间：2026-02-20  
适用范围：`lead-engine-next` 当前主干全部功能  
发布基线：`main@d09c705`

## 1. 发布目标
本次 LR 目标是发布并验证整个系统端到端能力：
1. WhatsApp 消息接入与聚合处理。
2. Claude 驱动的意图识别、询盘抽取、路线决策。
3. Leads/InBox/Contacts 管理后台可用。
4. 人工发送消息、线索审批、外部系统同步可用。
5. 队列容灾 Cron 与健康检查可用。

## 2. 系统功能全清单（全代码范围）

### 2.1 Web 与鉴权
1. 登录页：`/login`（Supabase Auth 密码登录）。
2. 受保护后台：`/dashboard/*` 通过 `middleware.js` 鉴权，未登录自动重定向登录页。
3. 主题切换（亮/暗）与侧边栏导航（Leads/Inbox/Contacts）。

### 2.2 Leads 管理（销售工作台）
1. 列表查询与展示：线索基础信息、询盘质量、商业价值、会话摘要、同步状态。
2. 过滤能力：询盘质量、商业价值、客户名、车型。
3. 批量动作：
1. `Approve All Filtered`
2. `Sync 24h Approved`
3. `Sync Filtered`
4. 单条动作：编辑线索、审批线索。
5. 编辑能力：车型、目的国/港口、数量、Incoterm、多字段更新。

### 2.3 Inbox 会话中心
1. 联系人列表 + 会话消息 + 线索侧栏三栏布局。
2. 默认行为：页面打开自动选中第一个联系人并加载该联系人消息。
3. 性能优化：其他联系人按点击懒加载消息/线索，降低首屏压力。
4. 实时能力：对当前联系人会话订阅 `messages`/`leads` 变更，实时更新 UI。
5. 人工发信：通过 `/api/send-message` 发送 WhatsApp 消息并写入会话。

### 2.4 Contacts 客户视图
1. 联系人列表查询。
2. 单联系人统计：总线索数、活跃线索数、会话数、消息数。
3. 支持跳转到 Inbox 继续跟进。

### 2.5 WhatsApp 接入与消息处理
1. `GET /api/webhook`：Webhook 验签。
2. `POST /api/webhook`：接收 WhatsApp 文本/语音消息。
3. 语音处理：调用 Whisper 转文本。
4. 消息入队：写入 `message_queue`（去重、聚合窗口）。
5. 定时触发：聚合窗口到期后触发 `/api/webhook/process`。

### 2.6 消息队列与容灾
1. 队列聚合：短时间多条消息合并一次 Claude 调用。
2. 分布式锁：`acquire_queue_messages` + `FOR UPDATE SKIP LOCKED`。
3. 重试与失败：失败重试，超过阈值标记失败。
4. 容灾回收：释放陈旧锁，恢复 crashed instance 场景。
5. 兜底 Cron：`/api/cron/process-queue` 周期扫描处理遗留 pending。

### 2.7 AI 业务引擎
1. Claude Prompt 内置意图识别规则。
2. 输出 JSON Schema：`conversation_intent / inquiry_quality / business_value / leads / route / next_message / handoff_summary`。
3. 多线索抽取：同会话可输出多个 lead。
4. 路由决策：`CONTINUE / HUMAN_NOW / FAQ_END`。
5. 全局轮次保护：超轮次强制 `FAQ_END`。

### 2.8 路由与协同
1. `HUMAN_NOW`：调用 n8n webhook 给销售。
2. `FAQ_END`：发送 FAQ 与官网资源。
3. `CONTINUE`：继续自动对话。
4. 会话级路由：可对会话中全部活跃 leads 执行统一路由。

### 2.9 对外同步（SCM）
1. 人工同步入口：`POST /api/leads/sync`。
2. 自动同步入口：`POST /api/cron/sync-leads`（支持 `CRON_SECRET`）。
3. 批量扩展：按 `color_quantity` 将一个 lead 扩展为多条 external inquiry。
4. 同步日志：`lead_sync_logs` 记录请求、结果、重试、外部单号。

### 2.10 运维/脚本能力
1. 部署脚本：`scripts/deploy.sh`（打包、上传、构建、PM2 重启）。
2. 定时脚本：
1. `scripts/cron-sync-leads.js`（30s）
2. `scripts/cron-process-queue.js`（10s）
3. 线索重跑回归：`scripts/reprocess-leads.js`。
4. 其它辅助：`scripts/merge-conversations.js`、`scripts/analyze-contact.js`。

## 3. API 全量发布面

### 3.1 业务 API
1. `GET /api/health`：健康检查。
2. `GET /api/webhook`：Meta 验签。
3. `POST /api/webhook`：接收 WhatsApp 消息。
4. `POST /api/webhook/process`：处理单会话队列。
5. `GET /api/webhook/process`：释放 stale lock/健康检查。
6. `POST /api/send-message`：人工发送消息（需登录）。
7. `POST /api/leads/approve`：批量审批。
8. `POST /api/leads/sync`：人工同步。
9. `GET /api/leads/[id]`：线索详情。
10. `PATCH /api/leads/[id]`：线索编辑。

### 3.2 Cron API
1. `POST /api/cron/sync-leads`。
2. `GET /api/cron/sync-leads`（手动测试兼容）。
3. `GET /api/cron/process-queue`。

## 4. 数据库与迁移发布清单

### 4.1 核心表
1. `contacts`
2. `conversations`
3. `messages`
4. `leads`
5. `message_queue`
6. `lead_sync_logs`（由 batch sync 相关迁移引入）

### 4.2 迁移文件（当前仓库）
1. `supabase/migrations/001_four_table_schema.sql`
2. `supabase/migrations/002_verify_migration.sql`
3. `supabase/migrations/003_batch_sync_schema.sql`
4. `supabase/migrations/004_message_queue.sql`
5. `supabase/migrations/005_add_unique_constraints.sql`
6. `supabase/migrations/006_multi_lead_support.sql`
7. `supabase/migrations/007_remove_message_lead_id.sql`
8. `supabase/migrations/008_multi_intent_support.sql`
9. `supabase/migrations/2026-02-18-add-inquiry-quality-fields.sql`
10. `supabase/migrations/2026-02-20-add-company-name-and-drop-incoterm-check.sql`

### 4.3 本期重点结构变化
1. `leads` 新增 `company_name`。
2. `leads.incoterm` 去除单值约束，允许多值（如 `FOB,CIF`）。
3. `leads` 支持 `inquiry_quality / business_value / conversation_intent_summary`。
4. `messages` 删除冗余 `lead_id`，统一通过 `conversation_id` 关联。

## 5. 环境变量与发布前提

### 5.1 必填
1. `NEXT_PUBLIC_SUPABASE_URL`
2. `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`
3. `ANTHROPIC_API_KEY`
4. `OPENAI_API_KEY`
5. `WA_TOKEN`
6. `WA_PHONE_NUMBER_ID`
7. `WA_VERIFY_TOKEN`
8. `REVO_SCM_API_KEY`

### 5.2 建议配置
1. `CRON_SECRET`
2. `NEXT_PUBLIC_APP_URL`
3. `CLAUDE_MODEL`
4. `QUEUE_AGGREGATION_MS`
5. `QUEUE_MAX_RETRIES`
6. `QUEUE_LOCK_TIMEOUT_MS`
7. `N8N_WEBHOOK_HUMAN_NOW`
8. `N8N_WEBHOOK_NURTURE`

## 6. 发布步骤（Runbook）

### 6.1 预发布
1. 确认代码基线：`git rev-parse --short HEAD`。
2. 执行数据库迁移（按顺序，先 staging 后 production）。
3. 检查 `.env.local` 或生产环境同名变量完整。
4. 检查 WhatsApp webhook 与 Meta 配置一致。

### 6.2 应用发布
1. 本地/CI 构建：`npm run build`。
2. 服务器部署：`./scripts/deploy.sh`。
3. 确认 PM2 进程：
1. `lead-engine-next`
2. `lead-sync-cron`
3. `queue-cron`

### 6.3 上线后检查
1. 访问 `/api/health` 返回 `status=ok`。
2. 登录 `/login` 成功后可进入 `/dashboard`。
3. Leads 页面可加载、筛选、编辑、审批。
4. Inbox 页面打开即默认加载首联系人消息。
5. 手动发送消息成功并回写会话。
6. 模拟 webhook 入站消息后可看到队列消费与 AI 回复。
7. 执行一次 `/api/cron/process-queue` 返回正常。
8. 执行一次 `/api/cron/sync-leads`（带授权）返回正常。

## 7. 验收清单（全功能 Smoke Test）
1. 登录/登出流程完整。
2. 未登录访问 `/dashboard/*` 被重定向到 `/login`。
3. Leads 过滤条件与列表数量一致。
4. 编辑后字段持久化正确。
5. Approve 与 Sync 按钮行为正确。
6. Inbox 仅当前联系人触发实时订阅并更新消息。
7. 多条连续消息被聚合为一次 AI 处理。
8. 语音消息可转写并进入同一处理链路。
9. `HUMAN_NOW` 路由时 n8n webhook 收到 payload。
10. `FAQ_END` 时用户收到 FAQ 资源消息。
11. 外部同步成功后 `lead_sync_logs` 状态更新为 `success`。

## 8. 监控与告警建议
1. API 可用性：`/api/health`、`/api/webhook`、`/api/cron/*`。
2. 队列积压：`message_queue` 中 `pending/processing/failed` 数量。
3. 同步成功率：`lead_sync_logs` 的 success/failed 比例。
4. PM2 进程状态与重启频率。
5. Claude/Whisper/WhatsApp 外部接口失败率。

## 9. 风险与回滚

### 9.1 主要风险
1. 外部依赖不可用（Anthropic/OpenAI/WhatsApp/SCM/n8n）。
2. 数据库迁移与现网数据不兼容。
3. 队列锁异常导致消息延迟或重复处理。
4. 外部同步 API 失败引发批量重试堆积。
5. AI 单调用链路耦合较高，规则变更时回归范围大。
6. 联系人/会话规模继续增长后，后台列表查询与统计接口可能出现慢查询。
7. 高频入站消息在极端峰值下可能超过当前队列处理能力。
8. 外部同步批处理单次 payload 过大时，失败重试会放大下游压力。

### 9.2 遗留风险（本期未完全解决）
1. Inbox/Contacts/Leads 仍存在部分页面级聚合查询，数据量上来后需要进一步分页与缓存。
2. 消息处理目前以单会话串行为主，尚未形成基于优先级的全局调度机制。
3. AI 输出质量校验主要依赖 Prompt 与基础 JSON 约束，缺少更细粒度规则引擎。
4. 多外部依赖失败时虽可降级，但缺少统一熔断/限流策略中心。
5. 可观测性以日志为主，尚未建立端到端 tracing 与统一 SLO 面板。

### 9.3 回滚策略
1. 应用回滚：部署上一稳定 commit 并重启 PM2。
2. 队列保护：暂停 webhook 入站或临时停 `queue-cron`，避免错误扩大。
3. 同步保护：暂停 `lead-sync-cron`，避免错误数据外发。
4. 数据回滚：按迁移脚本逐项评估，优先做前向修复；涉及删列/约束变更需谨慎执行逆向 SQL。

## 10. 扩展性优化方向（高并发 / 大数据场景）

### 10.1 高并发方向
1. 引入消息总线与消费者组（如按 conversation_id 分片），替代部分应用内定时触发。
2. 队列处理增加优先级与背压机制，保障高价值会话优先处理。
3. 增加 API 限流、重试退避、熔断策略，防止外部依赖抖动时级联失败。
4. 对同步任务采用更小批次 + 幂等键，降低单批失败影响面。
5. 将 AI 调用拆分为多职能模块，支持并行或按需调用，降低单次调用时延与风险。

### 10.2 大数据方向
1. Leads/Inbox/Contacts 全面引入服务端分页与游标查询，避免全量拉取。
2. 建立冷热分层：近 30 天热数据在线，历史数据归档并按需回查。
3. 为高频过滤条件补充组合索引，并定期做慢查询审计。
4. 统计类接口改为增量聚合或物化视图，避免实时全表扫描。
5. 消息与同步日志按时间分区，降低大表维护成本。

### 10.3 架构演进方向
1. AI 能力拆分：意图识别/信息抽取/评分/路由/回复分模块。
2. 引入配置化 SKILL 编排，支持版本、灰度、A/B、快速回滚。
3. 建立统一可观测性：trace_id 串联 webhook -> queue -> AI -> routing -> sync。
4. 建立容量基线与压测机制：定义峰值 TPS、P95 延迟、错误率阈值。

## 11. 发布责任建议
1. 发布负责人：1 名（执行部署与 Go/No-Go）。
2. 数据库负责人：1 名（迁移与验证）。
3. 业务验收负责人：1 名（Leads/Inbox/Contacts 全流程）。
4. 值班窗口：发布后至少 2 小时观察。

## 12. 参考文件
1. `CLAUDE.md`
2. `ecosystem.config.cjs`
3. `scripts/deploy.sh`
4. `scripts/cron-sync-leads.js`
5. `scripts/cron-process-queue.js`
6. `lib/queue-processor.js`
7. `src/claude.service.js`
8. `src/routing.service.js`
9. `app/dashboard/leads/page.js`
10. `app/dashboard/inbox/page.js`
11. `app/dashboard/contacts/page.js`
