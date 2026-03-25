# Intelligent Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded for-loop campaign orchestrator with a Claude tool_use agent that decides which phases to run, evaluates quality, and communicates with users.

**Architecture:** The orchestrator becomes a Claude agent with 6 tools (run_phase, evaluate_output, request_user_feedback, skip_phase, retry_phase, submit_final). Phase executors (research, strategy, creative, execution) remain unchanged. Pause-resume via `orchestrator_state` jsonb column.

**Tech Stack:** Node.js, Anthropic SDK, Supabase, Next.js, React, Vitest

**Spec:** `docs/superpowers/specs/2026-03-23-intelligent-orchestrator-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `supabase/migrations/2026-03-23-orchestrator-state.sql` | DB migration: add orchestrator_state column |
| `lib/repositories/orchestrator.repository.js` | Add orchestrator_state to updateSession allowlist |
| `src/research-agent.service.js` | Add optional `instructions` param to conductResearch |
| `src/strategy-agent.service.js` | Add optional `instructions` param to generateMediaPlan |
| `src/campaign-orchestrator.service.js` | Core rewrite: tool definitions, tool_use loop, evaluateOutput, resumeAfterFeedback |
| `app/api/campaign/orchestrate/[id]/route.js` | Remove start_phase query param |
| `app/api/campaign/orchestrate/[id]/approve/route.js` | Delegate to resumeAfterFeedback |
| `app/api/campaign/orchestrate/[id]/feedback/route.js` | New endpoint for user feedback |
| `app/dashboard/campaign-studio/components/cards/FeedbackCard.js` | New UI component |
| `app/dashboard/campaign-studio/components/MessageBubble.js` | Add feedback_required + phase_skipped |
| `app/dashboard/campaign-studio/components/ChatArea.js` | Handle new SSE events + feedback POST |
| `tests/unit/campaign-orchestrator.test.js` | Rewrite all orchestrator tests |

---

### Task 1: Database Migration + Repository Update

**Files:**
- Create: `supabase/migrations/2026-03-23-orchestrator-state.sql`
- Modify: `lib/repositories/orchestrator.repository.js:40-55`

- [ ] **Step 1: Create migration file**

```sql
-- supabase/migrations/2026-03-23-orchestrator-state.sql
ALTER TABLE orchestrator_sessions
  ADD COLUMN IF NOT EXISTS orchestrator_state jsonb DEFAULT NULL;
```

- [ ] **Step 2: Update repository to allow orchestrator_state writes**

In `lib/repositories/orchestrator.repository.js`, update `updateSession` to include `orchestrator_state` in the allowed fields:

```javascript
export async function updateSession(sessionId, updates) {
  const allowed = {};
  if (updates.status !== undefined) allowed.status = updates.status;
  if (updates.current_phase !== undefined) allowed.current_phase = updates.current_phase;
  if (updates.phase_results !== undefined) allowed.phase_results = updates.phase_results;
  if (updates.orchestrator_state !== undefined) allowed.orchestrator_state = updates.orchestrator_state;

  const { data, error } = await supabase
    .from('orchestrator_sessions')
    .update(allowed)
    .eq('id', sessionId)
    .select()
    .single();

  if (error) throw error;
  return data;
}
```

- [ ] **Step 3: Apply migration**

Run: `npx supabase db push` or apply manually.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-03-23-orchestrator-state.sql lib/repositories/orchestrator.repository.js
git commit -m "feat: add orchestrator_state column for pause-resume"
```

---

### Task 2: Add `instructions` Param to Agent Services

**Files:**
- Modify: `src/research-agent.service.js:155-168`
- Modify: `src/strategy-agent.service.js:309-328`

- [ ] **Step 1: Write failing test for research agent instructions**

Create test in `tests/unit/research-agent-instructions.test.js`:

```javascript
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const configUrl = pathToFileURL(resolve(process.cwd(), 'src/config.js')).href;
mock.module(configUrl, {
  namedExports: {
    config: {
      anthropic: { apiKey: 'test', baseURL: 'https://test.api', model: 'test-model' },
    },
  },
});

let capturedSystem = '';
const anthropicUrl = pathToFileURL(resolve(process.cwd(), 'node_modules/@anthropic-ai/sdk/index.mjs')).href;
mock.module(anthropicUrl, {
  defaultExport: class Anthropic {
    constructor() {
      this.messages = {
        create: mock.fn(async (opts) => {
          capturedSystem = opts.system;
          return {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'tu1', name: 'submit_report', input: { recommendations: ['test'] } }],
          };
        }),
      };
    }
  },
});

const researchUrl = pathToFileURL(resolve(process.cwd(), 'src/research-agent.service.js')).href;
const { conductResearch } = await import(researchUrl);

describe('conductResearch instructions', () => {
  beforeEach(() => { capturedSystem = ''; });

  it('appends instructions to system prompt when provided', async () => {
    await conductResearch({ industry: 'solar' }, '增加竞品分析深度');
    assert.ok(capturedSystem.includes('增加竞品分析深度'), 'Instructions should be in system prompt');
  });

  it('works without instructions (backward compat)', async () => {
    await conductResearch({ industry: 'solar' });
    assert.ok(!capturedSystem.includes('undefined'), 'Should not contain undefined');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/research-agent-instructions.test.js`
Expected: FAIL — `conductResearch` does not accept second param

- [ ] **Step 3: Modify conductResearch**

In `src/research-agent.service.js:155`:

```javascript
export async function conductResearch(brief, instructions) {
  const messages = [{
    role: 'user',
    content: `Conduct market research for this campaign brief and submit your report.\n\nCAMPAIGN BRIEF:\n${JSON.stringify(brief, null, 2)}`,
  }];

  const systemPrompt = instructions
    ? `${RESEARCH_SYSTEM_PROMPT}\n\n═══ 额外指令 ═══\n${instructions}`
    : RESEARCH_SYSTEM_PROMPT;

  let response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
    tools: RESEARCH_TOOLS,
    tool_choice: { type: 'auto' },
  });
```

Update all other `system: RESEARCH_SYSTEM_PROMPT` references in the same function to `system: systemPrompt`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/research-agent-instructions.test.js`
Expected: PASS

- [ ] **Step 5: Apply same pattern to strategy agent**

In `src/strategy-agent.service.js:309`:

```javascript
export async function generateMediaPlan(brief, researchReport, instructions) {
  // ... existing messages setup ...

  const systemPrompt = instructions
    ? `${STRATEGY_SYSTEM_PROMPT}\n\n═══ 额外指令 ═══\n${instructions}`
    : STRATEGY_SYSTEM_PROMPT;

  let response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 8192,
    system: systemPrompt,
    messages,
    tools: STRATEGY_TOOLS,
    tool_choice: { type: 'auto' },
  });
```

Update all other `system: STRATEGY_SYSTEM_PROMPT` references in the same function to `system: systemPrompt`.

- [ ] **Step 6: Run existing orchestrator tests to verify no regressions**

Run: `node --test tests/unit/campaign-orchestrator.test.js`
Expected: All existing tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/research-agent.service.js src/strategy-agent.service.js tests/unit/research-agent-instructions.test.js
git commit -m "feat: add optional instructions param to research and strategy agents"
```

---

### Task 3: Core Orchestrator Rewrite — Tool Definitions + evaluateOutput

This task adds the new code WITHOUT removing the old `orchestrate()` yet. We add alongside.

**Files:**
- Modify: `src/campaign-orchestrator.service.js`

- [ ] **Step 1: Write failing test for evaluateOutput**

Add to `tests/unit/campaign-orchestrator.test.js` (append new describe block — do NOT delete existing tests yet):

```javascript
describe('evaluateOutput', () => {
  it('scores research with all fields as 100', async () => {
    const { evaluateOutput } = await import(orchUrl);
    const result = evaluateOutput('research', {
      recommendations: ['Focus on Meta'],
      platform_recommendations: [{ platform: 'meta', fit_score: 9 }],
      competitor_ads: { summary: 'Competitors use video' },
    });
    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
  });

  it('scores research with missing fields as 50 or lower', async () => {
    const { evaluateOutput } = await import(orchUrl);
    const result = evaluateOutput('research', {
      recommendations: [],
      platform_recommendations: [],
    });
    assert.ok(result.score <= 50, `Score should be <= 50, got ${result.score}`);
    assert.ok(result.issues.length >= 2);
  });

  it('scores strategy with bad budget allocation', async () => {
    const { evaluateOutput } = await import(orchUrl);
    const result = evaluateOutput('strategy', {
      platforms: [{ platform: 'meta', budget_allocation: 40, campaigns: [{}] }],
    });
    assert.ok(result.issues.some(i => i.includes('预算')));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/campaign-orchestrator.test.js`
Expected: FAIL — `evaluateOutput` is not exported

- [ ] **Step 3: Add ORCHESTRATOR_TOOLS, ORCHESTRATOR_SYSTEM_PROMPT, evaluateOutput to orchestrator service**

Add these ABOVE the existing `orchestrate()` function in `src/campaign-orchestrator.service.js`:

```javascript
// ── Orchestrator Agent Tools ──────────────────────────────────────────

const ORCHESTRATOR_TOOLS = [
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
  },
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
  },
  {
    name: 'request_user_feedback',
    description: '暂停流程，向用户提问或展示中间结果请求确认。用户回应后流程继续。',
    input_schema: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: '给用户的选项按钮（可选）' },
      },
    },
  },
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
  },
  {
    name: 'retry_phase',
    description: '带修改指令重跑某阶段（仅 research/strategy）。之前的结果会被覆盖。',
    input_schema: {
      type: 'object',
      required: ['phase', 'feedback'],
      properties: {
        phase: { type: 'string', enum: ['research', 'strategy'] },
        feedback: { type: 'string', description: '对上次结果的修改要求' },
      },
    },
  },
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
  },
];

const ORCHESTRATOR_SYSTEM_PROMPT = `你是数字广告投放主控 Agent。你的任务是根据 Campaign Brief 编排投放流程。

可用工具：
- run_phase: 执行某个阶段 (research/strategy/creative/execution)
- evaluate_output: 评估阶段输出质量
- request_user_feedback: 向用户提问或确认
- skip_phase: 跳过某阶段
- retry_phase: 带反馈重跑某阶段（仅 research/strategy）
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
- retry_phase 仅支持 research 和 strategy；creative/execution 出错用 request_user_feedback 通知用户`;

const MAX_ORCHESTRATOR_ITERATIONS = 25;

// ── Deterministic evaluation ──────────────────────────────────────────

function evaluateOutput(phase, result) {
  const issues = [];

  switch (phase) {
    case 'research':
      if (!result?.recommendations?.length) issues.push('缺少建议 (recommendations)');
      if (!result?.platform_recommendations?.length) issues.push('缺少平台推荐 (platform_recommendations)');
      if (!result?.competitor_ads?.summary) issues.push('缺少竞品广告分析 (competitor_ads)');
      break;
    case 'strategy':
      if (!result?.platforms?.length) issues.push('缺少平台方案 (platforms)');
      else {
        const totalAlloc = result.platforms.reduce((s, p) => s + (p.budget_allocation || 0), 0);
        if (Math.abs(totalAlloc - 100) > 5) issues.push(`预算分配总和 ${totalAlloc}%，偏离 100%`);
        const hasCampaigns = result.platforms.some(p => p.campaigns?.length > 0);
        if (!hasCampaigns) issues.push('缺少广告系列 (campaigns)');
      }
      break;
    case 'creative': {
      const creatives = result?.creatives || {};
      const errors = Object.values(creatives).filter(c => c.error);
      if (errors.length) issues.push(`${errors.length} 个素材生成失败`);
      break;
    }
    case 'execution':
      if (result?.status !== 'completed') issues.push(`执行状态: ${result?.status || 'unknown'}`);
      if (result?.errors?.length) issues.push(`${result.errors.length} 个执行错误`);
      break;
  }

  const score = Math.max(0, 100 - issues.length * 25);
  return { score, issues, suggestions: issues.map(i => `修复: ${i}`) };
}
```

Add `evaluateOutput` to the export line:

```javascript
export { PHASES, detectStartPhase, summarizePhaseResult, formatProductsAsText, evaluateOutput };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/campaign-orchestrator.test.js`
Expected: All tests PASS (existing + new evaluateOutput tests)

- [ ] **Step 5: Commit**

```bash
git add src/campaign-orchestrator.service.js tests/unit/campaign-orchestrator.test.js
git commit -m "feat: add orchestrator tool definitions and evaluateOutput"
```

---

### Task 4: Core Orchestrator Rewrite — Tool-Use Loop

Replace the `orchestrate()` function. This is the largest task.

**Files:**
- Modify: `src/campaign-orchestrator.service.js:181-311` (replace orchestrate function)

- [ ] **Step 1: Write the failing test for the new orchestrate**

Replace the existing `orchestrate — full pipeline` tests in `tests/unit/campaign-orchestrator.test.js`. The mock must simulate Claude returning tool_use responses:

```javascript
// Replace the Anthropic mock with one that returns a sequence of tool_use calls
let toolCallQueue = [];
let apiCallCount = 0;

mock.module(anthropicUrl, {
  defaultExport: class Anthropic {
    constructor() {
      this.messages = {
        create: mock.fn(async () => {
          apiCallCount++;
          if (toolCallQueue.length > 0) {
            return toolCallQueue.shift();
          }
          // Default: end_turn
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] };
        }),
        stream: mock.fn(() => ({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '方案分析如下...' } };
          },
          finalMessage: async () => ({ stop_reason: 'end_turn', content: [] }),
        })),
      };
    }
  },
});
```

Update the `beforeEach` to also reset `toolCallQueue` and `apiCallCount`.

Also update the `updateSession` mock to mirror `orchestrator_state` onto `mockSession`:

```javascript
// In the mock setup, update the updateSession mock:
updateSession: mock.fn(async (id, updates) => {
  sessionUpdates.push(updates);
  if (updates.status) mockSession.status = updates.status;
  if (updates.phase_results) mockSession.phase_results = updates.phase_results;
  if (updates.current_phase !== undefined) mockSession.current_phase = updates.current_phase;
  if (updates.orchestrator_state !== undefined) mockSession.orchestrator_state = updates.orchestrator_state;
  return mockSession;
}),
```

```javascript
beforeEach(() => {
  toolCallQueue = [];
  apiCallCount = 0;
  sessionUpdates = [];
  persistedMessages = [];
  messageIndex = 0;
  mockSession = { /* same as before, plus orchestrator_state: null */ };
  mockBrief = { /* same as before */ };
});
```

New test for standard flow:

```javascript
describe('orchestrate — intelligent agent', () => {
  it('runs full flow: research → evaluate → strategy → evaluate → creative → evaluate → feedback → done', async () => {
    toolCallQueue = [
      // Claude calls run_phase(research)
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu1', name: 'run_phase', input: { phase: 'research' } },
      ]},
      // Claude calls evaluate_output(research)
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu2', name: 'evaluate_output', input: { phase: 'research' } },
      ]},
      // Claude calls run_phase(strategy)
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu3', name: 'run_phase', input: { phase: 'strategy' } },
      ]},
      // Claude calls evaluate_output(strategy)
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu4', name: 'evaluate_output', input: { phase: 'strategy' } },
      ]},
      // Claude calls run_phase(creative)
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu5', name: 'run_phase', input: { phase: 'creative' } },
      ]},
      // Claude calls request_user_feedback before execution
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu6', name: 'request_user_feedback', input: { message: '方案已就绪，确认执行？', options: ['确认', '取消'] } },
      ]},
    ];

    const events = await collectEvents(orchestrate('session-1'));

    // Should have phase_start + phase_complete for research, strategy, creative
    const starts = findEvents(events, 'phase_start');
    assert.equal(starts.length, 3);
    assert.equal(starts[0].data.phase, 'research');
    assert.equal(starts[1].data.phase, 'strategy');
    assert.equal(starts[2].data.phase, 'creative');

    const completes = findEvents(events, 'phase_complete');
    assert.equal(completes.length, 3);

    // Should end with feedback_required (not done)
    const feedback = findEvents(events, 'feedback_required');
    assert.equal(feedback.length, 1);
    assert.equal(feedback[0].data.message, '方案已就绪，确认执行？');

    // Session should be awaiting_feedback
    assert.ok(sessionUpdates.some(u => u.status === 'awaiting_feedback'));
    // orchestrator_state should be saved
    assert.ok(sessionUpdates.some(u => u.orchestrator_state != null));
  });

  it('handles skip_phase', async () => {
    toolCallQueue = [
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu1', name: 'skip_phase', input: { phase: 'research', reason: '预算太小' } },
      ]},
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu2', name: 'run_phase', input: { phase: 'strategy' } },
      ]},
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu3', name: 'submit_final', input: { summary: '完成' } },
      ]},
    ];

    const events = await collectEvents(orchestrate('session-1'));

    const skipped = findEvents(events, 'phase_skipped');
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].data.phase, 'research');
    assert.equal(skipped[0].data.reason, '预算太小');

    // Research executor should NOT have been called
    const { conductResearch } = await import(researchUrl);
    const researchCalls = conductResearch.mock.calls.filter(
      c => c.arguments && c.arguments.length > 0
    );
    // The mock may have prior calls — check that no NEW call happened during this test
    // Better: check phase_start events don't include research
    const phaseStarts = findEvents(events, 'phase_start');
    assert.ok(!phaseStarts.some(s => s.data.phase === 'research'));
  });

  it('handles evaluate + retry_phase', async () => {
    toolCallQueue = [
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu1', name: 'run_phase', input: { phase: 'research' } },
      ]},
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu2', name: 'evaluate_output', input: { phase: 'research' } },
      ]},
      // Claude decides to retry
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu3', name: 'retry_phase', input: { phase: 'research', feedback: '需要更多竞品数据' } },
      ]},
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu4', name: 'submit_final', input: { summary: '完成' } },
      ]},
    ];

    const events = await collectEvents(orchestrate('session-1'));

    // research should have been started twice
    const researchStarts = findEvents(events, 'phase_start').filter(e => e.data.phase === 'research');
    assert.equal(researchStarts.length, 2);
  });

  it('force-terminates at MAX_ITERATIONS', async () => {
    // Fill queue with 26 evaluate_output calls — loop limit is 25, so last is never dequeued
    toolCallQueue = Array.from({ length: 26 }, (_, i) => ({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: `tu${i}`, name: 'evaluate_output', input: { phase: 'research' } }],
    }));

    const events = await collectEvents(orchestrate('session-1'));
    const done = findEvents(events, 'done');
    assert.equal(done.length, 1);
    assert.ok(done[0].data.summary.includes('max iterations'));
  });

  it('emits orchestration_start event', async () => {
    toolCallQueue = [
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu1', name: 'submit_final', input: { summary: '完成' } },
      ]},
    ];

    const events = await collectEvents(orchestrate('session-1'));
    const starts = findEvents(events, 'orchestration_start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].data.session_id, 'session-1');
    assert.ok(starts[0].data.phases.length > 0);
  });

  it('passes phase errors to Claude as tool_result (not terminating)', async () => {
    const { conductResearch } = await import(researchUrl);
    conductResearch.mock.mockImplementationOnce(async () => {
      throw new Error('API rate limit');
    });

    toolCallQueue = [
      // Claude calls run_phase(research) — will fail
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu1', name: 'run_phase', input: { phase: 'research' } },
      ]},
      // Claude receives error, decides to inform user
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu2', name: 'request_user_feedback', input: { message: '调研失败，是否重试？', options: ['重试', '跳过'] } },
      ]},
    ];

    const events = await collectEvents(orchestrate('session-1'));

    // phase_error should be emitted
    const errors = findEvents(events, 'phase_error');
    assert.equal(errors.length, 1);
    assert.ok(errors[0].data.error.includes('rate limit'));

    // But generator should NOT terminate — Claude gets error and calls feedback
    const feedback = findEvents(events, 'feedback_required');
    assert.equal(feedback.length, 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/campaign-orchestrator.test.js`
Expected: FAIL — orchestrate still uses old for-loop

- [ ] **Step 3: Rewrite orchestrate() function**

Replace `orchestrate()` (lines 181-311) with the tool-use loop. Keep `runWithHeartbeat`, phase executors, and utility functions intact:

```javascript
export async function* orchestrate(sessionId) {
  const session = await getSession(sessionId);
  if (!session) {
    yield { event: 'error', data: { message: `Session ${sessionId} not found` } };
    return;
  }

  const brief = await getBrief(session.brief_id);
  if (!brief) {
    yield { event: 'error', data: { message: `Brief ${session.brief_id} not found` } };
    return;
  }

  const briefData = brief.brief || {};
  if (!briefData.company_name || !briefData.industry) {
    yield { event: 'error', data: { message: 'Brief is incomplete — finish intake first' } };
    return;
  }

  let phaseResults = session.phase_results || {};
  await updateSession(sessionId, { status: 'running', current_phase: 'orchestrating' });

  yield {
    event: 'orchestration_start',
    data: {
      session_id: sessionId,
      brief_id: session.brief_id,
      phases: PHASES.map(p => ({ key: p.key, name: p.name })),
    },
  };

  // Build initial context for the orchestrator agent
  const existingResults = Object.keys(phaseResults).length > 0
    ? `\n\n已完成阶段结果:\n${Object.entries(phaseResults).map(([k, v]) => `${k}: ${JSON.stringify(summarizePhaseResult(k, v))}`).join('\n')}`
    : '';

  const messages = [{
    role: 'user',
    content: `请根据以下 Campaign Brief 编排投放流程。\n\nCAMPAIGN BRIEF:\n${JSON.stringify(briefData, null, 2)}${existingResults}`,
  }];

  // Event buffer for heartbeats during phase execution
  const eventBuffer = [];

  // Tool-use loop
  for (let iteration = 0; iteration < MAX_ORCHESTRATOR_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: ORCHESTRATOR_SYSTEM_PROMPT,
      messages,
      tools: ORCHESTRATOR_TOOLS,
      tool_choice: { type: 'auto' },
    });

    if (response.stop_reason !== 'tool_use') {
      // Agent finished without submit_final — treat as done
      await updateSession(sessionId, { status: 'completed', current_phase: 'done' });
      yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults) } };
      return;
    }

    const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');
    const assistantContent = response.content;

    // Add assistant turn to messages
    messages.push({ role: 'assistant', content: assistantContent });

    // Process each tool call
    const toolResults = [];
    let shouldPause = false;
    let shouldTerminate = false;
    let terminateSummary = '';

    for (const block of toolUseBlocks) {
      const { id, name, input } = block;
      let result;

      switch (name) {
        case 'run_phase': {
          const phaseKey = input.phase;
          const phaseDef = PHASES.find(p => p.key === phaseKey);

          yield { event: 'phase_start', data: { phase: phaseKey, name: phaseDef?.name || phaseKey } };

          const phaseStartTime = Date.now();
          try {
            const executor = getPhaseExecutor(phaseKey);
            const phaseResult = await runWithHeartbeat(
              phaseKey,
              () => executor(sessionId, brief, phaseResults, input.instructions),
              (evt) => eventBuffer.push(evt),
            );

            // Flush heartbeat events
            while (eventBuffer.length > 0) yield eventBuffer.shift();

            phaseResults = { ...phaseResults, [phaseKey]: phaseResult };
            await updateSession(sessionId, { phase_results: phaseResults, current_phase: phaseKey });

            const duration = Math.round((Date.now() - phaseStartTime) / 1000);
            const resultSummary = summarizePhaseResult(phaseKey, phaseResult);

            yield {
              event: 'phase_complete',
              data: { phase: phaseKey, name: phaseDef?.name || phaseKey, result: phaseResult, duration, result_summary: resultSummary },
            };

            result = { status: 'completed', result_summary: resultSummary, duration_s: duration };
          } catch (err) {
            while (eventBuffer.length > 0) yield eventBuffer.shift();

            yield { event: 'phase_error', data: { phase: phaseKey, error: err.message } };
            result = { status: 'error', error: err.message };
          }
          break;
        }

        case 'evaluate_output': {
          const evalResult = evaluateOutput(input.phase, phaseResults[input.phase]);
          result = evalResult;
          break;
        }

        case 'request_user_feedback': {
          // Save state and pause
          await updateSession(sessionId, {
            status: 'awaiting_feedback',
            orchestrator_state: {
              messages: [...messages],
              pending_tool_use_id: id,
              phase_results_snapshot: phaseResults,
            },
          });

          yield {
            event: 'feedback_required',
            data: { message: input.message, options: input.options, tool_use_id: id },
          };

          shouldPause = true;
          result = null; // Won't be sent — we pause
          break;
        }

        case 'skip_phase': {
          yield { event: 'phase_skipped', data: { phase: input.phase, reason: input.reason } };
          result = { skipped: true, phase: input.phase, reason: input.reason };
          break;
        }

        case 'retry_phase': {
          const phaseKey = input.phase;
          const phaseDef = PHASES.find(p => p.key === phaseKey);

          yield { event: 'phase_start', data: { phase: phaseKey, name: phaseDef?.name || phaseKey } };

          const phaseStartTime = Date.now();
          try {
            const executor = getPhaseExecutor(phaseKey);
            const phaseResult = await runWithHeartbeat(
              phaseKey,
              () => executor(sessionId, brief, phaseResults, input.feedback),
              (evt) => eventBuffer.push(evt),
            );

            while (eventBuffer.length > 0) yield eventBuffer.shift();

            phaseResults = { ...phaseResults, [phaseKey]: phaseResult };
            await updateSession(sessionId, { phase_results: phaseResults, current_phase: phaseKey });

            const duration = Math.round((Date.now() - phaseStartTime) / 1000);
            const resultSummary = summarizePhaseResult(phaseKey, phaseResult);

            yield {
              event: 'phase_complete',
              data: { phase: phaseKey, name: phaseDef?.name || phaseKey, result: phaseResult, duration, result_summary: resultSummary },
            };

            result = { status: 'completed', result_summary: resultSummary, duration_s: duration };
          } catch (err) {
            while (eventBuffer.length > 0) yield eventBuffer.shift();
            yield { event: 'phase_error', data: { phase: phaseKey, error: err.message } };
            result = { status: 'error', error: err.message };
          }
          break;
        }

        case 'submit_final': {
          await updateSession(sessionId, { status: 'completed', current_phase: 'done' });
          shouldTerminate = true;
          terminateSummary = input.summary;
          result = { completed: true };
          break;
        }

        default:
          result = { error: `Unknown tool: ${name}` };
      }

      if (shouldPause) break;

      toolResults.push({
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify(result),
      });
    }

    if (shouldPause) return;

    if (shouldTerminate) {
      yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults), summary: terminateSummary } };
      return;
    }

    // Feed tool results back to Claude
    messages.push({ role: 'user', content: toolResults });
  }

  // MAX_ITERATIONS reached — force terminate
  await updateSession(sessionId, { status: 'completed', current_phase: 'done' });
  yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults), summary: 'Force-terminated: max iterations reached' } };
}
```

Also update phase executors to accept and pass `instructions`:

```javascript
async function runResearch(sessionId, brief, _phaseResults, instructions) {
  return runAgentWithTrace(sessionId, 'research', conductResearch, [brief.brief || {}, instructions]);
}

async function runStrategy(sessionId, brief, phaseResults, instructions) {
  return runAgentWithTrace(sessionId, 'strategy', generateMediaPlan, [brief.brief || {}, phaseResults.research, instructions]);
}

// runCreative and runExecution signatures add instructions param but ignore it
async function runCreative(sessionId, brief, phaseResults, _instructions) {
  // ... existing code unchanged ...
}

async function runExecution(sessionId, brief, phaseResults, _instructions) {
  // ... existing code unchanged ...
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/unit/campaign-orchestrator.test.js`
Expected: New agent tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/campaign-orchestrator.service.js tests/unit/campaign-orchestrator.test.js
git commit -m "feat: rewrite orchestrate() as Claude tool_use agent loop"
```

---

### Task 5: Pause-Resume — resumeAfterFeedback

**Files:**
- Modify: `src/campaign-orchestrator.service.js`

- [ ] **Step 1: Write failing test for resumeAfterFeedback**

Add to `tests/unit/campaign-orchestrator.test.js`:

```javascript
describe('resumeAfterFeedback', () => {
  it('resumes after feedback and completes execution', async () => {
    // Simulate paused state
    mockSession.status = 'awaiting_feedback';
    mockSession.phase_results = { research: MOCK_RESEARCH, strategy: MOCK_STRATEGY, creative: { creatives: {} } };
    mockSession.orchestrator_state = {
      messages: [
        { role: 'user', content: 'Brief context...' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-feedback', name: 'request_user_feedback', input: { message: '确认执行？' } }] },
      ],
      pending_tool_use_id: 'tu-feedback',
      phase_results_snapshot: { research: MOCK_RESEARCH, strategy: MOCK_STRATEGY, creative: { creatives: {} } },
    };

    // After resume, Claude should call run_phase(execution) then submit_final
    toolCallQueue = [
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu-exec', name: 'run_phase', input: { phase: 'execution' } },
      ]},
      { stop_reason: 'tool_use', content: [
        { type: 'tool_use', id: 'tu-done', name: 'submit_final', input: { summary: '投放完成' } },
      ]},
    ];

    const { resumeAfterFeedback } = await import(orchUrl);
    const events = await collectEvents(resumeAfterFeedback('session-1', '确认执行'));

    const execStarts = findEvents(events, 'phase_start').filter(e => e.data.phase === 'execution');
    assert.equal(execStarts.length, 1);

    const done = findEvents(events, 'done');
    assert.equal(done.length, 1);
  });

  it('rejects if session not in paused state', async () => {
    mockSession.status = 'running';

    const { resumeAfterFeedback } = await import(orchUrl);
    const events = await collectEvents(resumeAfterFeedback('session-1', 'test'));

    assert.equal(events[0].event, 'error');
    assert.ok(events[0].data.message.includes('not awaiting feedback'));
  });

  it('rejects when orchestrator_state is null (already consumed)', async () => {
    mockSession.status = 'awaiting_feedback';
    mockSession.orchestrator_state = null; // State already consumed by prior resume

    const { resumeAfterFeedback } = await import(orchUrl);
    const events = await collectEvents(resumeAfterFeedback('session-1', 'duplicate'));

    assert.equal(events[0].event, 'error');
    assert.ok(events[0].data.message.includes('No pending feedback'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/campaign-orchestrator.test.js`
Expected: FAIL — `resumeAfterFeedback` not defined

- [ ] **Step 3: Implement resumeAfterFeedback**

Add after `orchestrate()` in `src/campaign-orchestrator.service.js`:

```javascript
/**
 * Resume orchestration after user feedback.
 * @param {string} sessionId
 * @param {string} userResponse
 * @yields {{ event: string, data: Object }} SSE events
 */
export async function* resumeAfterFeedback(sessionId, userResponse) {
  const session = await getSession(sessionId);
  if (!session) {
    yield { event: 'error', data: { message: `Session ${sessionId} not found` } };
    return;
  }

  const validStatuses = ['awaiting_feedback', 'awaiting_approval'];
  if (!validStatuses.includes(session.status)) {
    yield { event: 'error', data: { message: `Session is not awaiting feedback (status: ${session.status})` } };
    return;
  }

  const state = session.orchestrator_state;
  if (!state || !state.pending_tool_use_id) {
    // Backward compat: old-style awaiting_approval sessions have no orchestrator_state.
    // Fall back to running execution phase directly (legacy behavior).
    if (session.status === 'awaiting_approval') {
      yield* orchestrate(sessionId);
      return;
    }
    yield { event: 'error', data: { message: 'No pending feedback state found' } };
    return;
  }

  const brief = await getBrief(session.brief_id);
  if (!brief) {
    yield { event: 'error', data: { message: `Brief ${session.brief_id} not found` } };
    return;
  }

  // Restore state
  let phaseResults = state.phase_results_snapshot || session.phase_results || {};
  const messages = [...state.messages];

  // Append tool_result with user response
  messages.push({
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: state.pending_tool_use_id,
      content: JSON.stringify({ user_response: userResponse }),
    }],
  });

  // Clear saved state and set running
  await updateSession(sessionId, {
    status: 'running',
    orchestrator_state: null,
  });

  // Continue the tool-use loop (same logic as orchestrate)
  const eventBuffer = [];

  for (let iteration = 0; iteration < MAX_ORCHESTRATOR_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: ORCHESTRATOR_SYSTEM_PROMPT,
      messages,
      tools: ORCHESTRATOR_TOOLS,
      tool_choice: { type: 'auto' },
    });

    if (response.stop_reason !== 'tool_use') {
      await updateSession(sessionId, { status: 'completed', current_phase: 'done' });
      yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults) } };
      return;
    }

    const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');
    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    let shouldPause = false;
    let shouldTerminate = false;
    let terminateSummary = '';

    for (const block of toolUseBlocks) {
      const { id, name, input } = block;
      let result;

      // Same switch as orchestrate() — extract to shared helper
      switch (name) {
        case 'run_phase': {
          const phaseKey = input.phase;
          const phaseDef = PHASES.find(p => p.key === phaseKey);
          yield { event: 'phase_start', data: { phase: phaseKey, name: phaseDef?.name || phaseKey } };
          const phaseStartTime = Date.now();
          try {
            const executor = getPhaseExecutor(phaseKey);
            const phaseResult = await runWithHeartbeat(
              phaseKey,
              () => executor(sessionId, brief, phaseResults, input.instructions),
              (evt) => eventBuffer.push(evt),
            );
            while (eventBuffer.length > 0) yield eventBuffer.shift();
            phaseResults = { ...phaseResults, [phaseKey]: phaseResult };
            await updateSession(sessionId, { phase_results: phaseResults, current_phase: phaseKey });
            const duration = Math.round((Date.now() - phaseStartTime) / 1000);
            const resultSummary = summarizePhaseResult(phaseKey, phaseResult);
            yield { event: 'phase_complete', data: { phase: phaseKey, name: phaseDef?.name || phaseKey, result: phaseResult, duration, result_summary: resultSummary } };
            result = { status: 'completed', result_summary: resultSummary, duration_s: duration };
          } catch (err) {
            while (eventBuffer.length > 0) yield eventBuffer.shift();
            yield { event: 'phase_error', data: { phase: phaseKey, error: err.message } };
            result = { status: 'error', error: err.message };
          }
          break;
        }
        case 'evaluate_output':
          result = evaluateOutput(input.phase, phaseResults[input.phase]);
          break;
        case 'request_user_feedback': {
          await updateSession(sessionId, {
            status: 'awaiting_feedback',
            orchestrator_state: {
              messages: [...messages],
              pending_tool_use_id: id,
              phase_results_snapshot: phaseResults,
            },
          });
          yield { event: 'feedback_required', data: { message: input.message, options: input.options, tool_use_id: id } };
          shouldPause = true;
          break;
        }
        case 'skip_phase':
          yield { event: 'phase_skipped', data: { phase: input.phase, reason: input.reason } };
          result = { skipped: true, phase: input.phase, reason: input.reason };
          break;
        case 'retry_phase': {
          const phaseKey = input.phase;
          const phaseDef = PHASES.find(p => p.key === phaseKey);
          yield { event: 'phase_start', data: { phase: phaseKey, name: phaseDef?.name || phaseKey } };
          const phaseStartTime = Date.now();
          try {
            const executor = getPhaseExecutor(phaseKey);
            const phaseResult = await runWithHeartbeat(phaseKey, () => executor(sessionId, brief, phaseResults, input.feedback), (evt) => eventBuffer.push(evt));
            while (eventBuffer.length > 0) yield eventBuffer.shift();
            phaseResults = { ...phaseResults, [phaseKey]: phaseResult };
            await updateSession(sessionId, { phase_results: phaseResults, current_phase: phaseKey });
            const duration = Math.round((Date.now() - phaseStartTime) / 1000);
            const resultSummary = summarizePhaseResult(phaseKey, phaseResult);
            yield { event: 'phase_complete', data: { phase: phaseKey, name: phaseDef?.name || phaseKey, result: phaseResult, duration, result_summary: resultSummary } };
            result = { status: 'completed', result_summary: resultSummary, duration_s: duration };
          } catch (err) {
            while (eventBuffer.length > 0) yield eventBuffer.shift();
            yield { event: 'phase_error', data: { phase: phaseKey, error: err.message } };
            result = { status: 'error', error: err.message };
          }
          break;
        }
        case 'submit_final':
          await updateSession(sessionId, { status: 'completed', current_phase: 'done' });
          shouldTerminate = true;
          terminateSummary = input.summary;
          result = { completed: true };
          break;
        default:
          result = { error: `Unknown tool: ${name}` };
      }

      if (shouldPause) break;
      toolResults.push({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) });
    }

    if (shouldPause) return;
    if (shouldTerminate) {
      yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults), summary: terminateSummary } };
      return;
    }

    messages.push({ role: 'user', content: toolResults });
  }

  await updateSession(sessionId, { status: 'completed', current_phase: 'done' });
  yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults), summary: 'Force-terminated: max iterations' } };
}
```

**REFACTOR NOTE:** After this passes, extract the tool-handling switch into a shared `processToolCall` helper to DRY the code between `orchestrate()` and `resumeAfterFeedback()`. Both use the exact same switch. Extract it:

```javascript
async function* processToolUseLoop(sessionId, brief, messages, phaseResults, eventBuffer) {
  // shared loop logic
}
```

Then both `orchestrate` and `resumeAfterFeedback` call `yield* processToolUseLoop(...)`.

- [ ] **Step 4: Update orchestrateAfterApproval for backward compat**

```javascript
export async function* orchestrateAfterApproval(sessionId) {
  yield* resumeAfterFeedback(sessionId, '确认执行投放方案');
}
```

- [ ] **Step 5: Run all tests**

Run: `node --test tests/unit/campaign-orchestrator.test.js`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/campaign-orchestrator.service.js tests/unit/campaign-orchestrator.test.js
git commit -m "feat: add resumeAfterFeedback with pause-resume support"
```

---

### Task 6: API Routes

**Files:**
- Create: `lib/sse.js` (extract shared streamSSE helper)
- Modify: `app/api/campaign/orchestrate/[id]/route.js`
- Modify: `app/api/campaign/orchestrate/[id]/approve/route.js`
- Create: `app/api/campaign/orchestrate/[id]/feedback/route.js`

- [ ] **Step 0: Extract streamSSE to shared utility**

Create `lib/sse.js`:

```javascript
export function streamSSE(generator) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of generator) {
          const sseData = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
          controller.enqueue(encoder.encode(sseData));
        }
      } catch (error) {
        const errorEvent = `event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`;
        controller.enqueue(encoder.encode(errorEvent));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

Update `app/api/campaign/orchestrate/[id]/route.js` to import from `lib/sse.js` and remove its local `streamSSE` function.

- [ ] **Step 1: Create feedback endpoint**

```javascript
// app/api/campaign/orchestrate/[id]/feedback/route.js
import { resumeAfterFeedback } from '../../../../../../src/campaign-orchestrator.service.js';
import { getSession, getLatestSession } from '../../../../../../lib/repositories/orchestrator.repository.js';

export async function POST(request, { params }) {
  const { id } = await params;
  const { response: userResponse } = await request.json();

  if (!userResponse) {
    return Response.json({ error: 'Missing response field' }, { status: 400 });
  }

  let session = await getSession(id);
  if (!session) {
    session = await getLatestSession(id);
  }
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  return streamSSE(resumeAfterFeedback(session.id, userResponse));
}

function streamSSE(generator) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of generator) {
          const sseData = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
          controller.enqueue(encoder.encode(sseData));
        }
      } catch (error) {
        const errorEvent = `event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`;
        controller.enqueue(encoder.encode(errorEvent));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

- [ ] **Step 2: Update approve route to use resumeAfterFeedback**

```javascript
// app/api/campaign/orchestrate/[id]/approve/route.js
import { resumeAfterFeedback } from '../../../../../../src/campaign-orchestrator.service.js';
import { getSession, getLatestSession } from '../../../../../../lib/repositories/orchestrator.repository.js';

export async function POST(request, { params }) {
  const { id } = await params;

  let session = await getSession(id);
  if (!session) {
    session = await getLatestSession(id);
  }
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  return streamSSE(resumeAfterFeedback(session.id, '确认执行投放方案'));
}

// ... streamSSE helper same as above ...
```

- [ ] **Step 3: Remove start_phase from orchestrate route**

In `app/api/campaign/orchestrate/[id]/route.js`, remove the `startPhase` query param:

```javascript
// Remove: const startPhase = searchParams.get('start_phase') || undefined;
// Change: return streamSSE(orchestrate(session.id, { startPhase }));
// To:     return streamSSE(orchestrate(session.id));
```

- [ ] **Step 4: Commit**

```bash
git add app/api/campaign/orchestrate/
git commit -m "feat: add feedback endpoint, update approve to use resumeAfterFeedback"
```

---

### Task 7: Frontend — FeedbackCard + MessageBubble + ChatArea

**Files:**
- Create: `app/dashboard/campaign-studio/components/cards/FeedbackCard.js`
- Modify: `app/dashboard/campaign-studio/components/MessageBubble.js`
- Modify: `app/dashboard/campaign-studio/components/ChatArea.js`

- [ ] **Step 1: Write failing test for FeedbackCard**

```javascript
// app/dashboard/campaign-studio/components/__tests__/FeedbackCard.test.js
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import FeedbackCard from '../cards/FeedbackCard';

afterEach(() => { cleanup(); });

describe('FeedbackCard', () => {
  it('renders message and option buttons', () => {
    const onRespond = vi.fn();
    render(<FeedbackCard message="确认执行投放？" options={['确认', '取消']} onRespond={onRespond} />);

    expect(screen.getByText('确认执行投放？')).toBeDefined();
    expect(screen.getByText('确认')).toBeDefined();
    expect(screen.getByText('取消')).toBeDefined();
  });

  it('calls onRespond when option clicked', () => {
    const onRespond = vi.fn();
    render(<FeedbackCard message="确认？" options={['确认', '取消']} onRespond={onRespond} />);

    fireEvent.click(screen.getByText('确认'));
    expect(onRespond).toHaveBeenCalledWith('确认');
  });

  it('renders without options (free text implied)', () => {
    render(<FeedbackCard message="请补充素材信息" onRespond={() => {}} />);
    expect(screen.getByText('请补充素材信息')).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/dashboard/campaign-studio/components/__tests__/FeedbackCard.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Create FeedbackCard component**

```javascript
// app/dashboard/campaign-studio/components/cards/FeedbackCard.js
'use client';

export default function FeedbackCard({ message, options, onRespond }) {
  return (
    <div className="bg-white border border-blue-200 rounded-xl overflow-hidden shadow-sm">
      <div className="px-4 py-3 bg-blue-50 flex items-center gap-2 border-b border-blue-200">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="6" stroke="#2563eb" strokeWidth="1.5"/>
          <path d="M8 5v3M8 10h.01" stroke="#2563eb" strokeWidth="1.5" strokeLinecap="round"/>
        </svg>
        <span className="text-xs font-semibold text-blue-900">需要您的确认</span>
      </div>

      <div className="px-4 py-3 text-[13px] text-gray-700 leading-relaxed">
        {message}
      </div>

      {options && options.length > 0 && (
        <div className="px-4 py-2.5 border-t border-blue-200 flex gap-2">
          {options.map((opt, i) => (
            <button
              key={i}
              onClick={() => onRespond(opt)}
              className={`text-xs px-3.5 py-1.5 rounded-lg font-medium transition-colors ${
                i === 0
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/dashboard/campaign-studio/components/__tests__/FeedbackCard.test.js`
Expected: PASS

- [ ] **Step 5: Add feedback_required + phase_skipped to MessageBubble**

In `app/dashboard/campaign-studio/components/MessageBubble.js`, add import and cases:

```javascript
import FeedbackCard from './cards/FeedbackCard';

// Inside the JSX, after execution_complete block:
{type === 'feedback_required' && (
  <FeedbackCard
    message={message.message}
    options={message.options}
    onRespond={onFeedbackRespond}
  />
)}

{type === 'phase_skipped' && (
  <div className="text-xs text-gray-400 flex items-center gap-2 py-1">
    <div className="h-px flex-1 bg-gray-200" />
    <span>跳过: {message.reason}</span>
    <div className="h-px flex-1 bg-gray-200" />
  </div>
)}
```

Update the component signature:

```javascript
export default function MessageBubble({ message, onApprove, onReject, onFeedbackRespond }) {
```

- [ ] **Step 6: Add feedback handling to ChatArea**

In `ChatArea.js`, add to `consumeSSE` handler in `runOrchestration`:

```javascript
case 'feedback_required':
  setIsLoading(false);
  addMessage({
    type: 'feedback_required',
    message: data.message,
    options: data.options,
  });
  onSessionUpdate?.();
  break;

case 'phase_skipped':
  addMessage({
    type: 'phase_skipped',
    phase: data.phase,
    reason: data.reason,
  });
  break;
```

Add the feedback response handler:

```javascript
async function handleFeedbackRespond(response) {
  setIsLoading(true);
  try {
    // Remove the feedback card from messages
    setMessages(prev => prev.filter(m => m.type !== 'feedback_required'));

    const endpoint = sessionId
      ? `/api/campaign/orchestrate/${sessionId}/feedback`
      : `/api/campaign/orchestrate/${briefId}/feedback`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response }),
    });

    await consumeSSE(res, (event, data) => {
      // Reuse the same runOrchestration event handler
      // ... same switch cases as runOrchestration
    });
  } catch (err) {
    addMessage({ type: 'error', content: err.message });
  } finally {
    setIsLoading(false);
  }
}
```

Pass `onFeedbackRespond={handleFeedbackRespond}` to `MessageBubble`.

- [ ] **Step 7: Run all frontend tests**

Run: `npx vitest run app/dashboard/campaign-studio/components/__tests__/`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add app/dashboard/campaign-studio/
git commit -m "feat: add FeedbackCard, handle feedback_required + phase_skipped events"
```

---

### Task 8: Clean Up + Refactor DRY

**Files:**
- Modify: `src/campaign-orchestrator.service.js`

- [ ] **Step 1: Extract shared tool-handling loop**

The `orchestrate()` and `resumeAfterFeedback()` have duplicate switch logic. Extract into a shared generator:

```javascript
async function* runToolUseLoop(sessionId, brief, messages, initialPhaseResults, eventBuffer) {
  let phaseResults = { ...initialPhaseResults };

  for (let iteration = 0; iteration < MAX_ORCHESTRATOR_ITERATIONS; iteration++) {
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: ORCHESTRATOR_SYSTEM_PROMPT,
      messages,
      tools: ORCHESTRATOR_TOOLS,
      tool_choice: { type: 'auto' },
    });

    if (response.stop_reason !== 'tool_use') {
      await updateSession(sessionId, { status: 'completed', current_phase: 'done' });
      yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults) } };
      return;
    }

    // ... shared tool processing (same switch logic) ...
  }

  // Max iterations
  await updateSession(sessionId, { status: 'completed', current_phase: 'done' });
  yield { event: 'done', data: { session_id: sessionId, phases_completed: Object.keys(phaseResults), summary: 'Force-terminated: max iterations' } };
}
```

Then simplify both callers:

```javascript
export async function* orchestrate(sessionId) {
  // ... validation, build initial messages ...
  yield* runToolUseLoop(sessionId, brief, messages, phaseResults, []);
}

export async function* resumeAfterFeedback(sessionId, userResponse) {
  // ... validation, restore state, append tool_result ...
  yield* runToolUseLoop(sessionId, brief, messages, phaseResults, []);
}
```

- [ ] **Step 2: Remove old dead code**

Remove old `orchestrateAfterApproval` body (keep as wrapper), remove old `options` from `orchestrate`.

- [ ] **Step 3: Run all tests**

Run: `node --test tests/unit/campaign-orchestrator.test.js && npx vitest run app/dashboard/campaign-studio/components/__tests__/`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/campaign-orchestrator.service.js
git commit -m "refactor: extract shared runToolUseLoop, remove duplicate code"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Run all unit tests**

```bash
node --test tests/unit/campaign-orchestrator.test.js
node --test tests/unit/research-agent-instructions.test.js
npx vitest run app/dashboard/campaign-studio/components/__tests__/
```

- [ ] **Step 2: Verify exports**

Ensure all exported functions are correct:

```bash
node -e "import('./src/campaign-orchestrator.service.js').then(m => console.log(Object.keys(m)))"
```

Expected: `orchestrate`, `orchestrateAfterApproval`, `resumeAfterFeedback`, `chatWithOrchestrator`, `PHASES`, `detectStartPhase`, `summarizePhaseResult`, `formatProductsAsText`, `evaluateOutput`

- [ ] **Step 3: Commit final**

```bash
git add -A
git commit -m "feat: intelligent orchestrator with tool_use agent loop

Replaces hardcoded for-loop with Claude agent that dynamically decides
which phases to run. Supports skip, retry, evaluate, and user feedback.
Pause-resume via orchestrator_state column."
```
