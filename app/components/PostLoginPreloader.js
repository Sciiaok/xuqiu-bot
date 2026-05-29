'use client';

import { useEffect } from 'react';
import { prefetch, invalidateAll } from '../../lib/prefetch-store';
import {
  TIER1_PRELOADS,
  KEYS,
  lineKeys,
  buildLineDetailFetcher,
  buildKbFetchers,
} from '../../lib/prefetch-keys';
import { createClient } from '../../lib/supabase-browser';

// Warms tier-1 caches on entry to the authed shell (covers both fresh login
// and hard refresh). After the product-lines list resolves, fans out to
// each line's KB endpoints (health/gaps/docs/qa/assets) — the user told us
// to "just pull everything for the tenant" so the per-line detail pages
// open instantly.
//
// Subscribes to onAuthStateChange to drop the cache on SIGNED_OUT so stale
// data can't survive a relogin. Renders nothing.
export default function PostLoginPreloader() {
  useEffect(() => {
    // Tier-1 batch — independent endpoints, all fire in parallel.
    const tier1 = TIER1_PRELOADS.map(({ key, fetcher }) =>
      prefetch(key, fetcher).catch(() => null)
    );

    // After the product-lines list resolves, fan out to each line's detail
    // page + KB endpoints. Failures on a single line don't stop the others.
    const linesPromise = tier1[
      TIER1_PRELOADS.findIndex(p => p.key === KEYS.PRODUCT_LINES_ALL)
    ];
    linesPromise?.then((lines) => {
      if (!Array.isArray(lines)) return;
      for (const line of lines) {
        if (!line?.id) continue;
        prefetch(lineKeys.detail(line.id), buildLineDetailFetcher(line.id))
          .catch(() => {});
        const kb = buildKbFetchers(line.id);
        for (const [k, f] of Object.entries(kb)) {
          prefetch(k, f).catch(() => {});
        }
      }
    });

    const supabase = createClient();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') invalidateAll();
    });
    return () => sub?.subscription?.unsubscribe();
  }, []);
  return null;
}
