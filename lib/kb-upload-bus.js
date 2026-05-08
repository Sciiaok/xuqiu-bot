/**
 * In-memory pub/sub for KB upload progress events.
 *
 * The upload route returns immediately after kicking off background processing,
 * then the worker emits stage events to this bus. The /api/knowledge/upload/stream
 * SSE endpoint subscribes to forward them to the browser.
 *
 * Buffering: events are retained per-docId so a subscriber that connects shortly
 * after the worker has already started doesn't miss the early events. After
 * `done`/`error` the buffer lingers for 5 min then is GC'd.
 *
 * Single-process only — fits the current PM2 fork-mode deployment. If the app
 * is ever scaled to multiple instances, swap this for the Redis Streams pattern
 * already in lib/sse.js.
 */

const buses = new Map();

const BUFFER_TTL_MS = 5 * 60_000;
const MAX_EVENTS_PER_DOC = 500;

function getOrCreate(docId) {
  let b = buses.get(docId);
  if (!b) {
    b = { events: [], wakers: new Set(), final: false, cleanupTimer: null };
    buses.set(docId, b);
  }
  return b;
}

export function emit(docId, event, data) {
  const b = getOrCreate(docId);
  if (b.final) return;
  if (b.events.length >= MAX_EVENTS_PER_DOC) return;
  b.events.push({ event, data });
  for (const wake of b.wakers) wake();
  if (event === 'done' || event === 'error') {
    b.final = true;
    b.cleanupTimer = setTimeout(() => buses.delete(docId), BUFFER_TTL_MS);
  }
}

/** True if a bus exists for this docId (worker has emitted ≥1 event). */
export function hasBus(docId) {
  return buses.has(docId);
}

/**
 * Async generator yielding `{event, data}` for a docId. Replays buffered
 * events, then waits for live ones, until a terminal event or signal abort.
 */
export async function* subscribe(docId, signal) {
  const b = getOrCreate(docId);
  let cursor = 0;
  let waker = null;
  const wake = () => { if (waker) { const w = waker; waker = null; w(); } };
  b.wakers.add(wake);
  const onAbort = () => wake();
  signal?.addEventListener?.('abort', onAbort);

  try {
    while (true) {
      while (cursor < b.events.length) {
        const evt = b.events[cursor++];
        yield evt;
        if (evt.event === 'done' || evt.event === 'error') return;
      }
      if (signal?.aborted) return;
      if (b.final) return;
      await new Promise((r) => { waker = r; });
    }
  } finally {
    b.wakers.delete(wake);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
