// Minimal client-side cache for cross-page data prefetching.
// Module-level Map persists for the tab's lifetime; cleared on SIGNED_OUT.
// Only imported by 'use client' files — no SSR concerns.

const TTL_MS = 60_000;          // fresh window: synchronous hit, no network
const STALE_MS = 5 * 60_000;    // beyond this we discard entirely

const store = new Map();

export function readCache(key) {
  const entry = store.get(key);
  if (!entry || !('data' in entry)) return null;
  const age = Date.now() - entry.timestamp;
  if (age > STALE_MS) { store.delete(key); return null; }
  return { data: entry.data, fresh: age <= TTL_MS };
}

// Idempotent. Returns a promise resolving to the cached/fetched data.
// Failed fetches drop the entry so the next read attempts a fresh fetch.
export function prefetch(key, fetcher) {
  const existing = store.get(key);
  if (existing?.inFlight) return existing.inFlight;
  if (existing && 'data' in existing && Date.now() - existing.timestamp <= TTL_MS) {
    return Promise.resolve(existing.data);
  }
  const promise = Promise.resolve()
    .then(fetcher)
    .then((data) => {
      store.set(key, { data, timestamp: Date.now(), inFlight: null });
      return data;
    })
    .catch((err) => {
      store.delete(key);
      throw err;
    });
  store.set(key, { ...(existing || {}), inFlight: promise });
  return promise;
}

export function invalidate(key) { store.delete(key); }
export function invalidateAll() { store.clear(); }
