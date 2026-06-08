// Single source of truth for tier-1 prefetch keys + their fetchers.
// Both PostLoginPreloader and per-page usePrefetched hooks import from here
// so the keys can't drift.

export const KEYS = {
  PRODUCT_LINES_ALL:    'product-lines:all',
  PRODUCT_LINES_ACTIVE: 'product-lines:active',
  PRODUCT_LINES_STATS:  'product-lines:stats',
  INQUIRIES_DEFAULT:    'inquiries:limit=20',
  OGILVY_WA_ACCOUNTS:   'ogilvy:wa-accounts',
  OGILVY_CONVERSATIONS: 'ogilvy:conversations',
  META_CONNECTION:      'meta:connection',
  NOTIFICATIONS:        'settings:notifications',
  REQUIREMENT_BOT_SETTINGS: 'settings:requirement-bot',
  ADS_DASHBOARD_30D:    'ads:dashboard:30d',
};

// Per-product-line keys are computed (line id is dynamic).
export const lineKeys = {
  detail:    (id) => `product-line:${id}`,
  kbHealth:  (productLineId) => `kb:health:${productLineId}`,
  kbDocs:    (productLineId) => `kb:docs:${productLineId}`,
  kbQa:      (productLineId) => `kb:qa:${productLineId}`,
  kbAssets:  (productLineId) => `kb:assets:${productLineId}`,
};

async function jsonOk(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export const FETCHERS = {
  [KEYS.PRODUCT_LINES_ALL]:    () => fetch('/api/product-lines').then(jsonOk).then(d => d.lines || []),
  [KEYS.PRODUCT_LINES_ACTIVE]: () => fetch('/api/product-lines?active=true').then(jsonOk).then(d => d.lines || []),
  [KEYS.PRODUCT_LINES_STATS]:  () => fetch('/api/product-lines/stats').then(jsonOk).then(d => d.stats || {}),
  [KEYS.INQUIRIES_DEFAULT]:    () => fetch('/api/inquiries?limit=20').then(jsonOk),
  [KEYS.OGILVY_WA_ACCOUNTS]:   () => fetch('/api/ogilvy/whatsapp-accounts').then(jsonOk),
  [KEYS.OGILVY_CONVERSATIONS]: () => fetch('/api/ogilvy/conversations').then(jsonOk),
  [KEYS.META_CONNECTION]:      () => fetch('/api/meta/connection').then(jsonOk),
  [KEYS.NOTIFICATIONS]:        () => fetch('/api/settings/notifications').then(jsonOk),
  [KEYS.REQUIREMENT_BOT_SETTINGS]: () => fetch('/api/settings/requirement-bot').then(jsonOk),
  // Default Campaign Studio view: 30d list. The Meta API aggregation behind
  // this is heavy (~15s), so preheating it makes the page feel instant.
  // No LLM call here — pure data aggregation.
  [KEYS.ADS_DASHBOARD_30D]:    () => fetch('/api/ads/dashboard?preset=30d').then(jsonOk),
};

export const TIER1_PRELOADS = Object.entries(FETCHERS).map(([key, fetcher]) => ({ key, fetcher }));

// Per-product-line fetchers. Used by PostLoginPreloader to fan out across
// every tenant's product lines after the tier-1 list is loaded.
export function buildLineDetailFetcher(id) {
  return () => fetch(`/api/product-lines/${id}`).then(jsonOk).then(d => d.line);
}

export function buildKbFetchers(productLineId) {
  const pl = encodeURIComponent(productLineId);
  return {
    [lineKeys.kbHealth(productLineId)]:
      () => fetch(`/api/knowledge/health?product_line_id=${pl}`).then(jsonOk),
    [lineKeys.kbDocs(productLineId)]:
      () => fetch(`/api/knowledge/documents?product_line_id=${pl}`).then(jsonOk).then(d => d.documents || []),
    [lineKeys.kbQa(productLineId)]:
      () => fetch(`/api/knowledge/qa-snippets?product_line_id=${pl}&include_inactive=true`).then(jsonOk).then(d => d.snippets || []),
    [lineKeys.kbAssets(productLineId)]:
      () => fetch(`/api/knowledge/assets?product_line_id=${pl}`).then(jsonOk).then(d => d.assets || []),
  };
}
