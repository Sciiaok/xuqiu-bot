# Fire-and-Forget Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple backend task execution from HTTP connections so orchestration survives client disconnects, page refreshes, and network interruptions. Users can send messages to a running pipeline at any time.

**Architecture:** POST endpoints fire off the generator into a background `drainToRedis()` function (using Next.js `after()`) and return immediately. All SSE consumption goes through the existing `/stream` endpoint which reads from Redis. A new `/message` endpoint lets users push messages into a Redis List that the orchestrator checks at natural breakpoints (between LLM iterations, between phase executions). Frontend persists `lastEventId` to `sessionStorage` for seamless reconnect after refresh.

**Tech Stack:** Next.js 16 `after()`, ioredis (XADD, LPUSH, BRPOP, LRANGE), existing Supabase persistence

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/redis.js` | Modify | Add `userInputKey()`, export helpers |
| `lib/sse.js` | Modify | Add `drainToRedis()` function |
| `lib/consume-sse.js` | No change | — |
| `app/api/campaign/orchestrate/[id]/route.js` | Modify | POST: fire-and-forget + redirect to stream |
| `app/api/campaign/orchestrate/[id]/feedback/route.js` | Modify | Same pattern as POST |
| `app/api/campaign/orchestrate/[id]/approve/route.js` | Modify | Same pattern as POST |
| `app/api/campaign/orchestrate/[id]/stream/route.js` | Modify | Support `lastEventId=0-0` and omitted param |
| `app/api/campaign/orchestrate/[id]/message/route.js` | Create | LPUSH user message to Redis + persist to Supabase |
| `src/campaign-orchestrator.service.js` | Modify | Check user input queue at natural breakpoints |
| `app/v5/(app)/campaign-studio/page.js` | Modify | Use `/stream` for all SSE; persist lastEventId to sessionStorage; use `/message` for mid-pipeline messages |

---

### Task 1: Add Redis helpers for user input queue

**Files:**
- Modify: `lib/redis.js`

- [ ] **Step 1: Add `userInputKey` and queue constants**

```js
/** Redis List key for user messages sent during a running pipeline */
export function userInputKey(sessionId) {
  return `user_input:${sessionId}`;
}

/** TTL for user input keys: 4 hours (same as stream) */
export const USER_INPUT_TTL_SECONDS = 4 * 60 * 60;
```

Add these after the existing `streamKey` and `STREAM_TTL_SECONDS` exports.

- [ ] **Step 2: Commit**

```bash
git add lib/redis.js
git commit -m "feat: add userInputKey helper to redis module"
```

---

### Task 2: Add `drainToRedis()` to `lib/sse.js`

**Files:**
- Modify: `lib/sse.js`

- [ ] **Step 1: Add `drainToRedis` function**

Add this function after the existing `streamSSE` export:

```js
/**
 * Consume an async generator and write all events to a Redis Stream.
 * Runs independently of any HTTP response — designed for fire-and-forget use with Next.js after().
 *
 * @param {AsyncGenerator} generator - yields { event, data } objects
 * @param {string} key - Redis Stream key (e.g. streamKey(briefId))
 */
export async function drainToRedis(generator, key) {
  const redis = getRedis();
  let ttlSet = false;

  try {
    for await (const event of generator) {
      try {
        await redis.xadd(
          key, '*',
          'event', event.event,
          'data', JSON.stringify(event.data),
        );
        if (!ttlSet) {
          await redis.expire(key, STREAM_TTL_SECONDS);
          ttlSet = true;
        }
      } catch (err) {
        console.warn('[drainToRedis] XADD failed, continuing:', err.message);
      }
    }
  } catch (err) {
    // Write terminal error event so /stream clients know the task failed
    try {
      await redis.xadd(
        key, '*',
        'event', 'error',
        'data', JSON.stringify({ message: err.message }),
      );
    } catch {}
    console.error('[drainToRedis] generator threw:', err.message);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/sse.js
git commit -m "feat: add drainToRedis for fire-and-forget generator consumption"
```

---

### Task 3: Modify POST `/orchestrate/[id]` to fire-and-forget

**Files:**
- Modify: `app/api/campaign/orchestrate/[id]/route.js`

- [ ] **Step 1: Rewrite POST handler**

The intake path stays unchanged (lightweight, direct stream). The orchestrator path switches to fire-and-forget.

```js
import { after } from 'next/server';
import { createClient } from '../../../../../lib/supabase-server.js';
import { chatWithOrchestrator } from '../../../../../src/campaign-orchestrator.service.js';
import { processIntakeMessage } from '../../../../../src/campaign-intake.service.js';
import {
  createSession,
  getSession,
  getLatestSession,
  updateSessionIfStatus,
  getMessages,
} from '../../../../../lib/repositories/orchestrator.repository.js';
import { getBrief } from '../../../../../lib/repositories/campaign-brief.repository.js';
import { streamSSE } from '../../../../../lib/sse.js';
import { drainToRedis } from '../../../../../lib/sse.js';
import { streamKey } from '../../../../../lib/redis.js';

export async function POST(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let body = {};
  try { body = await request.json(); } catch { /* empty body */ }

  // Resolve session
  let session = await getSession(id);
  let brief = null;
  if (!session) {
    brief = await getBrief(id);
    if (!brief) {
      return Response.json({ error: 'Brief or session not found' }, { status: 404 });
    }
    session = await getLatestSession(id);
    if (!session) {
      session = await createSession(id, { status: 'intake', current_phase: 'intake' });
    }
  }

  if (!brief) {
    brief = await getBrief(session.brief_id);
  }
  if (!brief) {
    return Response.json({ error: 'Brief not found' }, { status: 404 });
  }

  // Intake phase: lightweight direct stream (no fire-and-forget needed)
  if (session.status === 'intake' && session.current_phase === 'intake' && (body.message || body.attachments)) {
    return streamSSE(
      processIntakeMessage(brief.id, body.message || '', { attachments: body.attachments }),
      { heartbeatIntervalMs: 5000, streamKey: streamKey(brief.id) },
    );
  }

  // Require a message
  if (!body.message && !body.attachments?.length) {
    return Response.json({ error: 'Message or attachments required' }, { status: 400 });
  }

  // Fire-and-forget: drain generator to Redis in background
  const key = streamKey(brief.id);
  const generator = chatWithOrchestrator(session.id, body.message || '', { attachments: body.attachments });

  after(async () => {
    try {
      await drainToRedis(generator, key);
    } catch (err) {
      console.error('[orchestrate POST] drainToRedis failed:', err.message);
      await updateSessionIfStatus(session.id, 'running', { status: 'interrupted' });
    }
  });

  return Response.json({
    session_id: session.id,
    brief_id: brief.id,
    stream_key: key,
  });
}
```

Keep the existing `GET` handler unchanged.

- [ ] **Step 2: Commit**

```bash
git add app/api/campaign/orchestrate/[id]/route.js
git commit -m "feat: POST orchestrate fire-and-forget via after() + drainToRedis"
```

---

### Task 4: Modify feedback and approve routes to fire-and-forget

**Files:**
- Modify: `app/api/campaign/orchestrate/[id]/feedback/route.js`
- Modify: `app/api/campaign/orchestrate/[id]/approve/route.js`

- [ ] **Step 1: Rewrite feedback route**

```js
import { after } from 'next/server';
import { createClient } from '../../../../../../lib/supabase-server.js';
import { resumeAfterFeedback } from '../../../../../../src/campaign-orchestrator.service.js';
import { getSession, getLatestSession, updateSessionIfStatus } from '../../../../../../lib/repositories/orchestrator.repository.js';
import { drainToRedis } from '../../../../../../lib/sse.js';
import { streamKey } from '../../../../../../lib/redis.js';
import { getBrief } from '../../../../../../lib/repositories/campaign-brief.repository.js';

export async function POST(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const hasResponse = Boolean(body.response);
  const hasAttachments = Array.isArray(body.attachments) && body.attachments.length > 0;
  if (!hasResponse && !hasAttachments) {
    return Response.json({ error: 'Missing response field' }, { status: 400 });
  }

  const responseText = body.response || '用户上传了参考图片';

  let session = await getSession(id);
  if (!session) {
    session = await getLatestSession(id);
  }
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const brief = await getBrief(session.brief_id);
  const key = brief ? streamKey(brief.id) : undefined;
  const sessionId = session.id;

  if (key) {
    const generator = resumeAfterFeedback(sessionId, responseText, { attachments: body.attachments });
    after(async () => {
      try {
        await drainToRedis(generator, key);
      } catch (err) {
        console.error('[feedback] drainToRedis failed:', err.message);
        await updateSessionIfStatus(sessionId, 'running', { status: 'interrupted' });
      }
    });
  }

  return Response.json({ session_id: sessionId, brief_id: session.brief_id });
}
```

- [ ] **Step 2: Rewrite approve route**

```js
import { after } from 'next/server';
import { createClient } from '../../../../../../lib/supabase-server.js';
import { resumeAfterFeedback } from '../../../../../../src/campaign-orchestrator.service.js';
import { getSession, getLatestSession } from '../../../../../../lib/repositories/orchestrator.repository.js';
import { drainToRedis } from '../../../../../../lib/sse.js';
import { streamKey } from '../../../../../../lib/redis.js';
import { getBrief } from '../../../../../../lib/repositories/campaign-brief.repository.js';

export async function POST(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let session = await getSession(id);
  if (!session) {
    session = await getLatestSession(id);
  }
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const brief = await getBrief(session.brief_id);
  const key = brief ? streamKey(brief.id) : undefined;

  if (key) {
    const generator = resumeAfterFeedback(session.id, '确认执行投放方案');
    after(async () => {
      try {
        await drainToRedis(generator, key);
      } catch (err) {
        console.error('[approve] drainToRedis failed:', err.message);
      }
    });
  }

  return Response.json({ session_id: session.id, brief_id: session.brief_id });
}
```

- [ ] **Step 3: Commit**

```bash
git add app/api/campaign/orchestrate/[id]/feedback/route.js app/api/campaign/orchestrate/[id]/approve/route.js
git commit -m "feat: feedback/approve routes fire-and-forget via after()"
```

---

### Task 5: Update `/stream` endpoint to support first-connect (`0-0`)

**Files:**
- Modify: `app/api/campaign/orchestrate/[id]/stream/route.js`

- [ ] **Step 1: Allow missing `lastEventId`, default to `0-0`**

Replace lines 28-35 (the validation block):

```js
  // Old:
  // if (!lastEventId || !VALID_STREAM_ID.test(lastEventId)) {
  //   return Response.json(...)
  // }
```

With:

```js
  const lastEventId = searchParams.get('lastEventId') || '0-0';

  if (!VALID_STREAM_ID.test(lastEventId)) {
    return Response.json(
      { error: 'Invalid lastEventId format (expected: digits-digits, e.g. 0-0)' },
      { status: 400 },
    );
  }
```

Also change the XRANGE start for `0-0` — when `lastEventId` is `0-0`, we want everything from the beginning, so use `-` instead of `(0-0`:

Replace the XRANGE call (line 65):

```js
  // Use '-' for 0-0 (read from start), otherwise exclusive start
  const rangeStart = lastEventId === '0-0' ? '-' : '(' + lastEventId;
  const replayEvents = await redis.xrange(key, rangeStart, '+');
```

- [ ] **Step 2: Commit**

```bash
git add app/api/campaign/orchestrate/[id]/stream/route.js
git commit -m "feat: /stream supports first-connect with lastEventId=0-0 or omitted"
```

---

### Task 6: Create `/message` endpoint for mid-pipeline user messages

**Files:**
- Create: `app/api/campaign/orchestrate/[id]/message/route.js`

- [ ] **Step 1: Create the message route**

```js
import { createClient } from '../../../../../../lib/supabase-server.js';
import { getSession, getLatestSession, addMessages, getNextMessageIndex } from '../../../../../../lib/repositories/orchestrator.repository.js';
import { getRedis, userInputKey, USER_INPUT_TTL_SECONDS } from '../../../../../../lib/redis.js';

/**
 * POST /api/campaign/orchestrate/[id]/message
 *
 * Push a user message into the running pipeline's input queue.
 * The orchestrator picks it up at the next natural breakpoint.
 *
 * Body: { message: "…", attachments?: [] }
 */
export async function POST(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  let body;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.message && !body.attachments?.length) {
    return Response.json({ error: 'Message or attachments required' }, { status: 400 });
  }

  let session = await getSession(id);
  if (!session) {
    session = await getLatestSession(id);
  }
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  // Persist to Supabase (permanent record)
  const messageIndex = await getNextMessageIndex(session.id);
  await addMessages(session.id, [{
    phase: null,
    role: 'user',
    content: body.message || '',
    message_index: messageIndex,
    attachments: body.attachments?.length ? body.attachments : undefined,
  }]);

  // Push to Redis queue (ephemeral, consumed by task runner)
  const redis = getRedis();
  const key = userInputKey(session.id);
  try {
    await redis.lpush(key, JSON.stringify({
      content: body.message || '',
      attachments: body.attachments || [],
      timestamp: Date.now(),
    }));
    await redis.expire(key, USER_INPUT_TTL_SECONDS);
  } catch (err) {
    console.warn('[message] Redis LPUSH failed:', err.message);
  }

  return Response.json({ ok: true, session_id: session.id });
}
```

- [ ] **Step 2: Commit**

```bash
git add app/api/campaign/orchestrate/[id]/message/route.js
git commit -m "feat: add /message endpoint for mid-pipeline user input"
```

---

### Task 7: Orchestrator checks user input queue at breakpoints

**Files:**
- Modify: `src/campaign-orchestrator.service.js`

- [ ] **Step 1: Add helper to check and consume user input**

Add near the top of the file, after existing imports:

```js
import { getRedis, userInputKey } from '../lib/redis.js';
```

Add a helper function before `runToolUseLoop`:

```js
/**
 * Check Redis queue for user messages sent during pipeline execution.
 * Returns array of messages (may be empty). Non-blocking, non-fatal.
 */
async function consumeUserInput(sessionId) {
  try {
    const redis = getRedis();
    const key = userInputKey(sessionId);
    const items = await redis.lrange(key, 0, -1);
    if (items.length > 0) {
      await redis.del(key);
      return items.map(raw => JSON.parse(raw)).reverse(); // LPUSH stores newest first, reverse to chronological
    }
  } catch (err) {
    console.warn('[orchestrator] consumeUserInput failed:', err.message);
  }
  return [];
}
```

- [ ] **Step 2: Inject user input check into `runToolUseLoop` at natural breakpoints**

In `runToolUseLoop`, at the **top of each iteration** (after the checkpoint save, before the LLM call — around line 593), add:

```js
    // ── Check for user messages sent during pipeline execution ──
    const userInputs = await consumeUserInput(sessionId);
    if (userInputs.length > 0) {
      for (const input of userInputs) {
        messages.push({ role: 'user', content: input.content });
        yield { event: 'user_injected', data: { content: input.content } };
      }
    }
```

Insert this block right after the `yield { event: 'phase_progress', ... thinking }` line (line 593) and before the LLM stream call (line 596), so the injected messages are included in the next LLM context.

- [ ] **Step 3: Inject user input check into `chatWithOrchestrator` lightweight loop**

In the `chatWithOrchestrator` function, at the top of the `for (let turn = 0; ...)` loop (around line 1209), add the same check:

```js
    // Check for user messages sent while chat loop is running
    const userInputs = await consumeUserInput(sessionId);
    if (userInputs.length > 0) {
      for (const input of userInputs) {
        currentMessages.push({ role: 'user', content: input.content });
        yield { event: 'user_injected', data: { content: input.content } };
      }
    }
```

- [ ] **Step 4: Remove `onAbort` session interruption logic**

Since the generator no longer runs inside the HTTP response, the `onAbort` callback in route handlers is gone (already removed in Task 3/4). But check that `campaign-orchestrator.service.js` itself does not rely on any abort signal. It doesn't — it only uses its own error handling (`try/catch` around LLM calls) which remains correct.

- [ ] **Step 5: Commit**

```bash
git add src/campaign-orchestrator.service.js
git commit -m "feat: orchestrator checks Redis user input queue at breakpoints"
```

---

### Task 8: Frontend — switch to `/stream` for all SSE, persist lastEventId

**Files:**
- Modify: `app/v5/(app)/campaign-studio/page.js`

- [ ] **Step 1: Add sessionStorage helpers for lastEventId**

Add near the top of the component (after the state declarations):

```js
  // ── Persist lastEventId to sessionStorage for reconnect after refresh ──
  function saveLastEventId(sessionId, eventId) {
    if (sessionId && eventId) {
      try { sessionStorage.setItem(`sse_last_id:${sessionId}`, eventId); } catch {}
    }
  }
  function loadLastEventId(sessionId) {
    try { return sessionStorage.getItem(`sse_last_id:${sessionId}`) || '0-0'; } catch { return '0-0'; }
  }
```

- [ ] **Step 2: Rewrite `handleSend` — POST returns JSON, then connect to `/stream`**

Replace the SSE consumption block in `handleSend` (the `try` block starting around line 854). The key changes:
- POST no longer returns SSE — it returns `{ session_id, brief_id }` (for orchestrator path)
- Intake path still returns SSE (unchanged)
- After POST, connect to `/stream?lastEventId=0-0` for real-time events
- Track `lastEventId` from `consumeSSE` and save to sessionStorage

```js
    try {
      const isFeedbackMode = session.status === 'awaiting_feedback' || session.status === 'awaiting_approval';
      const baseId = session.session_id || session.brief_id;
      const endpoint = isFeedbackMode
        ? `/api/campaign/orchestrate/${baseId}/feedback`
        : `/api/campaign/orchestrate/${baseId}`;
      const payload = isFeedbackMode ? { response: text } : { message: text };
      if (attachments.length) payload.attachments = attachments;

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => res.statusText);
        throw new Error(errBody || `Server error (${res.status})`);
      }

      const contentType = res.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream')) {
        // Intake path — still direct SSE stream
        let assistantText = '';
        const { consumeSSE } = await import('../../../../lib/consume-sse');
        const lastId = await consumeSSE(res, (event, data) => {
          if (!isActiveSessionKey(sessionKey)) return;
          switch (event) {
            case 'delta':
              assistantText += data.text;
              setStreamingTextForSession(sessionKey, assistantText);
              break;
            case 'thinking':
              pushStreamingStepForSession(sessionKey, { tool: null, content: data.text, phase: null });
              break;
            case 'tool_start':
              pushStreamingStepForSession(sessionKey, { tool: data.tool, content: '', phase: null });
              break;
            case 'tool_call':
              pushStreamingStepForSession(sessionKey, { tool: data.tool, content: JSON.stringify(data.input, null, 2).slice(0, 200), phase: null });
              break;
            case 'tool_result':
              pushStreamingStepForSession(sessionKey, { tool: data.tool, content: JSON.stringify(data.result, null, 2).slice(0, 200), phase: null });
              break;
            case 'brief_update':
              if (data.completion) updateSessionStatus(sessionKey, { completion: data.completion });
              break;
            case 'done':
              break;
          }
        });
        if (lastId) saveLastEventId(session.session_id, lastId);
        if (assistantText) {
          appendMessageForSession(sessionKey, { id: `ai-${Date.now()}`, type: 'assistant', content: assistantText });
          setStreamingTextForSession(sessionKey, '');
        }
      } else {
        // Orchestrator path — JSON response, then connect to /stream
        const result = await res.json();
        const sid = result.session_id || session.session_id;

        // Connect to /stream for real-time events
        await connectToStream(sessionKey, sid, baseId, '0-0');
      }
    } catch (err) {
      console.error('Error sending message:', err);
      appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: `发送失败: ${err.message}` });
      setShowReconnect(true);
    } finally {
      setSendingMsg(false);
      setStreamingTextForSession(sessionKey, '');
      flushStreamingSteps(sessionKey);
    }
```

- [ ] **Step 3: Extract shared `connectToStream` function**

Add this function inside the component, before `handleSend`:

```js
  async function connectToStream(sessionKey, sessionId, baseId, startEventId) {
    let assistantText = '';
    let streamDone = false;
    const { consumeSSE } = await import('../../../../lib/consume-sse');

    const handleEvent = (event, data) => {
      if (!isActiveSessionKey(sessionKey)) return;
      switch (event) {
        case 'delta':
          assistantText += data.text;
          setStreamingTextForSession(sessionKey, assistantText);
          break;
        case 'thinking':
          pushStreamingStepForSession(sessionKey, { tool: null, content: data.text, phase: null });
          break;
        case 'tool_start':
          pushStreamingStepForSession(sessionKey, { tool: data.tool, content: '', phase: null });
          break;
        case 'tool_call':
          pushStreamingStepForSession(sessionKey, { tool: data.tool, content: JSON.stringify(data.input, null, 2).slice(0, 200), phase: null });
          break;
        case 'tool_result':
          pushStreamingStepForSession(sessionKey, { tool: data.tool, content: JSON.stringify(data.result, null, 2).slice(0, 200), phase: null });
          break;
        case 'orchestration_start':
          if (assistantText) {
            appendMessageForSession(sessionKey, { id: `ai-${Date.now()}`, type: 'assistant', content: assistantText });
            setStreamingTextForSession(sessionKey, '');
            assistantText = '';
          }
          flushStreamingSteps(sessionKey);
          pushStreamingStepForSession(sessionKey, { tool: null, content: '▶ 投放流程启动' });
          updateSessionStatus(sessionKey, { status: 'running', current_phase: 'orchestrating' });
          break;
        case 'phase_start':
          pushStreamingStepForSession(sessionKey, { tool: null, content: `▶ ${PHASE_LABELS[data.phase] || data.phase}`, phase: data.phase });
          updateSessionStatus(sessionKey, { current_phase: data.phase });
          break;
        case 'phase_progress':
          pushStreamingStepForSession(sessionKey, { tool: data.step, content: data.detail || data.step, phase: data.phase });
          break;
        case 'phase_complete': {
          pushStreamingStepForSession(sessionKey, { tool: null, content: `✓ ${PHASE_LABELS[data.phase] || data.phase} 完成`, phase: data.phase });
          const builder = phaseResultBuilders[data.phase];
          if (builder && data.result) {
            const card = builder(data.result);
            if (card) appendMessageForSession(sessionKey, { id: `phase-${data.phase}-${Date.now()}`, ...card });
          }
          break;
        }
        case 'approval_required':
          appendMessageForSession(sessionKey, { id: `approval-${Date.now()}`, type: 'execution_approval', plan: data.plan, status: 'awaiting_approval' });
          updateSessionStatus(sessionKey, { status: 'awaiting_approval' });
          break;
        case 'feedback_required':
          appendMessageForSession(sessionKey, { id: `fb-${Date.now()}`, type: 'feedback_required', message: data.message || '需要您的确认', options: data.options || [] });
          updateSessionStatus(sessionKey, { status: 'awaiting_feedback' });
          break;
        case 'user_injected':
          // User message was injected into pipeline — already shown in chat
          break;
        case 'phase_error':
          appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: `${PHASE_LABELS[data.phase] || data.phase} 失败: ${data.error}` });
          break;
        case 'error':
          appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: data.message || '发生错误' });
          streamDone = true;
          break;
        case 'done':
          if (data.phases_completed?.length) {
            appendMessageForSession(sessionKey, { id: `done-${Date.now()}`, type: 'assistant', content: `投放方案已完成！共执行 ${data.phases_completed.length} 个阶段：${data.phases_completed.join(' → ')}` });
            updateSessionStatus(sessionKey, { status: 'completed', current_phase: 'done' });
          }
          streamDone = true;
          break;
      }
    };

    const streamUrl = `/api/campaign/orchestrate/${baseId}/stream?lastEventId=${encodeURIComponent(startEventId)}`;
    try {
      const streamRes = await fetch(streamUrl);
      if (streamRes.ok) {
        const lastId = await consumeSSE(streamRes, handleEvent);
        if (lastId) saveLastEventId(sessionId, lastId);
      }
    } catch (err) {
      console.warn('Stream connection failed:', err.message);
    }

    // Flush remaining text
    if (assistantText) {
      appendMessageForSession(sessionKey, { id: `ai-${Date.now()}`, type: 'assistant', content: assistantText });
      setStreamingTextForSession(sessionKey, '');
    }
  }
```

- [ ] **Step 4: Update `handleFeedbackRespond` to use same pattern**

Replace the SSE consumption in `handleFeedbackRespond` (around line 1006-1076):

```js
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response, attachments }),
      });
      if (!res.ok) {
        appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: `反馈提交失败: ${res.status}` });
        return;
      }

      const fbBaseId = session.session_id || session.brief_id;
      await connectToStream(sessionKey, session.session_id, fbBaseId, '0-0');
    } catch (err) {
      appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: err.message });
    } finally {
      setSendingMsg(false);
      flushStreamingSteps(sessionKey);
    }
```

- [ ] **Step 5: Update `fetchMessages` to auto-reconnect using saved lastEventId**

In the `fetchMessages` function (around line 766, after `replaceMessagesForSession`), replace the stalled pipeline recovery comment with:

```js
        // Auto-reconnect to stream if pipeline is still running
        if (orchData.status === 'running' || orchData.status === 'awaiting_feedback') {
          const savedId = loadLastEventId(selectedSession.session_id);
          const reconnectBaseId = selectedSession.session_id || selectedSession.brief_id;
          connectToStream(sessionKey, selectedSession.session_id, reconnectBaseId, savedId);
        }
```

- [ ] **Step 6: Add mid-pipeline message sending via `/message` endpoint**

In `handleSend`, add a check: if the session status is `running`, send via `/message` instead of the main POST endpoint. Add this block at the start of `handleSend`, after the early returns:

```js
    // If pipeline is running, send via /message endpoint (non-blocking injection)
    if (session.status === 'running') {
      const baseId = session.session_id || session.brief_id;
      try {
        const res = await fetch(`/api/campaign/orchestrate/${baseId}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, attachments }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: `发送失败: ${err.message}` });
      } finally {
        setSendingMsg(false);
      }
      return;
    }
```

- [ ] **Step 7: Commit**

```bash
git add app/v5/(app)/campaign-studio/page.js
git commit -m "feat: frontend uses /stream for all SSE, persists lastEventId, supports /message"
```

---

### Task 9: Handle `feedback_required` with BRPOP in orchestrator

**Files:**
- Modify: `src/campaign-orchestrator.service.js`

- [ ] **Step 1: Replace feedback pause/resume with BRPOP wait**

Currently when the orchestrator hits `request_user_feedback`, it saves state, yields `feedback_required`, and returns. The user then calls `/feedback` which creates a new generator via `resumeAfterFeedback()`.

With fire-and-forget, the generator keeps running. Instead of returning, it should BRPOP wait for user input on the Redis queue.

In `runToolUseLoop`, replace the `pendingFeedback` handling block (around line 895-912):

```js
    if (pendingFeedback) {
      // Save state for crash recovery (still needed)
      await updateSessionIfStatus(sessionId, 'running', {
        status: 'awaiting_feedback',
        orchestrator_state: {
          messages: [...messages],
          pending_tool_use_id: pendingFeedback.id,
          completed_tool_results: toolResults,
          phase_results_snapshot: phaseResults,
        },
      });
      await addMessages(sessionId, [{
        phase: null, role: 'event', tool_name: 'feedback_required',
        content: pendingFeedback.message,
        tool_result: { options: pendingFeedback.options },
        message_index: await getNextMessageIndex(sessionId),
      }]);
      yield { event: 'feedback_required', data: { message: pendingFeedback.message, options: pendingFeedback.options, tool_use_id: pendingFeedback.id } };

      // Wait for user response via Redis queue (up to 30 min)
      const redis = getRedis();
      const inputKey = userInputKey(sessionId);
      const waitResult = await redis.brpop(inputKey, 1800);
      if (!waitResult) {
        // Timeout — leave session in awaiting_feedback for manual resume
        yield { event: 'error', data: { message: '等待反馈超时 (30分钟)', recoverable: true } };
        return;
      }

      const userInput = JSON.parse(waitResult[1]);
      const feedbackPayload = { user_response: userInput.content };
      if (userInput.attachments?.length) {
        feedbackPayload.uploaded_images = userInput.attachments
          .filter(a => a.content_type?.startsWith('image/'))
          .map(a => ({ url: a.url, filename: a.filename }));
      }

      // Append completed tool results + feedback as tool_result
      messages.push({
        role: 'user',
        content: [
          ...toolResults,
          {
            type: 'tool_result',
            tool_use_id: pendingFeedback.id,
            content: JSON.stringify(feedbackPayload),
          },
        ],
      });

      // Resume
      await updateSessionIfStatus(sessionId, 'awaiting_feedback', {
        status: 'running',
        orchestrator_state: null,
      });
      continue; // next iteration of the tool-use loop
    }
```

- [ ] **Step 2: Update frontend feedback to use `/message` endpoint**

In the V5 frontend's `handleFeedbackRespond`, change it to POST to `/message` instead of `/feedback`:

```js
  async function handleFeedbackRespond(response) {
    const session = selectedSession;
    const sessionKey = getSessionKey(session);
    const attachments = pendingImages.filter(p => p.uploaded).map(p => p.uploaded);
    const baseId = session.session_id || session.brief_id;

    // Mark feedback card as resolved
    if (isActiveSessionKey(sessionKey)) {
      setMessages(prev => prev.map(m =>
        m.type === 'feedback_required' ? { ...m, type: 'feedback_resolved', selectedOption: response } : m
      ));
      setMessages(prev => [...prev, {
        id: `fb-resp-${Date.now()}`,
        type: 'user',
        content: response,
        attachments: attachments.length ? attachments : undefined,
      }]);
    }
    setSendingMsg(true);
    setPendingImages([]);

    try {
      const res = await fetch(`/api/campaign/orchestrate/${baseId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: response, attachments }),
      });
      if (!res.ok) {
        appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: `反馈提交失败: ${res.status}` });
      }
      // Events will arrive via the already-connected /stream
    } catch (err) {
      appendMessageForSession(sessionKey, { id: `err-${Date.now()}`, type: 'error', content: err.message });
    } finally {
      setSendingMsg(false);
      flushStreamingSteps(sessionKey);
    }
  }
```

- [ ] **Step 3: Keep `/feedback` route as crash-recovery fallback**

Don't delete the `/feedback` route — it's needed when the server restarts and the BRPOP listener is gone. In that case, the session is `awaiting_feedback` with a saved `orchestrator_state`, and `/feedback` creates a new generator that resumes from checkpoint. This is the existing crash recovery path, no changes needed.

- [ ] **Step 4: Commit**

```bash
git add src/campaign-orchestrator.service.js app/v5/(app)/campaign-studio/page.js
git commit -m "feat: orchestrator BRPOP waits for feedback instead of returning"
```

---

### Task 10: Integration test — manual verification

- [ ] **Step 1: Test normal flow**

1. Start a new campaign session
2. Send a message that triggers orchestration
3. Verify POST returns JSON (not SSE stream)
4. Verify `/stream` connection picks up events
5. Verify phases complete normally

- [ ] **Step 2: Test disconnect recovery**

1. Start orchestration
2. Refresh the page mid-pipeline
3. Verify UI rebuilds from Supabase state
4. Verify `/stream` reconnects using saved `lastEventId`
5. Verify remaining events arrive

- [ ] **Step 3: Test mid-pipeline message**

1. Start orchestration
2. While running, type a message in the chat
3. Verify message goes to `/message` endpoint
4. Verify orchestrator picks it up at next breakpoint

- [ ] **Step 4: Test feedback flow**

1. Trigger a pipeline that requests feedback
2. Verify `feedback_required` card appears
3. Respond to the feedback
4. Verify response goes via `/message`
5. Verify orchestrator resumes from BRPOP
