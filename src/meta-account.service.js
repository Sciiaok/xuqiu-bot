/**
 * Meta Account Asset Service
 *
 * Fetches and caches Meta ad account assets (pages, WhatsApp numbers, Instagram accounts, etc.)
 * so all orchestrator phases can access them as shared context.
 */
import { config } from './config.js';

const FETCH_TIMEOUT = 30_000;

/**
 * Fetch all relevant assets for the configured Meta ad account.
 * Returns a structured object that can be injected into any agent's context.
 */
export async function fetchAccountAssets() {
  const accountId = `act_${config.meta?.adAccountId}`;
  const token = config.meta?.accessToken;
  const pageId = config.meta?.pageId;
  const version = config.meta?.apiVersion || 'v21.0';

  if (!token || !config.meta?.adAccountId) {
    return { available: false, reason: 'META_ACCESS_TOKEN or META_AD_ACCOUNT_ID not configured' };
  }

  const assets = {
    available: true,
    account_id: accountId,
    page_id: pageId,
    whatsapp_phone_numbers: [],
    pages: [],
    instagram_accounts: [],
  };

  const results = await Promise.allSettled([
    fetchWhatsAppPhoneNumbers(accountId, token, version, pageId),
    fetchPages(accountId, token, version),
    fetchInstagramAccounts(accountId, token, version),
  ]);

  if (results[0].status === 'fulfilled') assets.whatsapp_phone_numbers = results[0].value;
  if (results[1].status === 'fulfilled') assets.pages = results[1].value;
  if (results[2].status === 'fulfilled') assets.instagram_accounts = results[2].value;

  return assets;
}

// ── WhatsApp Business phone numbers ─────────────────────────────────
// WABA lives under the Page's Business, not the Ad Account's Business.
// Path: System Token → Page → business.id → owned_whatsapp_business_accounts → phone_numbers

async function fetchWhatsAppPhoneNumbers(accountId, token, version, pageId) {
  // Step 1: Resolve the Page's owning Business ID
  const bizRes = await fetch(
    `https://graph.facebook.com/${version}/${pageId}?fields=business{id,name}&access_token=${token}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
  );
  const bizData = await bizRes.json();
  const businessId = bizData.business?.id;
  if (!businessId) return [];

  // Step 2: List WABAs owned by that Business
  const wabaRes = await fetch(
    `https://graph.facebook.com/${version}/${businessId}/owned_whatsapp_business_accounts?fields=id,name&access_token=${token}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
  );
  const wabaData = await wabaRes.json();
  if (wabaData.error) return [];

  // Step 3: For each WABA, fetch phone numbers
  const phoneNumbers = [];
  for (const waba of wabaData.data || []) {
    const phoneRes = await fetch(
      `https://graph.facebook.com/${version}/${waba.id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating&access_token=${token}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
    );
    const phoneData = await phoneRes.json();
    if (phoneData.error) continue;
    for (const phone of phoneData.data || []) {
      phoneNumbers.push({
        phone_number_id: phone.id,
        display_phone_number: phone.display_phone_number,
        verified_name: phone.verified_name,
        quality_rating: phone.quality_rating,
        waba_id: waba.id,
        waba_name: waba.name,
      });
    }
  }
  return phoneNumbers;
}

// ── Pages linked to ad account ──────────────────────────────────────

async function fetchPages(accountId, token, version) {
  const res = await fetch(
    `https://graph.facebook.com/${version}/${accountId}/promoted_objects?fields=page_id&access_token=${token}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
  );
  const data = await res.json();
  if (data.error) return [];
  return (data.data || []).map(p => ({ page_id: p.page_id }));
}

// ── Instagram accounts ──────────────────────────────────────────────

async function fetchInstagramAccounts(accountId, token, version) {
  const res = await fetch(
    `https://graph.facebook.com/${version}/${accountId}/instagram_accounts?fields=id,username,profile_pic&access_token=${token}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
  );
  const data = await res.json();
  if (data.error) return [];
  return (data.data || []).map(ig => ({
    instagram_account_id: ig.id,
    username: ig.username,
    profile_pic: ig.profile_pic,
  }));
}
