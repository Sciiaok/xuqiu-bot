'use client';

import { useEffect } from 'react';
import { prefetch, invalidateAll } from '../../lib/prefetch-store';
import { TIER1_PRELOADS } from '../../lib/prefetch-keys';
import { createClient } from '../../lib/supabase-browser';

// Warms tier-1 caches on entry to the authed shell (covers both fresh login
// and hard refresh). Subscribes to onAuthStateChange to drop the cache on
// SIGNED_OUT so stale data can't survive a relogin. Renders nothing.
export default function PostLoginPreloader() {
  useEffect(() => {
    // Fire and forget — prefetch() drops failed entries on its own.
    for (const { key, fetcher } of TIER1_PRELOADS) {
      prefetch(key, fetcher).catch(() => {});
    }
    const supabase = createClient();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') invalidateAll();
    });
    return () => sub?.subscription?.unsubscribe();
  }, []);
  return null;
}
