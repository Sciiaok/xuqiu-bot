// Shared Meta Graph API fetch helpers. Routes under /api/ads/* used to each
// inline their own copy of these constants + fetchAllPages — consolidated here
// so a single proxy / timeout / pagination change doesn't fan out to 5 files.

import { ProxyAgent } from 'undici';
import { config } from './config.js';

export const META_API_VERSION = 'v21.0';
export const META_API_TIMEOUT_MS = config.meta.apiTimeoutMs;
export const META_PROXY_AGENT = config.proxy.httpsUrl
  ? new ProxyAgent(config.proxy.httpsUrl)
  : null;

// Page through Meta's `paging.next` cursor until exhausted, returning the
// flattened `data[]` array. Throws on non-2xx or `error` field.
export async function fetchAllPages(url) {
  const rows = [];
  let nextUrl = url;
  while (nextUrl) {
    const response = await fetch(nextUrl, {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(META_API_TIMEOUT_MS),
      dispatcher: META_PROXY_AGENT || undefined,
    });
    const data = await response.json();
    if (!response.ok || data?.error) {
      throw new Error(data?.error?.message || `Meta API request failed with status ${response.status}`);
    }
    rows.push(...(data.data || []));
    nextUrl = data.paging?.next || null;
  }
  return rows;
}
