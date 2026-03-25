# Intelligent Campaign Orchestrator — Design Spec

**Date:** 2026-03-23
**Status:** Approved
**Scope:** Replace hardcoded for-loop orchestrator with Claude tool_use agent

## Problem

The current orchestrator (`campaign-orchestrator.service.js`) runs a fixed `research → strategy → creative → execution` pipeline with no intelligence:

- Cannot skip phases (e.g., user already has creatives)
- No quality gates between phases
- Cannot retry phases with adjusted instructions
- No mid-pipeline user communication (only approval gate before execution)
- Same flow regardless of brief characteristics ($100 vs $10,000 budget)

## Solution

Replace the for-loop with a Claude tool_use agent loop. The orchestrator itself becomes an LLM agent that decides which phases to run, evaluates outputs, and communicates with the user.

## Architecture

### Control Flow

```
orchestrate(sessionId):
  1. Load brief + session + existing phase_results
  2. Build messages: [{ role: 'user', content: brief + phase_results }]
  3. Call Claude API (tool_choice: auto, tools: ORCHESTRATOR_TOOLS)
  4. Tool-use loop:
     - run_phase → call existing executor, yield phase_start/complete
     - evaluate_output → deterministic rules, return score + issues
     - request_user_feedback → yield feedback_required, save state, return
     - skip_phase → record skip, yield phase_skipped
     - retry_phase → re-call executor with feedback as instructions
     - submit_final → yield done, return
  5. MAX_ITERATIONS (25) → force submit_final
```

### Pause-Resume (request_user_feedback)

```
orchestrate()
  → Claude calls request_user_feedback("确认执行方案？")
  → Save state to session.orchestrator_state (see shape below)
  → Set session.status = 'awaiting_feedback'
  → Yield { event: 'feedback_required', data: { message, options, tool_use_id } }
  → Return (generator ends, SSE closes)

resumeAfterFeedback(sessionId, userResponse)
  → Validate session.status === 'awaiting_feedback' OR 'awaiting_approval'
  → Load session.orchestrator_state
  → Append tool_result: { tool_use_id, content: JSON.stringify({ user_response }) }
  → Set session.status = 'running'
  → Continue tool_use loop from where it left off
```

**orchestrator_state shape:**

```javascript
{
  // Only the orchestrator agent's messages (not phase agent internals)
  messages: [
    { role: 'user', content: '...' },           // initial brief context
    { role: 'assistant', content: [...] },       // Claude's tool_use blocks
    { role: 'user', content: [...tool_results] }, // tool results fed back
    // ... up to the unanswered request_user_feedback tool_use
  ],
  pending_tool_use_id: 'toolu_xxx',  // the tool_use block awaiting response
  phase_results_snapshot: { ... },    // phaseResults at pause time
}
```

**Note:** Phase results (research output, strategy JSON, etc.) are stored in `session.phase_results`, not duplicated in the messages. The orchestrator agent messages contain only `result_summary` (small) from `run_phase` tool results, not the full phase output.

**`resumeAfterFeedback` signature:**

```javascript
/**
 * Resume orchestration after user feedback.
 * @param {string} sessionId
 * @param {string} userResponse - The user's response text
 * @yields {{ event: string, data: Object }} SSE events
 */
export async function* resumeAfterFeedback(sessionId, userResponse) { ... }
```

Returns an async generator (same interface as `orchestrate`), yielding SSE events. Validates session is in paused state, otherwise yields error event.

**Session status transitions:**

```
draft → running → awaiting_feedback → running → awaiting_feedback → ... → completed
                                                                        → failed
```

`'awaiting_approval'` is no longer set by the orchestrator directly. `orchestrateAfterApproval` accepts both `'awaiting_feedback'` and `'awaiting_approval'` for backward compat.

### System Prompt

```
你是数字广告投放主控 Agent。你的任务是根据 Campaign Brief 编排投放流程。

可用工具：
- run_phase: 执行某个阶段 (research/strategy/creative/execution)
- evaluate_output: 评估阶段输出质量
- request_user_feedback: 向用户提问或确认
- skip_phase: 跳过某阶段
- retry_phase: 带反馈重跑某阶段
- submit_final: 标记编排完成

标准流程: research → strategy → creative → execution
可根据 brief 灵活调整：
- 预算很小（<$200）→ 可跳过 research
- 用户已有素材 → 跳过 creative
- research 数据不足 → retry 并给出更具体指令
- 阶段出错 → 告诉用户并询问是否重试

规则：
- execution 前必须调用 request_user_feedback 获得用户确认
- 每个阶段完成后用 evaluate_output 评估质量
- evaluate_output 返回 score < 50 时，用 retry_phase 重试（仅 research/strategy）
- evaluate_output 返回 score >= 50 时，继续下一步
- 每个阶段最多 retry 一次，避免无限循环
- 出错时向用户说明，不要静默失败
- retry_phase 仅支持 research 和 strategy；creative/execution 出错用 request_user_feedback 通知用户
```

## Tool Definitions

### run_phase

```javascript
{
  name: 'run_phase',
  description: '执行指定的投放流程阶段。返回阶段结果摘要。',
  input_schema: {
    type: 'object',
    required: ['phase'],
    properties: {
      phase: { type: 'string', enum: ['research', 'strategy', 'creative', 'execution'] },
      instructions: { type: 'string', description: '给该阶段 agent 的额外指令（可选）' },
    },
  },
}
```

**Output:** `{ status: 'completed', result_summary: {...}, duration_s: number }` or `{ status: 'error', error: string }`

### evaluate_output

```javascript
{
  name: 'evaluate_output',
  description: '评估某阶段输出的质量和完整性。返回评分和问题列表。',
  input_schema: {
    type: 'object',
    required: ['phase'],
    properties: {
      phase: { type: 'string' },
      criteria: { type: 'string', description: '评估侧重点（可选）' },
    },
  },
}
```

**Output:** `{ score: number(0-100), issues: string[], suggestions: string[] }`

Implementation: deterministic rules, not LLM:

| Phase | Checks |
|-------|--------|
| research | has recommendations, has platform_recommendations, has competitor_ads |
| strategy | has platforms, budget allocation sums to ~100%, has campaigns |
| creative | no errors in generated creatives |
| execution | status is completed, no errors |

Score = max(0, 100 - issues.length * 25)

### request_user_feedback

```javascript
{
  name: 'request_user_feedback',
  description: '暂停流程，向用户提问或展示中间结果请求确认。用户回应后流程继续。',
  input_schema: {
    type: 'object',
    required: ['message'],
    properties: {
      message: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, description: '给用户的选项按钮（可选，不提供则为自由输入）' },
    },
  },
}
```

**Behavior:** Does not return immediately. Pauses the generator, saves state, yields SSE event.

### skip_phase

```javascript
{
  name: 'skip_phase',
  description: '跳过某个阶段并记录原因。',
  input_schema: {
    type: 'object',
    required: ['phase', 'reason'],
    properties: {
      phase: { type: 'string' },
      reason: { type: 'string' },
    },
  },
}
```

**Output:** `{ skipped: true, phase, reason }`

### retry_phase

```javascript
{
  name: 'retry_phase',
  description: '带修改指令重跑某阶段。之前的结果会被覆盖。仅支持 research 和 strategy 阶段（它们是 LLM agent，能接受指令）。creative 是确定性流程，execution 依赖外部 API，两者不支持 retry。如果 creative/execution 出错，应 request_user_feedback 告知用户。',
  input_schema: {
    type: 'object',
    required: ['phase', 'feedback'],
    properties: {
      phase: { type: 'string', enum: ['research', 'strategy'] },
      feedback: { type: 'string', description: '对上次结果的修改要求，会传给阶段 agent' },
    },
  },
}
```

**Output:** Same as run_phase.

**Note:** `retry_phase` only supports `research` and `strategy` because they are Claude agents with system prompts that can accept additional instructions. `creative` is a deterministic image generation pipeline and `execution` calls external Meta APIs — neither can meaningfully respond to text feedback. If those phases fail, the orchestrator should use `request_user_feedback` to inform the user.

### submit_final

```javascript
{
  name: 'submit_final',
  description: '标记编排完成，提交最终结果摘要。',
  input_schema: {
    type: 'object',
    required: ['summary'],
    properties: {
      summary: { type: 'string' },
      skipped_phases: { type: 'array', items: { type: 'string' } },
    },
  },
}
```

**Behavior:** Terminates the tool_use loop. Yields `done` event.

## SSE Events

| Event | Data | When |
|-------|------|------|
| `orchestration_start` | `{ session_id, brief_id, phases }` | Generator starts |
| `phase_start` | `{ phase, name }` | run_phase begins |
| `phase_complete` | `{ phase, result, duration, result_summary }` | run_phase succeeds |
| `phase_skipped` | `{ phase, reason }` | **NEW** skip_phase called |
| `phase_error` | `{ phase, error }` | run_phase throws (returned to Claude as error) |
| `heartbeat` | `{ phase, elapsed_s }` | During long-running phases |
| `feedback_required` | `{ message, options?, tool_use_id }` | **NEW** request_user_feedback called |
| `done` | `{ session_id, phases_completed, summary }` | submit_final or end_turn |
| `error` | `{ message }` | Fatal error |

## Database Changes

```sql
ALTER TABLE orchestrator_sessions
  ADD COLUMN orchestrator_state jsonb DEFAULT NULL;
```

Stores the Claude messages array for pause-resume. Migration file: `supabase/migrations/2026-03-23-orchestrator-state.sql` (must be created as part of implementation).

### Message Array Contract

The `orchestrator_state.messages` array contains the **complete** orchestrator-level Claude conversation, including all prior assistant turns (with tool_use blocks) and user turns (with tool_result blocks). Tool results for `run_phase` and `evaluate_output` contain only summaries (not full phase data). Full phase outputs live in `session.phase_results`.

On resume, `resumeAfterFeedback` restores `phaseResults` from `orchestrator_state.phase_results_snapshot` (the exact in-memory state at pause time), appends the user's feedback as a `tool_result` for `pending_tool_use_id`, and continues the Claude API loop.

### Heartbeat in Tool-Use Loop

The existing `runWithHeartbeat` + event buffer pattern is preserved inside `run_phase` tool handling. When `run_phase` calls a phase executor, it wraps the call with `runWithHeartbeat` and collects heartbeat events into a buffer. After the executor completes, buffered heartbeats are yielded before the tool result is returned to Claude.

### orchestrate() Options Disposition

The rewritten `orchestrate()` **removes** `options.startPhase` and `options.skipApproval`. The agent decides which phases to run based on `session.phase_results` (already-completed phases are visible in its context). The API route query param `?start_phase=` becomes a no-op and should be removed from the route. `orchestrateAfterApproval` is preserved as a thin wrapper over `resumeAfterFeedback`.

## API Changes

### New: POST /api/campaign/orchestrate/[id]/feedback

```
Body: { response: "用户的回应文本" }
Returns: SSE stream (resumed orchestrator generator)
```

### Modified: POST /api/campaign/orchestrate/[id]/approve

Internally calls `resumeAfterFeedback(sessionId, '确认执行投放方案')`. No external API change.

## Agent Signature Changes

```javascript
// research-agent.service.js
export async function conductResearch(brief, instructions) {
  // instructions appended to system prompt if provided
}

// strategy-agent.service.js
export async function generateMediaPlan(brief, research, instructions) {
  // instructions appended to system prompt if provided
}
```

Minimal change: optional parameter, appended to system prompt.

## Frontend Changes

### ChatArea.js — new SSE events

```javascript
case 'feedback_required':
  addMessage({
    type: 'feedback_required',
    message: data.message,
    options: data.options,
  });
  break;

case 'phase_skipped':
  addMessage({
    type: 'phase_skipped',
    phase: data.phase,
    reason: data.reason,
  });
  break;
```

### MessageBubble.js — new card types

```javascript
{type === 'feedback_required' && (
  <FeedbackCard
    message={message.message}
    options={message.options}
    onRespond={onFeedbackRespond}
  />
)}

{type === 'phase_skipped' && (
  <div className="text-xs text-gray-400 flex items-center gap-2 py-1">
    <span>⏭</span>
    <span>{message.reason}</span>
  </div>
)}
```

### FeedbackCard.js — new component

Shows the orchestrator's question with optional buttons. User can click a button or type a free response. Calls `POST /api/campaign/orchestrate/[id]/feedback`.

## Backward Compatibility

| Interface | Status |
|-----------|--------|
| `orchestrateAfterApproval(sessionId)` | Kept, internally calls `resumeAfterFeedback` |
| `POST .../approve` | Unchanged |
| `chatWithOrchestrator` | Unchanged |
| `PHASES`, `detectStartPhase`, `summarizePhaseResult` | Kept as exports |
| Frontend `approval_required` event | Still handled (mapped from feedback_required) |

## Test Plan

Mock Anthropic to return predetermined tool_use sequences.

| # | Test Case | Mock Behavior | Assertions |
|---|-----------|---------------|------------|
| 1 | Full standard flow | run_phase(research) → run_phase(strategy) → run_phase(creative) → request_user_feedback → resume → run_phase(execution) → submit_final | All phase events emitted, done event, session completed |
| 2 | Skip phase | skip_phase(research) → run_phase(strategy) → ... | phase_skipped event, conductResearch not called |
| 3 | Evaluate + retry | run_phase(research) → evaluate_output → retry_phase(research, "more data") | conductResearch called twice, second with instructions |
| 4 | Pause-resume | request_user_feedback → pause → resumeAfterFeedback → continue | orchestrator_state saved/restored |
| 5 | Phase error | run_phase(research) → executor throws → Claude receives error | phase_error event emitted, Claude gets error in tool_result |
| 6 | Max iterations | 26 tool calls | Force-terminated, done event |
| 8 | Feedback idempotency | resumeAfterFeedback called twice with same tool_use_id | Second call yields error, no duplicate tool_result |
| 7 | Backward compat | orchestrateAfterApproval still works | Calls resumeAfterFeedback internally |

## File Changes

| File | Change |
|------|--------|
| `src/campaign-orchestrator.service.js` | Rewrite orchestrate(), add resumeAfterFeedback(), add tool definitions |
| `src/research-agent.service.js` | Add optional `instructions` param |
| `src/strategy-agent.service.js` | Add optional `instructions` param |
| `app/api/campaign/orchestrate/[id]/feedback/route.js` | New endpoint |
| `app/api/campaign/orchestrate/[id]/approve/route.js` | Use resumeAfterFeedback internally |
| `supabase/migrations/2026-03-23-orchestrator-state.sql` | Add orchestrator_state column |
| `tests/unit/campaign-orchestrator.test.js` | Rewrite tests for tool_use agent |
| `app/dashboard/campaign-studio/components/ChatArea.js` | Handle feedback_required + phase_skipped |
| `app/dashboard/campaign-studio/components/MessageBubble.js` | Add feedback + skipped card types |
| `app/dashboard/campaign-studio/components/cards/FeedbackCard.js` | New component |
