/**
 * WhatsApp Accounts Service — lists Click-to-WhatsApp-eligible phone numbers
 * for the current Meta ad account.
 *
 * Single-tenant for MVP: account comes from env via getMetaAccountForUser().
 * When we go multi-tenant, only that resolver changes — this module is stable.
 */
import { config } from '../config.js';
import { fetchAccountAssets } from '../meta-account.service.js';

/**
 * Multi-tenant pivot point. Today: env. Tomorrow: look up user_meta_accounts.
 */
export async function getMetaAccountForUser(_userId) {
  if (!config.meta?.accessToken || !config.meta?.adAccountId) {
    return null;
  }
  return {
    access_token: config.meta.accessToken,
    ad_account_id: config.meta.adAccountId,
    page_id: config.meta.pageId,
  };
}

/**
 * E.164 normalization: strip "+" and whitespace/dashes. Meta's
 * promoted_object.whatsapp_phone_number wants digits only.
 *   "+86 185 8855 7892" → "8618588557892"
 */
export function normalizePhoneNumber(display) {
  if (!display) return null;
  return String(display).replace(/[^\d]/g, '') || null;
}

/**
 * A number is usable for Click-to-WhatsApp ads when it has a real verified
 * business name (i.e. not Meta's "Test Number" placeholder) and its quality
 * rating isn't RED (Meta blocks CTWA on red-rated numbers).
 */
function isUsable(phone) {
  if (!phone.verified_name) return false;
  if (phone.verified_name === 'Test Number') return false;
  if (phone.quality_rating === 'RED') return false;
  return true;
}

function normalize(phone) {
  return {
    phone_number_id: phone.phone_number_id,
    phone_normalized: normalizePhoneNumber(phone.display_phone_number),
    display_number: phone.display_phone_number,
    verified_name: phone.verified_name || null,
    quality_rating: phone.quality_rating || 'UNKNOWN',
    waba_id: phone.waba_id,
    waba_name: phone.waba_name,
  };
}

/**
 * Categorize the gate state so the frontend can render the right message.
 *
 * - ok                      : at least one usable number
 * - only_test_or_unverified : numbers exist but all are test / RED / missing name
 * - no_phone                : WABAs exist but no phone numbers attached
 * - no_waba                 : no WABAs owned by the business
 * - not_configured          : META_ACCESS_TOKEN / AD_ACCOUNT_ID missing in env
 * - token_error             : Meta returned an error while fetching assets
 */
function determineStatus(allNumbers, usableNumbers, assets) {
  if (!assets.available) return 'token_error';
  if (usableNumbers.length > 0) return 'ok';
  if (allNumbers.length > 0) return 'only_test_or_unverified';
  // 0 numbers — distinguish "no WABAs" vs "WABAs without phones".
  // fetchAccountAssets flattens phones from all WABAs, so we can't tell
  // those apart without re-fetching. Callers treat both the same anyway.
  return 'no_waba';
}

// ── Process-local cache ─────────────────────────────────────────────────
// WhatsApp numbers change rarely (minutes+), but fetchAccountAssets does
// 3-4 Graph API calls serially and takes 3-6s. Every autopilot message call
// used to pay that cost. We cache per-user (null key = single-tenant env)
// for a short TTL so follow-up messages in the same conversation are fast.
//
// Negative results (errors / not_configured) are cached briefly too to avoid
// hammering Meta when the token is broken.
const CACHE_TTL_MS = 60_000;        // 60s for OK results
const NEGATIVE_TTL_MS = 10_000;     // 10s for errors (so recovery is quick)
const cache = new Map();            // userId-or-'anon' → { expiresAt, value }

function cacheKey(userId) { return userId || 'anon'; }

function getCached(userId) {
  const entry = cache.get(cacheKey(userId));
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(cacheKey(userId));
    return null;
  }
  return entry.value;
}

function setCached(userId, value) {
  const ttl = value.status === 'ok' ? CACHE_TTL_MS : NEGATIVE_TTL_MS;
  cache.set(cacheKey(userId), { expiresAt: Date.now() + ttl, value });
}

/**
 * Main entry: list WhatsApp numbers available for this user to bind as
 * ad destinations, plus the gate status for rendering.
 *
 * Options:
 *   - force: skip the cache (used by UI "我已完成绑定，重新检查" button)
 */
export async function listWhatsAppAccountsForUser(userId, { force = false } = {}) {
  if (!force) {
    const cached = getCached(userId);
    if (cached) return cached;
  }

  const account = await getMetaAccountForUser(userId);
  if (!account) {
    const v = {
      status: 'not_configured',
      numbers: [],
      all_numbers: [],
      error: 'META_ACCESS_TOKEN or META_AD_ACCOUNT_ID is not configured',
    };
    setCached(userId, v);
    return v;
  }

  let assets;
  try {
    assets = await fetchAccountAssets();
  } catch (err) {
    const v = {
      status: 'token_error',
      numbers: [],
      all_numbers: [],
      error: err.message,
    };
    setCached(userId, v);
    return v;
  }

  const all = assets.whatsapp_phone_numbers || [];
  const usable = all.filter(isUsable).map(normalize);
  const allNormalized = all.map(normalize);

  const v = {
    status: determineStatus(all, usable, assets),
    numbers: usable,
    all_numbers: allNormalized,
  };
  setCached(userId, v);
  return v;
}

/**
 * Fire-and-forget prewarm. Called when a user creates a new conversation so
 * the first message doesn't wait 4-6s on Graph API. Safe to call repeatedly;
 * if the cache is warm this is a no-op.
 */
export function prewarmWhatsAppAccountsForUser(userId) {
  if (getCached(userId)) return;
  listWhatsAppAccountsForUser(userId).catch(err => {
    console.warn('[autopilot/whatsapp-accounts] prewarm failed:', err.message);
  });
}

/**
 * Lookup a specific number within the usable list — used by stage_campaigns
 * to validate the Agent-selected phone_number_id is real before calling Meta.
 */
export async function getWhatsAppNumberById(userId, phoneNumberId) {
  const { numbers } = await listWhatsAppAccountsForUser(userId);
  return numbers.find(n => n.phone_number_id === phoneNumberId) || null;
}
