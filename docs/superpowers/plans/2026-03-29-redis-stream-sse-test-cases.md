Good -- the reconnection system hasn't been implemented yet. This is a greenfield test plan. Here is the comprehensive test design:

---

# Test Plan: Redis Stream-Based SSE Reconnection

## Conventions

- Framework: Vitest (`describe`, `it`, `expect`, `vi`)
- Location: `lib/__tests__/` for unit tests on lib modules; `app/api/campaign/orchestrate/[id]/stream/__tests__/` for the route
- Vitest config includes `**/__tests__/**/*.test.{js,jsx}` and `app/**/*.test.{js,jsx}`
- Mocks: `vi.mock()` at top level; `vi.fn()` for individual functions
- ES modules with `.js` extension

---

## 1. `lib/sse.js` — Enhanced SSE Writer (XADD + `id:` field)

File: `lib/__tests__/sse-redis-stream.test.js`

### 1.1 Happy Path

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 1 | emits SSE `id:` field from Redis Stream ID when streamKey is provided | unit | Each SSE event includes `id: <streamId>\n` in the wire format | Mock `redis.xadd` to return `"1711700000000-0"`. Pass `streamKey: "sse:brief-1"` to `streamSSE`. | Response body contains `id: 1711700000000-0\nevent: delta\ndata: ...` |
| 2 | calls XADD for every event emitted | unit | Every yielded event is persisted to the Redis Stream | Mock `redis.xadd`, provide a 3-event generator | `redis.xadd` called 3 times with correct `streamKey`, field/value pairs including `event` and `data` |
| 3 | sets EXPIRE on stream key on first XADD | unit | TTL is set once (not per-event) | Mock `redis.expire` | `redis.expire` called once with `"sse:brief-1"`, `14400` (4h) |
| 4 | works without streamKey (backwards compatibility) | unit | When no `streamKey` is given, no Redis calls are made and no `id:` field appears | No redis mock needed | Output has `event:` and `data:` but no `id:` line; `redis.xadd` never called |

### 1.2 Error Paths

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 5 | continues streaming when XADD fails | unit | Redis write failure does not kill the SSE stream; events still reach the client | `redis.xadd` rejects with `Error("READONLY")` | All events emitted to response body; error is logged but not propagated |
| 6 | continues streaming when Redis is null/undefined | unit | Graceful degradation when Redis client is unavailable | `getRedis()` returns `null` | Stream completes normally without `id:` fields |
| 7 | serializes event data as JSON string in XADD payload | unit | Data stored in Redis is JSON-stringified, not `[object Object]` | Mock XADD, yield event with nested object | XADD called with `JSON.stringify(event.data)` as the data field value |

### 1.3 Edge Cases

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 8 | handles generator that yields zero events | unit | Empty session produces no XADD calls and stream closes cleanly | Empty async generator + mock XADD | `xadd` never called, response stream closes without error |
| 9 | does not call EXPIRE again if stream key already has TTL | unit | Avoids resetting TTL on reconnections that re-use the same streamKey | Track expire calls across two `streamSSE` invocations | `expire` called only once total (or check via flag) |
| 10 | XADD payload preserves all event types including special characters | unit | Event types like `tool_call`, `phase_error` round-trip correctly | Yield events of each type | Each XADD call contains the exact event type string |

---

## 2. `lib/redis.js` — Redis Client Management

File: `lib/__tests__/redis-client.test.js`

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 11 | getRedis returns shared singleton client | unit | Multiple calls return the same connected client | Mock ioredis constructor | Same instance returned; constructor called once |
| 12 | getDedicatedRedis returns a NEW client each call | unit | XREAD BLOCK consumers get isolated connections | Mock ioredis constructor | Two calls produce two distinct instances |
| 13 | dedicated client disconnect cleans up without affecting shared client | unit | Closing a dedicated connection does not break the shared pool | Create shared + dedicated, disconnect dedicated | Shared client `.status` still `"ready"`; dedicated `.quit` called |
| 14 | getRedis returns null when REDIS_URL is not configured | unit | No-Redis environments degrade gracefully | `process.env.REDIS_URL` unset | Returns `null`, no connection attempt |
| 15 | getRedis returns null when Redis connection fails | unit | Connection error is caught | Mock constructor to throw | Returns `null`; error logged |

---

## 3. `app/api/campaign/orchestrate/[id]/stream/route.js` — Reconnect Endpoint

File: `app/api/campaign/orchestrate/[id]/stream/__tests__/route.test.js`

### 3.1 Happy Path — Replay from Redis

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 16 | replays missed events via XRANGE when valid lastEventId is provided | integration | Client receives all events after the given ID | Mock `redis.xrange("sse:brief-1", "(1711700000000-0", "+")` returning 3 events. Mock auth. | Response SSE body contains 3 events in order with correct `id:`, `event:`, `data:` fields |
| 17 | transitions from XRANGE replay to XREAD BLOCK for live events | integration | After replaying history, endpoint blocks for new events | Mock XRANGE returning 2 events, then XREAD returning 1 new event, then session completes | Response contains replay events followed by live event; XREAD called with last replayed ID (not `$`) |
| 18 | uses dedicated Redis connection for XREAD BLOCK | integration | XREAD does not block the shared Redis connection | Spy on `getDedicatedRedis` | `getDedicatedRedis` called; shared client not used for XREAD |
| 19 | streams complete when `done` event is encountered | integration | Stream closes after replaying a `done` event from Redis | XRANGE returns events ending with `{event: "done"}` | Response stream closes; no XREAD attempted |
| 20 | streams complete when `error` event is encountered | integration | Stream closes after replaying an `error` event from Redis | XRANGE returns events ending with `{event: "error"}` | Response stream closes cleanly |

### 3.2 Fallback to Supabase

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 21 | falls back to Supabase GET when Redis is unavailable | integration | Client still gets session state when Redis is down | `getRedis` returns `null`. Mock supabase query returning session with `status: "completed"`, `phase_results`. | Response is JSON (not SSE) with session snapshot |
| 22 | falls back to Supabase GET when XRANGE throws | integration | Redis operational errors trigger fallback | `redis.xrange` rejects with connection error | Supabase called; response contains session data |
| 23 | Supabase fallback includes phase_results and status | unit | Fallback response contains all data needed to reconstruct UI | Mock supabase returning full session object | Response JSON has `status`, `phase_results`, `current_phase` |

### 3.3 Session State Edge Cases

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 24 | returns completed session snapshot when session already done | integration | Reconnecting to a finished session does not hang | Session `status: "completed"` in DB; Redis stream has `done` event | Response contains final state; stream closes immediately |
| 25 | returns error when session not found | unit | Invalid session ID is rejected | DB returns null for session lookup | HTTP 404 response |
| 26 | returns 401 when user is not authenticated | unit | Auth check works on the GET endpoint | `supabase.auth.getUser` returns no user | HTTP 401 response |
| 27 | returns 400 when lastEventId has invalid format | unit | Malformed IDs are rejected rather than crashing Redis | `lastEventId=not-a-redis-id` | HTTP 400 with descriptive error; no Redis call made |
| 28 | handles lastEventId=0 (replay entire stream) | integration | Client can request full replay | XRANGE from `"0"` returns all events | All stored events replayed |

### 3.4 Stream Expiry

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 29 | falls back to Supabase when stream key does not exist (TTL expired) | integration | 4h expiry scenario handled gracefully | `redis.exists("sse:brief-1")` returns 0 or XRANGE returns empty | Falls back to Supabase session snapshot |
| 30 | falls back to Supabase when XRANGE returns empty for a valid lastEventId beyond stream range | integration | ID references an event that was already trimmed | XRANGE returns `[]` | Supabase fallback triggered |

### 3.5 Race Condition: XRANGE to XREAD Transition

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 31 | XREAD starts from last replayed event ID, not `$` | integration | No events lost between XRANGE and XREAD | XRANGE returns events ending at ID `"1711700000005-0"`. XREAD mock verifies start ID. | XREAD called with `"1711700000005-0"` as start ID |
| 32 | no duplicate events when event arrives during XRANGE-to-XREAD gap | integration | Events written between XRANGE completion and XREAD start are caught | XRANGE returns IDs 1-5. XREAD from ID 5 returns IDs 6-7 (no overlap). | Handler receives exactly IDs 1-7, no duplicates |
| 33 | handles XRANGE returning zero events (all events arrived before lastEventId) | integration | Edge case where client is already up-to-date | XRANGE returns `[]` | XREAD starts from the provided `lastEventId` |

### 3.6 Client Disconnect During XREAD

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 34 | cleans up dedicated Redis connection when client disconnects during XREAD BLOCK | integration | No connection leak | Simulate request abort (AbortSignal) while XREAD is blocking | `dedicatedClient.disconnect()` called; no unhandled promise rejection |
| 35 | cleans up dedicated Redis connection when request times out | integration | Long-idle connections are released | XREAD blocks indefinitely, then request is aborted | Dedicated client cleaned up |

### 3.7 Multiple Tabs / Concurrent Readers

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 36 | two concurrent readers on same stream key get independent XREAD connections | integration | No cross-tab interference | Two GET requests with same `briefId`, different `lastEventId` | `getDedicatedRedis` called twice; each gets its own client |
| 37 | XADD from active session does not interfere with XREAD readers | integration | Write and read paths are independent | One writer doing XADD, one reader doing XREAD on same key | Reader receives the newly added event |

---

## 4. `lib/consume-sse.js` — Enhanced Client-Side Parser

File: `lib/__tests__/consume-sse-reconnect.test.js`

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 38 | parses `id:` field and tracks last event ID | unit | Client-side parser extracts SSE `id:` for reconnection | Fake response with `id: 123-0\nevent: delta\ndata: {...}\n\n` | `onEvent` receives event; returned/tracked `lastEventId` equals `"123-0"` |
| 39 | returns last event ID after stream ends | unit | Caller can use the ID for reconnection | Stream with 3 events, last ID is `"999-0"` | Return value or callback provides `"999-0"` |
| 40 | handles events without `id:` field (backwards compat) | unit | Old-style events without `id:` do not break parsing | Mix of events with and without `id:` lines | Events parsed correctly; `lastEventId` only updates when `id:` is present |
| 41 | handles `id:` field with no value (reset per SSE spec) | unit | Empty `id:` line resets the ID | `id:\nevent: delta\ndata: {...}\n\n` | `lastEventId` reset to empty string |

---

## 5. `ChatArea.js` — Frontend Auto-Reconnect

File: `app/dashboard/campaign-studio/components/__tests__/ChatArea-reconnect.test.js`

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 42 | reconnects automatically when SSE stream drops | unit | Network interruption triggers reconnection | Mock `fetch` to fail once then succeed. Render ChatArea with active session. | Second `fetch` called to `/stream?lastEventId=...` |
| 43 | sends Last-Event-ID from last received event on reconnect | unit | Reconnect request includes the correct cursor | Track `fetch` calls after simulated disconnect | `fetch` called with `lastEventId` query param matching last received SSE `id:` |
| 44 | deduplicates events across reconnection boundary | unit | Events already rendered are not duplicated | First stream sends events A, B. Reconnect replays B, C. | Messages list contains A, B, C (no duplicate B) |
| 45 | does not show reconnection UI indicator (silent reconnect) | unit | No loading spinner or error banner during reconnect | Simulate disconnect + reconnect | No error message or loading indicator rendered during reconnection window |
| 46 | stops reconnecting after session is completed | unit | Reconnect loop does not run forever | Session status transitions to `"completed"` | No further `fetch` calls after `done` event |
| 47 | stops reconnecting after max retry attempts | unit | Prevents infinite retry on persistent failure | `fetch` always rejects | Reconnect attempts stop after defined limit (e.g., 5) |
| 48 | uses exponential backoff between retry attempts | unit | Retries are spaced with increasing delay | Mock `setTimeout` or `vi.useFakeTimers` | Delays increase: ~1s, ~2s, ~4s, ... |
| 49 | resets retry count on successful reconnection | unit | One failure cycle does not permanently reduce retry budget | Fail twice, succeed, fail twice again | Retry count restarted after the successful connection |
| 50 | handles Supabase fallback response (JSON instead of SSE) | unit | When server returns JSON snapshot instead of SSE, UI updates correctly | Mock fetch returning JSON with `{status, phase_results}` | Phase results rendered; no SSE parsing errors |

---

## 6. Integration Scenarios (End-to-End Flow)

File: `lib/__tests__/sse-reconnect-integration.test.js`

| # | Test Name | Category | Verifies | Setup / Mocks | Key Assertions |
|---|-----------|----------|----------|---------------|----------------|
| 51 | full flow: write events via streamSSE, reconnect via stream endpoint, receive replayed events | integration | The entire write-reconnect-replay cycle works | In-memory Redis mock (e.g., ioredis-mock). Writer yields 5 events. Reader connects with ID of event 3. | Reader receives events 4 and 5 only |
| 52 | full flow: writer completes while client is disconnected, client reconnects and gets all remaining events + done | integration | Offline client catches up fully | Writer yields 10 events + done while reader is "offline". Reader reconnects from event 5. | Reader gets events 6-10 + done; stream closes |
| 53 | full flow: Redis dies mid-session, subsequent reconnect falls back to Supabase | integration | Graceful degradation mid-session | Redis available for first 5 events, then connection error. Client reconnects. | Fallback to Supabase; client gets session snapshot |

---

## Summary Statistics

| Component | Happy Path | Error Path | Edge Case | Total |
|-----------|-----------|------------|-----------|-------|
| `lib/sse.js` (writer) | 4 | 3 | 3 | 10 |
| `lib/redis.js` (client) | 2 | 2 | 1 | 5 |
| `stream/route.js` (reconnect endpoint) | 5 | 3 | 14 | 22 |
| `lib/consume-sse.js` (parser) | 2 | 0 | 2 | 4 |
| `ChatArea.js` (frontend) | 3 | 2 | 4 | 9 |
| Integration (end-to-end) | 2 | 1 | 0 | 3 |
| **Total** | **18** | **11** | **24** | **53** |

## Implementation Priority

**P0 — Must have before merge (blocking correctness):**
- Tests 16, 17, 31, 32, 33 (XRANGE-to-XREAD transition correctness, the hardest bug to catch in production)
- Tests 34, 35 (connection leak prevention)
- Test 1, 2, 5 (XADD correctness and resilience)
- Tests 21, 22, 29 (Supabase fallback -- the safety net)
- Tests 42, 43, 44 (frontend reconnect + deduplication)

**P1 — Should have (robustness):**
- Tests 3, 6, 11, 12, 13 (Redis client management)
- Tests 24, 25, 26, 27 (session state edge cases)
- Tests 46, 47, 48, 49 (retry governance)
- Tests 38, 39 (client-side ID tracking)

**P2 — Nice to have (completeness):**
- Tests 36, 37 (multi-tab)
- Tests 51, 52, 53 (end-to-end integration with ioredis-mock)
- Tests 4, 8, 9, 10 (backwards compat, empty generators)

## Notes on Test Infrastructure

1. **Redis mocking**: Use `vi.mock()` to mock `lib/redis.js` exports. For integration tests (51-53), consider `ioredis-mock` to get realistic XADD/XRANGE/XREAD behavior without a live Redis.

2. **SSE response parsing in tests**: Reuse the `fakeResponse` helper from the existing `consume-sse.test.js`. For route tests, call the exported `GET` handler directly and read the response stream.

3. **AbortSignal simulation**: Use `new AbortController()` and call `.abort()` to simulate client disconnect in tests 34, 35, 42.

4. **Vitest config**: The existing config includes `**/__tests__/**/*.test.{js,jsx}` and `app/**/*.test.{js,jsx}`, so all proposed file locations will be picked up automatically. The `tests/` directory is excluded from Vitest (uses node:test runner instead), so all new tests go in `__tests__/` directories co-located with source.

5. **React component tests**: ChatArea tests need `jsdom` environment (already configured), plus mocks for `next-intl`, `fetch`, and the `consumeSSE` module.
