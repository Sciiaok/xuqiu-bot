# Redis Stream SSE Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Redis Stream as an event persistence layer to all SSE streaming endpoints, enabling seamless client reconnection without message loss.

**Architecture:** Every SSE event is dual-written — to the HTTP response (real-time) and to a Redis Stream via XADD (persistence). Each event carries a Redis Stream ID as its SSE `id:` field. On reconnect, a dedicated GET endpoint replays missed events via XRANGE then switches to XREAD BLOCK for real-time. Frontend silently reconnects using the last received event ID.

**Tech Stack:** ioredis, Redis Streams (XADD/XRANGE/XREAD BLOCK), Next.js App Router SSE

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `lib/redis.js` | Redis client singleton (shared) + factory for dedicated XREAD connections |
| Modify | `lib/sse.js` | Add `streamKey` option → XADD each event, emit `id:` field, EXPIRE on first write |
| Create | `app/api/campaign/orchestrate/[id]/stream/route.js` | GET endpoint for reconnection: XRANGE replay + XREAD BLOCK real-time |
| Modify | `app/api/campaign/orchestrate/[id]/route.js` | Pass `streamKey` to `streamSSE()` calls |
| Modify | `app/api/campaign/orchestrate/[id]/feedback/route.js` | Pass `streamKey` to `streamSSE()` |
| Modify | `app/api/campaign/orchestrate/[id]/approve/route.js` | Pass `streamKey` to `streamSSE()` |
| Modify | `app/dashboard/campaign-studio/components/ChatArea.js` | Replace polling with auto-reconnect via GET stream endpoint |
| Create | `tests/unit/redis-sse.test.js` | Unit tests for lib/redis.js and lib/sse.js Redis integration |
| Create | `tests/unit/sse-reconnect-endpoint.test.js` | Unit tests for the GET stream reconnect endpoint |

---

### Task 1: Install ioredis + Create Redis Client

**Files:**
- Create: `lib/redis.js`
- Modify: `package.json` (via npm install)

- [ ] **Step 1: Install ioredis**

```bash
npm install ioredis
```

- [ ] **Step 2: Create `lib/redis.js`**

```js
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

/** Shared connection for non-blocking commands (XADD, XRANGE, EXPIRE, DEL) */
let sharedClient = null;

export function getRedis() {
  if (!sharedClient) {
    sharedClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    sharedClient.on('error', (err) => {
      console.error('[redis] shared client error:', err.message);
    });
  }
  return sharedClient;
}

/**
 * Create a dedicated connection for XREAD BLOCK.
 * Caller MUST call .disconnect() when done to avoid connection leaks.
 */
export function createBlockingClient() {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null, // no retry limit for blocking reads
    lazyConnect: true,
  });
  client.on('error', (err) => {
    console.error('[redis] blocking client error:', err.message);
  });
  return client;
}

/** Stream key for a given briefId */
export function streamKey(briefId) {
  return `sse:${briefId}`;
}

/** TTL for stream keys: 4 hours */
export const STREAM_TTL_SECONDS = 4 * 60 * 60;
```

- [ ] **Step 3: Add `REDIS_URL` to `.env.local`**

```
REDIS_URL=redis://127.0.0.1:6379
```

- [ ] **Step 4: Commit**

```bash
git add lib/redis.js package.json package-lock.json
git commit -m "feat: add ioredis dependency and Redis client module"
```

---

### Task 2: Enhance `lib/sse.js` with Redis Stream Write

**Files:**
- Modify: `lib/sse.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/redis-sse.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ioredis before importing sse.js
const mockXadd = vi.fn().mockResolvedValue('1234567890-0');
const mockExpire = vi.fn().mockResolvedValue(1);
vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({ xadd: mockXadd, expire: mockExpire }),
  streamKey: (id) => `sse:${id}`,
  STREAM_TTL_SECONDS: 14400,
}));

const { streamSSE } = await import('../../lib/sse.js');

describe('streamSSE with Redis Stream', () => {
  beforeEach(() => {
    mockXadd.mockClear();
    mockExpire.mockClear();
  });

  it('should emit SSE id: field from Redis Stream ID when streamKey provided', async () => {
    async function* gen() {
      yield { event: 'delta', data: { text: 'hello' } };
    }

    const response = streamSSE(gen(), { streamKey: 'sse:brief-1' });
    const text = await response.text();

    expect(text).toContain('id: 1234567890-0');
    expect(text).toContain('event: delta');
    expect(text).toContain('data: {"text":"hello"}');
  });

  it('should XADD each event to Redis Stream', async () => {
    async function* gen() {
      yield { event: 'delta', data: { text: 'hi' } };
      yield { event: 'done', data: {} };
    }

    const response = streamSSE(gen(), { streamKey: 'sse:brief-2' });
    await response.text();

    expect(mockXadd).toHaveBeenCalledTimes(2);
    expect(mockXadd).toHaveBeenCalledWith(
      'sse:brief-2', '*',
      'event', 'delta',
      'data', '{"text":"hi"}',
    );
  });

  it('should set EXPIRE on first XADD', async () => {
    async function* gen() {
      yield { event: 'delta', data: { text: 'a' } };
      yield { event: 'delta', data: { text: 'b' } };
    }

    const response = streamSSE(gen(), { streamKey: 'sse:brief-3' });
    await response.text();

    expect(mockExpire).toHaveBeenCalledTimes(1);
    expect(mockExpire).toHaveBeenCalledWith('sse:brief-3', 14400);
  });

  it('should work without streamKey (backward compatible)', async () => {
    async function* gen() {
      yield { event: 'delta', data: { text: 'no redis' } };
    }

    const response = streamSSE(gen());
    const text = await response.text();

    expect(text).toContain('event: delta');
    expect(text).not.toContain('id:');
    expect(mockXadd).not.toHaveBeenCalled();
  });

  it('should not break SSE if XADD fails', async () => {
    mockXadd.mockRejectedValueOnce(new Error('Redis down'));

    async function* gen() {
      yield { event: 'delta', data: { text: 'still works' } };
    }

    const response = streamSSE(gen(), { streamKey: 'sse:brief-4' });
    const text = await response.text();

    expect(text).toContain('event: delta');
    expect(text).toContain('data: {"text":"still works"}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/redis-sse.test.js
```

Expected: FAIL — `streamSSE` does not accept `streamKey`, no `id:` field emitted.

- [ ] **Step 3: Implement Redis Stream write in `lib/sse.js`**

Replace the full content of `lib/sse.js`:

```js
import { getRedis, STREAM_TTL_SECONDS } from './redis.js';

/**
 * Stream SSE events from an async generator.
 *
 * Options:
 * - heartbeatIntervalMs: send heartbeat comments at this interval (0 = disabled)
 * - onAbort: callback when client disconnects
 * - streamKey: if provided, each event is also written to this Redis Stream key
 *              via XADD, and the Redis Stream ID is emitted as the SSE `id:` field.
 */
export function streamSSE(generator, { heartbeatIntervalMs = 0, onAbort, streamKey } = {}) {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let abortCallback = null;
  let cleanupDone = false;

  if (onAbort) {
    abortCallback = async () => {
      if (cleanupDone) return;
      cleanupDone = true;
      try {
        await onAbort();
      } catch {}
    };
  }

  const stream = new ReadableStream({
    async start(controller) {
      let heartbeatTimer;
      if (heartbeatIntervalMs > 0) {
        heartbeatTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          } catch {
            abortController.abort();
          }
        }, heartbeatIntervalMs);
      }

      let ttlSet = false;
      const redis = streamKey ? getRedis() : null;

      try {
        for await (const event of generator) {
          if (abortController.signal.aborted) break;

          // Write to Redis Stream (non-blocking, non-fatal)
          let eventId = null;
          if (redis && streamKey) {
            try {
              eventId = await redis.xadd(
                streamKey, '*',
                'event', event.event,
                'data', JSON.stringify(event.data),
              );
              if (!ttlSet) {
                await redis.expire(streamKey, STREAM_TTL_SECONDS);
                ttlSet = true;
              }
            } catch (err) {
              console.warn('[sse] Redis XADD failed, continuing without persistence:', err.message);
            }
          }

          // Build SSE frame
          let sseData = '';
          if (eventId) {
            sseData += `id: ${eventId}\n`;
          }
          sseData += `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

          try {
            controller.enqueue(encoder.encode(sseData));
          } catch {
            abortController.abort();
            break;
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          try {
            const errorEvent = `event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`;
            controller.enqueue(encoder.encode(errorEvent));
          } catch {}
        }
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      abortController.abort();
      if (abortCallback) {
        abortCallback();
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

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/redis-sse.test.js
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/sse.js tests/unit/redis-sse.test.js
git commit -m "feat: dual-write SSE events to Redis Stream with id field"
```

---

### Task 3: Pass `streamKey` to All SSE Endpoints

**Files:**
- Modify: `app/api/campaign/orchestrate/[id]/route.js`
- Modify: `app/api/campaign/orchestrate/[id]/feedback/route.js`
- Modify: `app/api/campaign/orchestrate/[id]/approve/route.js`

- [ ] **Step 1: Update main orchestrate route**

In `app/api/campaign/orchestrate/[id]/route.js`, add import and pass `streamKey` to all three `streamSSE()` calls:

```js
// Add at top, after existing imports:
import { streamKey } from '../../../../../lib/redis.js';
```

Update the three `streamSSE()` calls to pass `streamKey`:

```js
// Line ~79 (intake chat):
return streamSSE(
  processIntakeMessage(brief.id, body.message, { attachments: body.attachments }),
  { heartbeatIntervalMs: 5000, streamKey: streamKey(brief.id) },
);

// Line ~85 (orchestrator chat):
return streamSSE(
  chatWithOrchestrator(session.id, body.message, { attachments: body.attachments }),
  { heartbeatIntervalMs: 5000, streamKey: streamKey(brief.id) },
);

// Line ~93 (pipeline):
return streamSSE(orchestrate(sessionId, { phases: body.phases }), {
  heartbeatIntervalMs: 5000,
  streamKey: streamKey(brief.id),
  onAbort: async () => {
    await updateSessionIfStatus(sessionId, 'running', { status: 'interrupted' });
  },
});
```

- [ ] **Step 2: Update feedback route**

In `app/api/campaign/orchestrate/[id]/feedback/route.js`:

```js
// Add import:
import { streamKey } from '../../../../../../lib/redis.js';
import { getBrief } from '../../../../../../lib/repositories/campaign-brief.repository.js';
```

After the session resolution block (after line 43), get the brief for the streamKey:

```js
const brief = await getBrief(session.brief_id);

const sessionId = session.id;
return streamSSE(resumeAfterFeedback(sessionId, responseText, { attachments: body.attachments }), {
  heartbeatIntervalMs: 5000,
  streamKey: brief ? streamKey(brief.id) : undefined,
  onAbort: async () => {
    await updateSessionIfStatus(sessionId, 'running', { status: 'interrupted' });
  },
});
```

- [ ] **Step 3: Update approve route**

In `app/api/campaign/orchestrate/[id]/approve/route.js`:

```js
// Add import:
import { streamKey } from '../../../../../../lib/redis.js';
import { getBrief } from '../../../../../../lib/repositories/campaign-brief.repository.js';
```

After session resolution, add brief lookup:

```js
const brief = await getBrief(session.brief_id);

return streamSSE(resumeAfterFeedback(session.id, '确认执行投放方案'), {
  heartbeatIntervalMs: 5000,
  streamKey: brief ? streamKey(brief.id) : undefined,
});
```

- [ ] **Step 4: Commit**

```bash
git add app/api/campaign/orchestrate/
git commit -m "feat: pass Redis stream key to all SSE endpoints"
```

---

### Task 4: Create GET Reconnect Endpoint

**Files:**
- Create: `app/api/campaign/orchestrate/[id]/stream/route.js`
- Create: `tests/unit/sse-reconnect-endpoint.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/sse-reconnect-endpoint.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Redis
const mockXrange = vi.fn();
const mockXread = vi.fn();
const mockDisconnect = vi.fn();
const mockBlockingClient = { xread: mockXread, disconnect: mockDisconnect };

vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({ xrange: mockXrange }),
  createBlockingClient: () => mockBlockingClient,
  streamKey: (id) => `sse:${id}`,
  STREAM_TTL_SECONDS: 14400,
}));

// Mock Supabase auth
vi.mock('../../lib/supabase-server.js', () => ({
  createClient: () => ({
    auth: { getUser: () => ({ data: { user: { id: 'user-1' } } }) },
  }),
}));

// Mock repository
const mockGetSession = vi.fn();
const mockGetLatestSession = vi.fn();
vi.mock('../../lib/repositories/orchestrator.repository.js', () => ({
  getSession: (...args) => mockGetSession(...args),
  getLatestSession: (...args) => mockGetLatestSession(...args),
}));

vi.mock('../../lib/repositories/campaign-brief.repository.js', () => ({
  getBrief: () => ({ id: 'brief-1', brief_id: 'brief-1' }),
}));

const { GET } = await import(
  '../../app/api/campaign/orchestrate/[id]/stream/route.js'
);

describe('GET /api/campaign/orchestrate/[id]/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      id: 'sess-1',
      brief_id: 'brief-1',
      status: 'running',
    });
  });

  it('should return 400 if lastEventId is missing', async () => {
    const req = new Request('http://localhost/api/campaign/orchestrate/sess-1/stream');
    const res = await GET(req, { params: Promise.resolve({ id: 'sess-1' }) });
    expect(res.status).toBe(400);
  });

  it('should return 400 if lastEventId format is invalid', async () => {
    const req = new Request('http://localhost/api/campaign/orchestrate/sess-1/stream?lastEventId=bad-id');
    const res = await GET(req, { params: Promise.resolve({ id: 'sess-1' }) });
    expect(res.status).toBe(400);
  });

  it('should return SSE response with correct headers for valid request', async () => {
    mockXrange.mockResolvedValue([
      ['1234-0', ['event', 'delta', 'data', '{"text":"hi"}']],
    ]);
    // XREAD returns null (no new events, session completed check will stop)
    mockXread.mockResolvedValue(null);
    mockGetSession.mockResolvedValue({
      id: 'sess-1',
      brief_id: 'brief-1',
      status: 'completed',
    });

    const req = new Request(
      'http://localhost/api/campaign/orchestrate/sess-1/stream?lastEventId=1233-0'
    );
    const res = await GET(req, { params: Promise.resolve({ id: 'sess-1' }) });

    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('should replay events from XRANGE after lastEventId', async () => {
    mockXrange.mockResolvedValue([
      ['1234-0', ['event', 'delta', 'data', '{"text":"missed1"}']],
      ['1235-0', ['event', 'done', 'data', '{}']],
    ]);
    mockGetSession.mockResolvedValue({
      id: 'sess-1',
      brief_id: 'brief-1',
      status: 'completed',
    });

    const req = new Request(
      'http://localhost/api/campaign/orchestrate/sess-1/stream?lastEventId=1233-0'
    );
    const res = await GET(req, { params: Promise.resolve({ id: 'sess-1' }) });
    const text = await res.text();

    expect(text).toContain('id: 1234-0');
    expect(text).toContain('event: delta');
    expect(text).toContain('data: {"text":"missed1"}');
    expect(text).toContain('id: 1235-0');
    expect(text).toContain('event: done');
  });

  it('should send synthetic done if session already completed and no replay events', async () => {
    mockXrange.mockResolvedValue([]);
    mockGetSession.mockResolvedValue({
      id: 'sess-1',
      brief_id: 'brief-1',
      status: 'completed',
    });

    const req = new Request(
      'http://localhost/api/campaign/orchestrate/sess-1/stream?lastEventId=9999-0'
    );
    const res = await GET(req, { params: Promise.resolve({ id: 'sess-1' }) });
    const text = await res.text();

    expect(text).toContain('event: done');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/sse-reconnect-endpoint.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reconnect endpoint**

Create `app/api/campaign/orchestrate/[id]/stream/route.js`:

```js
import { createClient } from '../../../../../../lib/supabase-server.js';
import {
  getSession,
  getLatestSession,
} from '../../../../../../lib/repositories/orchestrator.repository.js';
import { getBrief } from '../../../../../../lib/repositories/campaign-brief.repository.js';
import { getRedis, createBlockingClient, streamKey } from '../../../../../../lib/redis.js';

const VALID_STREAM_ID = /^\d+-\d+$/;
const TERMINAL_STATUSES = new Set(['completed', 'failed']);
const XREAD_BLOCK_MS = 30_000; // 30s block timeout, then re-check session status

/**
 * GET /api/campaign/orchestrate/[id]/stream?lastEventId=xxx
 *
 * Reconnection endpoint: replays missed SSE events from Redis Stream,
 * then switches to real-time XREAD BLOCK until session completes.
 */
export async function GET(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const lastEventId = searchParams.get('lastEventId');

  if (!lastEventId || !VALID_STREAM_ID.test(lastEventId)) {
    return Response.json(
      { error: 'Missing or invalid lastEventId query parameter (expected format: digits-digits)' },
      { status: 400 },
    );
  }

  // Resolve session
  let session = await getSession(id);
  if (!session) {
    session = await getLatestSession(id);
  }
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const brief = await getBrief(session.brief_id);
  const key = streamKey(brief?.id || session.brief_id);

  const encoder = new TextEncoder();
  let blockingClient = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (eventId, eventType, data) => {
        let frame = '';
        if (eventId) frame += `id: ${eventId}\n`;
        frame += `event: ${eventType}\ndata: ${data}\n\n`;
        controller.enqueue(encoder.encode(frame));
      };

      try {
        const redis = getRedis();

        // Phase 1: Replay missed events via XRANGE (exclusive of lastEventId)
        // XRANGE is inclusive, so we use lastEventId as start — Redis will include it.
        // We skip the first entry if its ID matches lastEventId (client already has it).
        const replayEvents = await redis.xrange(key, lastEventId, '+');
        let lastId = lastEventId;

        for (const [eventId, fields] of replayEvents) {
          if (eventId === lastEventId) continue; // skip the already-received event
          const eventType = fields[fields.indexOf('event') + 1];
          const eventData = fields[fields.indexOf('data') + 1];
          send(eventId, eventType, eventData);
          lastId = eventId;

          // If replay contains terminal event, we're done
          if (eventType === 'done' || eventType === 'error') {
            controller.close();
            return;
          }
        }

        // Check if session already finished (no need to block)
        const freshSession = await getSession(session.id);
        if (TERMINAL_STATUSES.has(freshSession?.status)) {
          // Check if we already sent a 'done' event in replay
          const lastReplay = replayEvents[replayEvents.length - 1];
          const lastReplayEvent = lastReplay
            ? lastReplay[1][lastReplay[1].indexOf('event') + 1]
            : null;
          if (lastReplayEvent !== 'done' && lastReplayEvent !== 'error') {
            send(null, 'done', JSON.stringify({ status: freshSession.status }));
          }
          controller.close();
          return;
        }

        // Phase 2: Real-time via XREAD BLOCK
        blockingClient = createBlockingClient();
        await blockingClient.connect?.(); // ioredis auto-connects, but be safe

        while (true) {
          const result = await blockingClient.xread(
            'BLOCK', XREAD_BLOCK_MS,
            'STREAMS', key, lastId,
          );

          if (!result) {
            // Timeout — check if session is still running
            const currentSession = await getSession(session.id);
            if (!currentSession || TERMINAL_STATUSES.has(currentSession.status)) {
              send(null, 'done', JSON.stringify({ status: currentSession?.status || 'unknown' }));
              break;
            }
            // Still running, send heartbeat and continue blocking
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
            continue;
          }

          // result is [[key, [[id, fields], ...]]]
          const entries = result[0][1];
          for (const [eventId, fields] of entries) {
            const eventType = fields[fields.indexOf('event') + 1];
            const eventData = fields[fields.indexOf('data') + 1];
            send(eventId, eventType, eventData);
            lastId = eventId;

            if (eventType === 'done' || eventType === 'error') {
              controller.close();
              blockingClient.disconnect();
              blockingClient = null;
              return;
            }
          }
        }
      } catch (err) {
        try {
          send(null, 'error', JSON.stringify({ message: err.message }));
        } catch {}
      } finally {
        if (blockingClient) {
          blockingClient.disconnect();
          blockingClient = null;
        }
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      if (blockingClient) {
        blockingClient.disconnect();
        blockingClient = null;
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

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/unit/sse-reconnect-endpoint.test.js
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/campaign/orchestrate/\[id\]/stream/
git add tests/unit/sse-reconnect-endpoint.test.js
git commit -m "feat: add GET /stream reconnect endpoint with XRANGE + XREAD BLOCK"
```

---

### Task 5: Update Frontend — Replace Polling with Silent Reconnect

**Files:**
- Modify: `app/dashboard/campaign-studio/components/ChatArea.js`

- [ ] **Step 1: Update `consumeSSE` to track last event ID**

Replace the `consumeSSE` function (lines 14-45) with:

```js
/**
 * Parse SSE stream and call handler for each event.
 * Tracks the last event ID for reconnection.
 * Returns the last event ID seen (or null if none).
 */
async function consumeSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = null;
  let eventId = null;
  let lastEventId = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('id: ')) {
          eventId = line.slice(4);
        } else if (line.startsWith('event: ')) {
          eventType = line.slice(7);
        } else if (line.startsWith('data: ') && eventType) {
          try {
            const data = JSON.parse(line.slice(6));
            if (eventId) lastEventId = eventId;
            onEvent(eventType, data);
          } catch { /* skip malformed */ }
          eventType = null;
          eventId = null;
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return lastEventId;
    throw err;
  }
  return lastEventId;
}
```

- [ ] **Step 2: Replace `startPolling`/`stopPolling` with `reconnectSSE`**

Remove the `startPolling` function (lines 135-198), `stopPolling` function (lines 200-205), `pollingRef`, and the `useEffect` cleanup for polling.

Add the reconnect function and a ref to track the last event ID:

```js
const lastEventIdRef = useRef(null);
const reconnectTimerRef = useRef(null);

function reconnectSSE(sid) {
  if (reconnectTimerRef.current) return; // already reconnecting
  const lastId = lastEventIdRef.current;
  if (!lastId) return; // no event ID to reconnect from

  console.log('[sse] reconnecting from', lastId);
  reconnectTimerRef.current = setTimeout(async () => {
    reconnectTimerRef.current = null;
    try {
      const res = await fetch(
        `/api/campaign/orchestrate/${sid}/stream?lastEventId=${lastId}`
      );
      if (!res.ok) {
        console.warn('[sse] reconnect failed:', res.status);
        setIsLoading(false);
        return;
      }

      const newLastId = await consumeSSE(res, (event, data) => {
        // Reuse existing event handlers from runOrchestration
        handleStreamEvent(event, data);
      });
      if (newLastId) lastEventIdRef.current = newLastId;
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.warn('[sse] reconnect error:', err.message);
        // Retry once more after 2s
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          reconnectSSE(sid);
        }, 2000);
      }
    }
  }, 500); // 500ms delay before reconnect to avoid thundering herd
}

function stopReconnect() {
  if (reconnectTimerRef.current) {
    clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }
}
```

- [ ] **Step 3: Update all SSE consumers to use `lastEventIdRef` and `reconnectSSE`**

In `sendChatMessage`, update the `consumeSSE` call to capture lastEventId:

```js
const lastId = await consumeSSE(res, (event, data) => { ... });
if (lastId) lastEventIdRef.current = lastId;
```

In `runOrchestration`, replace the polling fallback (lines 681-690) with reconnect:

```js
// After consumeSSE completes:
if (lastId) lastEventIdRef.current = lastId;

// SSE ended without a terminal event — reconnect via Redis Stream
if (!receivedDone && (sessionId || briefId)) {
  console.log('[sse] stream ended without done/error — reconnecting');
  reconnectSSE(sessionId || briefId);
}
```

Apply the same pattern in `handleApprove` and `handleFeedbackRespond` — replace `startPolling(...)` with `reconnectSSE(...)`.

- [ ] **Step 4: Update useEffect cleanup**

```js
useEffect(() => {
  return () => stopReconnect();
}, [sessionId, briefId]);
```

- [ ] **Step 5: Commit**

```bash
git add app/dashboard/campaign-studio/components/ChatArea.js
git commit -m "feat: replace polling fallback with silent Redis Stream reconnection"
```

---

### Task 6: Integration Smoke Test

**Files:**
- Create: `tests/integration/redis-stream-reconnect.test.js`

- [ ] **Step 1: Write integration test that validates full write→read flow**

```js
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Skip if Redis is not available
let redis;
let available = false;

beforeAll(async () => {
  try {
    redis = new Redis(REDIS_URL, { connectTimeout: 2000 });
    await redis.ping();
    available = true;
  } catch {
    console.warn('Redis not available — skipping integration tests');
  }
});

afterAll(async () => {
  if (redis) await redis.quit();
});

describe.runIf(() => available)('Redis Stream SSE integration', () => {
  const testKey = `sse:test-${Date.now()}`;

  afterAll(async () => {
    if (redis) await redis.del(testKey);
  });

  it('should write events with XADD and read them back with XRANGE', async () => {
    // Simulate backend writing events
    const id1 = await redis.xadd(testKey, '*', 'event', 'delta', 'data', '{"text":"hello"}');
    const id2 = await redis.xadd(testKey, '*', 'event', 'done', 'data', '{}');

    // Simulate reconnect: read all events after "0-0"
    const events = await redis.xrange(testKey, '0-0', '+');

    expect(events).toHaveLength(2);
    expect(events[0][0]).toBe(id1);
    expect(events[0][1]).toEqual(['event', 'delta', 'data', '{"text":"hello"}']);
    expect(events[1][0]).toBe(id2);
    expect(events[1][1]).toEqual(['event', 'done', 'data', '{}']);
  });

  it('should support exclusive range read (skip already-seen event)', async () => {
    const events = await redis.xrange(testKey, '0-0', '+');
    const firstId = events[0][0];

    // Read from firstId (inclusive) and skip it
    const replay = await redis.xrange(testKey, firstId, '+');
    const filtered = replay.filter(([id]) => id !== firstId);

    expect(filtered).toHaveLength(1);
    expect(filtered[0][1]).toEqual(['event', 'done', 'data', '{}']);
  });

  it('should support XREAD BLOCK with timeout returning null', async () => {
    // Read with a very short block timeout — no new events expected
    const result = await redis.xread('BLOCK', 100, 'STREAMS', testKey, '$');
    expect(result).toBeNull();
  });

  it('should EXPIRE key and have it TTL properly', async () => {
    await redis.expire(testKey, 10);
    const ttl = await redis.ttl(testKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run integration test (requires local Redis)**

```bash
REDIS_URL=redis://127.0.0.1:6379 npx vitest run tests/integration/redis-stream-reconnect.test.js
```

Expected: All tests PASS if Redis is running, gracefully skipped otherwise.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/redis-stream-reconnect.test.js
git commit -m "test: add Redis Stream SSE integration smoke test"
```

---

### Task 7: Deploy — Install Redis on aws-foggy

**Files:** None (infrastructure)

- [ ] **Step 1: SSH and install Redis**

```bash
ssh aws-foggy
sudo apt-get update && sudo apt-get install -y redis-server
```

- [ ] **Step 2: Configure Redis for local-only access**

```bash
sudo sed -i 's/^bind .*/bind 127.0.0.1/' /etc/redis/redis.conf
sudo sed -i 's/^# maxmemory .*/maxmemory 256mb/' /etc/redis/redis.conf
sudo sed -i 's/^# maxmemory-policy .*/maxmemory-policy allkeys-lru/' /etc/redis/redis.conf
sudo systemctl restart redis-server
sudo systemctl enable redis-server
```

- [ ] **Step 3: Verify Redis is running**

```bash
redis-cli ping
# Expected: PONG
redis-cli info server | head -5
```

- [ ] **Step 4: Add `REDIS_URL` to production `.env`**

```bash
echo 'REDIS_URL=redis://127.0.0.1:6379' >> .env.local
```

- [ ] **Step 5: Deploy application**

```bash
npm run deploy
```
