# Campaign Orchestrator Architecture

## Overview

主控 Orchestrator 是一个 Claude tool-use agent loop，负责编排广告投放全流程。核心文件：

- `src/campaign-orchestrator.service.js` — 主控逻辑
- `src/execution-agent.service.js` — Meta Ads 执行
- `app/api/campaign/orchestrate/[id]/route.js` — API 入口
- `app/api/campaign/orchestrate/[id]/stream/route.js` — SSE 重连
- `app/api/cron/recover-orchestrator/route.js` — 崩溃恢复 cron
- `app/v5/(app)/campaign-studio/page.js` — 前端

## 1. Agent Loop 结构

```
System Prompt (每轮动态组装)
  ├─ PROMPT_CORE: 静态规则
  ├─ 当前状态快照: 每个阶段的质量分/重试次数/失效标记
  └─ PROMPT_EXECUTION_ERRORS: 仅 execution 出错时注入
        │
        ▼
runToolUseLoop (max 40 轮)
  每轮迭代:
    1. checkpoint 写 DB (crash recovery)
    2. 消费 Redis 中途用户消息
    3. Claude Sonnet stream call
    4. 解析 tool_use → 执行 → 收集 tool_result
    5. 拼接 messages → 下一轮
```

### System Prompt 实时状态注入

`buildOrchestratorPrompt(phaseResults, { retryCounts, cascadeInvalidated })` 每轮 LLM 调用前重新生成，注入：

```
## 当前状态
- research: ✅ 已完成 (质量=75/100) — 问题: 缺少竞品广告分析
- strategy: ✅ 已完成 (质量=100/100, 已重试1次)
- creative_plan: ✅ 已完成 (质量=100/100)
- creative: ⚠️ 已失效（上游阶段重跑），需要重新执行
- execution: 待执行
```

确保 Agent 在长对话（20+ 轮）中不会丢失对已完成阶段的感知。

## 2. 阶段与依赖

### 阶段定义

| 阶段 | 名称 | Sub-Agent | 输出 |
|------|------|-----------|------|
| research | 市场调研 | conductResearch | 市场分析、竞品、关键词趋势 |
| strategy | 方案规划 | generateCampaignPlanParallel | 平台/预算/campaign/adset/ad 结构 |
| creative_plan | 素材策划 | generateCreativePlan | 素材任务列表 + 参考图片 |
| creative | 素材生成 | generateFromDocument ×N | 各广告的图片 URL |
| execution | 投放执行 | executeMediaPlan | Meta campaign/adset/ad 创建结果 |

### 依赖关系 (PHASE_DOWNSTREAM)

```
research → strategy → creative_plan → creative → execution
```

上游阶段重跑时，cascade 自动删除所有下游结果：

- `strategy` 重跑 → 删 `creative_plan`, `creative`, `execution`
- `creative_plan` 重跑 → 删 `creative`, `execution`

## 3. 13 个 Orchestrator Tools

### 阶段执行

| Tool | 用途 |
|------|------|
| `run_phase(phase, instructions?)` | 首次执行阶段 |
| `retry_phase(phase, feedback)` | 带修改指令重跑 |
| `skip_phase(phase, reason)` | 跳过阶段 |

### 用户交互

| Tool | 用途 |
|------|------|
| `request_user_feedback(message, options?)` | 暂停等待用户输入 |

### Brief 修复

| Tool | 用途 |
|------|------|
| `patch_brief(fields, reason)` | 修改 brief 字段 + 检测 stale phases |

### 错误修复经验

| Tool | 用途 |
|------|------|
| `search_fix_knowledge(error_text, phase?)` | 向量搜索历史修复方案 |
| `save_fix_knowledge(error_pattern, solution, ...)` | 保存修复经验 |

### 查询 / 执行

| Tool | 用途 |
|------|------|
| `get_meta_assets()` | 获取 Meta 账户资产 (Page, WhatsApp, Instagram) |
| `read_phase_detail(phase, field)` | 读取阶段结果的嵌套字段 |
| `preview_execution()` | 预览投放计划（不真正创建） |
| `activate_campaigns()` | 将 PAUSED 广告激活为 ACTIVE |

### 终止

| Tool | 用途 |
|------|------|
| `submit_final(summary)` | 标记编排完成 |

## 4. 硬约束 (代码级，Agent 无法绕过)

| 约束 | 触发条件 | 行为 |
|------|---------|------|
| Retry 上限 | `retry_phase` 同一阶段 > 3 次 | 返回 `blocked`，强制 `request_user_feedback` |
| 前置阶段检查 | `execution` 缺 strategy 或 creative | 返回 `blocked` |
| 前置阶段检查 | `creative` 缺 strategy | 返回 `blocked` |
| Submit 检查 | execution 有未解决错误 | 拒绝提交 |
| Submit 检查 | cascade 失效阶段未重跑 | 拒绝提交 |
| 迭代上限 | loop 达到 40 轮 | force-terminated |

## 5. 错误处理分层

### Layer 1: LLM 调用失败

Claude stream 抛异常（MixAI 宕机、网络超时）：
- `status → interrupted`
- yield error 事件 (`recoverable: true`)
- checkpoint 已保存在 DB，cron 可自动恢复

LLM 降级（MixAI → Anthropic Direct）：
- `llm-client.js` 内部 fallback，对 orchestrator 透明
- `onLlmEvent` 转发到前端 (`phase_progress`)

### Layer 2: 阶段执行失败

Sub-agent 抛异常：
- catch → yield `phase_error`
- `tool_result = { status: 'error', error: msg }`
- Claude 看到错误后决策：`retry_phase` / `patch_brief` / `request_user_feedback`

阶段完成但质量差 (`evaluateOutput` score < 75)：
- `tool_result` 含 `quality.issues`
- system prompt 状态行显示 ⚠️/❌
- Claude 自行判断是否 retry

### Layer 3: Meta API 业务错误

`execution` 返回 `status=partial` + `errors[]`：
- `tool_result` 含 `error_details`（最多 8 条）
- system prompt 追加 `PROMPT_EXECUTION_ERRORS` 分类指南
- Claude 按错误类型选择修复路径

### Layer 4: 硬约束兜底

见第 4 节。代码级拒绝，Claude 无法绕过。

## 6. 重试机制

### Agent 主动 retry

Claude 看到 `quality.score` 低或 `error` → 调用 `retry_phase(phase, feedback)`。
约束：`MAX_PHASE_RETRIES = 3`，超限返回 blocked。

### Cascade 触发重跑

上游 retry → 删除下游结果 → system prompt 标记 `⚠️ 已失效` → 硬约束阻断跳阶段。
`tool_result` 含 `cascade_warning` 明确告知需要重跑哪些阶段。

### Brief 修改触发重跑

`patch_brief` → `BRIEF_FIELD_TO_PHASE` 映射检测 stale phases → 返回 warning。

### 进程崩溃恢复

`orchestrator-recovery` cron 每 60s 巡检一次：

```sql
SELECT id, brief_id FROM orchestrator_sessions
WHERE status = 'running'
  AND updated_at < now() - interval '5 minutes'
  AND updated_at > now() - interval '24 hours'
LIMIT 5
```

- 命中 → 调用 `orchestrate(sessionId)` 从 checkpoint 恢复
- 恢复失败 → 标记 `status = interrupted`（不会无限重试）
- 超过 24h 的僵尸 session 不恢复

## 7. 状态机

```
         ┌─────────┐
         │  intake  │ (brief 收集中)
         └────┬────┘
              │ save_brief
              ▼
     ┌────────────────┐    checkpoint     ┌──────────────┐
     │    running      │◄────恢复─────────│  interrupted  │
     │  (agent loop)   │                  └──────────────┘
     └──┬────┬────┬───┘                         ▲
        │    │    │                              │
        │    │    └── LLM崩溃/超时 ─────────────┘
        │    │
        │    │  request_user_feedback
        │    ▼
        │  ┌──────────────────┐
        │  │ awaiting_feedback │──── BRPOP / POST /feedback
        │  └────────┬─────────┘
        │           │ 收到用户输入
        │           └── status=running (continue loop)
        │
        │  submit_final (通过硬约束检查)
        ▼
   ┌────────────┐
   │  completed  │
   └────────────┘
```

## 8. 数据持久化

| 数据 | 存储位置 | 写入时机 |
|------|---------|---------|
| Session 状态 | `orchestrator_sessions.status` | 每次状态转换 |
| 阶段结果 | `orchestrator_sessions.phase_results` | 阶段完成后 merge |
| Checkpoint | `orchestrator_sessions.orchestrator_state` | 每轮 LLM 调用前 |
| 修复日志 | `orchestrator_sessions.fix_log` | patch_brief 时 |
| 事件消息 | `orchestrator_messages` | 阶段开始/完成/错误/进度 |
| SSE 事件 | Redis Stream (TTL 24h) | 每个 yield 的事件 |
| 用户中途消息 | Redis List (`user_input:{sessionId}`) | 用户在执行中发消息时 |

## 9. SSE 流 & 前端恢复

### 服务端 SSE 管道

```
orchestrate() async generator
  → yields { event, data }
  → drainToRedis(): 每个事件写入 Redis Stream (XADD)
  → streamSSE(): 编码为 SSE frame 发送给客户端
```

### 前端连接模型

```
用户发消息 → POST /orchestrate/[id]
  → 返回 { session_id, stream_key }
  → connectToStream() 消费 SSE
       │
       ├─ 正常: 收到 done/error → 结束
       │
       └─ SSE 断开 → lastEventId 已保存
            │
            └─ 页面刷新 → fetchMessages() 加载历史
                 → status 是 running/awaiting_feedback
                 → connectToStream(/stream?lastEventId=xxx) 续接
```

### /stream 端点 (Redis Stream 长轮询)

```
Phase 1: XRANGE replay
  从 lastEventId 之后开始，回放所有未消费的事件

Phase 2: XREAD BLOCK 30s
  实时等待新事件，每 30s 超时检查 session 是否结束
  session 终态 → 发送 done → 关闭连接
```

### 前端 Stale Session 轮询

当 SSE 连接断开且 session 仍在 `running` 状态时（cron 恢复场景），前端无法感知。
通过 15s 定时轮询弥补：

```
setInterval(15s):
  GET /orchestrate/[id] → 获取 status

  ├─ status 从 running → completed/awaiting_feedback
  │    → setRefreshKey++ → 全量刷新消息 + 重建 UI
  │
  └─ status 仍是 running，但没有活跃 SSE 流
       → connectToStream 重连 /stream?lastEventId=xxx
       → 从 Redis Stream 续接 cron 恢复产生的新事件
```

这确保了即使服务端进程崩溃后被 cron 恢复，前端也能在 15s 内感知并重新接上数据流。

## 10. 部署

### PM2 进程

| 进程 | 脚本 | 间隔 |
|------|------|------|
| lead-engine-next | `npm start` | — |
| lead-sync-cron | `scripts/cron-sync-leads.js` | 10s |
| queue-cron | `scripts/cron-process-queue.js` | 10s |
| report-cron | `scripts/cron-generate-reports.js` | 定时 |
| orchestrator-recovery | `scripts/cron-recover-orchestrator.js` | 60s |

部署脚本：`scripts/deploy.sh`，9 步自动打包、上传、构建、逐个重启 PM2 进程。
