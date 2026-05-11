// Single source of truth for tier-1 prefetch keys + their fetchers.
// Both PostLoginPreloader and per-page usePrefetched hooks import from here
// so the keys can't drift.

export const KEYS = {
  PRODUCT_LINES_ALL:    'product-lines:all',
  PRODUCT_LINES_ACTIVE: 'product-lines:active',
  INQUIRIES_DEFAULT:    'inquiries:limit=20',
  OGILVY_WA_ACCOUNTS:   'ogilvy:wa-accounts',
  OGILVY_CONVERSATIONS: 'ogilvy:conversations',
  META_CONNECTION:      'meta:connection',
  NOTIFICATIONS:        'settings:notifications',
};

async function jsonOk(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const FETCHERS = {
  [KEYS.PRODUCT_LINES_ALL]:    () => fetch('/api/product-lines').then(jsonOk).then(d => d.lines || []),
  [KEYS.PRODUCT_LINES_ACTIVE]: () => fetch('/api/product-lines?active=true').then(jsonOk).then(d => d.lines || []),
  [KEYS.INQUIRIES_DEFAULT]:    () => fetch('/api/inquiries?limit=20').then(jsonOk),
  [KEYS.OGILVY_WA_ACCOUNTS]:   () => fetch('/api/ogilvy/whatsapp-accounts').then(jsonOk),
  [KEYS.OGILVY_CONVERSATIONS]: () => fetch('/api/ogilvy/conversations').then(jsonOk),
  [KEYS.META_CONNECTION]:      () => fetch('/api/meta/connection').then(jsonOk),
  [KEYS.NOTIFICATIONS]:        () => fetch('/api/settings/notifications').then(jsonOk),
};

export const TIER1_PRELOADS = Object.entries(FETCHERS).map(([key, fetcher]) => ({ key, fetcher }));
