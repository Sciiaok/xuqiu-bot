/**
 * Intercept Supabase PostgREST + GoTrue calls so the app can render
 * without a real database.
 *
 * Uses `**` glob patterns so it works regardless of which Supabase URL
 * is baked into the Next.js client bundle (prod, dev, or test).
 *
 * @param {import('@playwright/test').Page} page
 * @param {Object} opts
 * @param {Array}  opts.conversations - conversation rows (with nested contact)
 * @param {Array}  opts.messages      - message rows
 * @param {Array}  opts.leads         - lead rows
 * @param {boolean} opts.takeoverStatus - is_human_takeover for the first conversation
 */
export async function mockSupabase(page, opts = {}) {
  // ---- Auth (GoTrue) — always return a fake session ----
  await page.route('**/auth/v1/**', (route) =>
    route.fulfill({ json: { id: 'user-1', email: 'test@test.com' } })
  );

  // ---- Conversations ----
  await page.route('**/rest/v1/conversations*', (route) => {
    const url = route.request().url();

    // Takeover-status check: select=is_human_takeover (uses .single())
    if (url.includes('is_human_takeover')) {
      return route.fulfill({
        json: { is_human_takeover: opts.takeoverStatus ?? false },
        headers: {
          'content-type': 'application/vnd.pgrst.object+json',
          'content-profile': 'public',
        },
      });
    }

    // Conversation IDs for a contact: select=id&contact_id=eq.xxx
    // Note: must check for 'contact_id=eq.' (filter param), NOT just 'contact_id',
    // because the full list query also has 'contact_id' in its select clause.
    if (url.includes('contact_id=eq.')) {
      const ids = (opts.conversations || []).map((c) => ({ id: c.id }));
      return route.fulfill({ json: ids });
    }

    // Full conversation list (with nested contact)
    return route.fulfill({ json: opts.conversations || [] });
  });

  // ---- Messages ----
  await page.route('**/rest/v1/messages*', (route) =>
    route.fulfill({ json: opts.messages || [] })
  );

  // ---- Leads ----
  await page.route('**/rest/v1/leads*', (route) =>
    route.fulfill({ json: opts.leads || [] })
  );

  // ---- Realtime WebSocket — just abort ----
  await page.route('**/realtime/**', (route) => route.abort());
}
