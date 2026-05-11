'use client';

import { useEffect, useRef, useState } from 'react';
import { readCache, prefetch } from './prefetch-store';

// usePrefetched(key, fetcher) — small wrapper over the prefetch store.
//   • Synchronous cache read on first render → instant paint when warm
//   • Stale-while-revalidate: shows stale data + refreshes in the background
//   • Errors fall through; on failure the cache entry is dropped so the next
//     hook caller will retry from cold
export function usePrefetched(key, fetcher) {
  const initial = key ? readCache(key) : null;
  const [data, setData] = useState(initial?.data ?? null);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState(null);

  // Keep fetcher in a ref so parent re-renders don't retrigger.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!key) return undefined;
    let cancelled = false;
    const cached = readCache(key);

    if (cached?.fresh) {
      setData(cached.data); setLoading(false); setError(null);
      return () => { cancelled = true; };
    }
    // Stale-but-present: paint stale data immediately, refresh in background.
    // Cold: enter loading.
    if (cached) { setData(cached.data); setLoading(false); }
    else        { setLoading(true); }

    prefetch(key, () => fetcherRef.current())
      .then((d)  => { if (!cancelled) { setData(d); setLoading(false); setError(null); } })
      .catch((e) => { if (!cancelled) { setError(e); setLoading(false); } });

    return () => { cancelled = true; };
  }, [key]);

  return { data, loading, error };
}
