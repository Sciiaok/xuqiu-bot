/**
 * Meta Launch Service — stage + activate a Click-to-WhatsApp ad plan.
 *
 * This is the bridge between our abstract plan_json and Meta's Graph API.
 * Two-phase to allow clean rollback on failure:
 *
 *   stageCampaigns(plan)      — creates campaign/adset/ad in PAUSED state
 *   activateCampaigns(ids)    — flips each campaign to ACTIVE
 *
 * Phase 1 may leave orphaned PAUSED artifacts on Meta if it fails mid-way.
 * For MVP we surface the error to the user and let them clean up manually;
 * a proper rollback is TBD once we see real failure modes.
 *
 * All API calls use the account returned by getMetaAccountForUser — single
 * tenant today, multi-tenant pivot later without touching this file.
 */
import { config } from '../config.js';
import { getMetaAccountForUser } from './whatsapp-accounts.service.js';

const FETCH_TIMEOUT = 60_000;
const GRAPH_VERSION = config.meta.apiVersion || 'v21.0';

// ── Graph API helpers ──────────────────────────────────────────────────

function graphUrl(path) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
}

async function metaPost(path, body, token) {
  const res = await fetch(graphUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const data = await res.json();
  if (data.error) {
    const msg = data.error.error_user_msg || data.error.error_user_title || data.error.message;
    const err = new Error(`Meta API: ${msg}`);
    err.metaError = data.error;
    err.metaStatus = res.status;
    throw err;
  }
  return data;
}

async function metaUploadImage(imageUrl, { ad_account_id, access_token }) {
  // Graph can't ingest third-party URLs directly without special perms, so we
  // re-download + upload multipart. Works for any public image (incl. ours on
  // Supabase storage).
  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);
  const blob = await imgRes.blob();

  const formData = new FormData();
  const filename = imageUrl.split('/').pop()?.split('?')[0] || 'ad_image.png';
  formData.append('filename', blob, filename);
  formData.append('access_token', access_token);

  const res = await fetch(graphUrl(`act_${ad_account_id}/adimages`), {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Meta API: ${data.error.message}`);
  const first = Object.values(data.images || {})[0];
  if (!first?.hash) throw new Error('No image hash returned from Meta');
  return first.hash;
}

// ── Plan → Meta payload builders ───────────────────────────────────────

/**
 * Build the `page_welcome_message` JSON blob that Meta expects on CTWA ad
 * creatives. MVP: plain text only (no ice_breakers, no quick_replies).
 * This matches what Meta's own Ad Manager produces when you leave every
 * optional field blank.
 */
function buildPageWelcomeMessageJson(text) {
  return JSON.stringify({
    type: 'VISUAL_EDITOR',
    version: 2,
    landing_screen_type: 'welcome_message',
    media_type: 'text',
    text_format: {
      customer_action_type: 'none',
      message: { text: text || '' },
    },
  });
}

// ── stageCampaigns ─────────────────────────────────────────────────────

/**
 * Create all campaign / adset / creative / ad entities on Meta in PAUSED state.
 *
 * Yields progress events as it goes so the caller can stream them via SSE:
 *   { type: 'campaign_created' | 'adset_created' | 'creative_created' | 'ad_created' | 'error', ... }
 *
 * Returns a summary of created IDs (campaign_ids is what the /activate step
 * will flip to ACTIVE).
 */
export async function* stageCampaigns(plan, { userId }) {
  const account = await getMetaAccountForUser(userId);
  if (!account) throw new Error('Meta account not configured');
  const { access_token, ad_account_id, page_id } = account;
  if (!access_token || !ad_account_id || !page_id) {
    throw new Error('META_ACCESS_TOKEN / META_AD_ACCOUNT_ID / META_PAGE_ID required');
  }

  const whatsapp = plan.whatsapp || {};
  if (!whatsapp.phone_normalized) {
    throw new Error('plan.whatsapp.phone_normalized is required');
  }

  const out = {
    campaign_ids: [],
    adset_ids: [],
    creative_ids: [],
    ad_ids: [],
  };

  for (const campaign of plan.campaigns || []) {
    // 1. Campaign (CBO: daily_budget + bid_strategy live here, not on adset)
    const campaignPayload = {
      name: campaign.name,
      objective: 'OUTCOME_ENGAGEMENT',
      status: 'PAUSED',
      buying_type: 'AUCTION',
      special_ad_categories: [],
      daily_budget: campaign.daily_budget_cents,
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    };
    const { id: campaignId } = await metaPost(`act_${ad_account_id}/campaigns`, campaignPayload, access_token);
    out.campaign_ids.push(campaignId);
    yield { type: 'campaign_created', name: campaign.name, id: campaignId };

    for (const adSet of campaign.ad_sets || []) {
      // 2. AdSet — no daily_budget here (inherited from CBO campaign).
      // destination_type + promoted_object are what makes this a Click-to-WA ad.
      const adsetPayload = {
        name: adSet.name,
        campaign_id: campaignId,
        optimization_goal: 'CONVERSATIONS',
        billing_event: 'IMPRESSIONS',
        destination_type: 'WHATSAPP',
        promoted_object: {
          page_id,
          whatsapp_phone_number: whatsapp.phone_normalized,
        },
        targeting: {
          age_min: adSet.targeting?.age_min ?? 18,
          age_max: adSet.targeting?.age_max ?? 65,
          geo_locations: { countries: adSet.targeting?.countries || [] },
          // Meta requires advantage_audience explicitly since 2025. 0 = opt out,
          // keeping the targeting we specified exactly. Matches our reference
          // live ad (adset 120243642835730034).
          targeting_automation: { advantage_audience: 0 },
        },
        status: 'PAUSED',
      };
      const { id: adsetId } = await metaPost(`act_${ad_account_id}/adsets`, adsetPayload, access_token);
      out.adset_ids.push(adsetId);
      yield { type: 'adset_created', name: adSet.name, id: adsetId };

      for (const ad of adSet.ads || []) {
        const creative = ad.creative || {};
        if (!creative.image_url) {
          yield { type: 'error', ad: ad.name, error: '缺少 creative.image_url，跳过此广告' };
          continue;
        }

        // 3. Upload the image to get a hash.
        let imageHash;
        try {
          imageHash = await metaUploadImage(creative.image_url, account);
        } catch (err) {
          yield { type: 'error', ad: ad.name, error: `上传素材图失败: ${err.message}` };
          continue;
        }
        yield { type: 'image_uploaded', ad: ad.name, hash: imageHash };

        // 4. Ad creative — single-creative link_data path (not Dynamic Creative).
        // Meta rejects asset_feed_spec for messages objective unless combined
        // with optimization_type=PLACEMENT + asset_customization_rules. For
        // MVP (1 image + 1 headline + 1 body per ad) link_data is the right
        // shape.
        const creativePayload = {
          name: `${ad.name} creative`,
          object_story_spec: {
            page_id,
            link_data: {
              image_hash: imageHash,
              link: 'https://api.whatsapp.com/send',
              message: creative.primary_text || '',
              name: creative.headline || '',
              description: creative.description || '',
              call_to_action: {
                type: 'WHATSAPP_MESSAGE',
                value: {
                  app_destination: 'WHATSAPP',
                  link: 'https://api.whatsapp.com/send',
                },
              },
              // Ice-breaker / welcome message rendered inside WA after click.
              // For MVP we keep it as plain text (no ice_breakers / quick_replies).
              page_welcome_message: buildPageWelcomeMessageJson(ad.welcome_message),
            },
          },
        };
        const { id: creativeId } = await metaPost(`act_${ad_account_id}/adcreatives`, creativePayload, access_token);
        out.creative_ids.push(creativeId);
        yield { type: 'creative_created', ad: ad.name, id: creativeId };

        // 5. Ad pointing to this creative
        const adPayload = {
          name: ad.name,
          adset_id: adsetId,
          creative: { creative_id: creativeId },
          status: 'PAUSED',
        };
        const { id: adId } = await metaPost(`act_${ad_account_id}/ads`, adPayload, access_token);
        out.ad_ids.push(adId);
        yield { type: 'ad_created', ad: ad.name, id: adId };
      }
    }
  }

  return out;
}

// ── activateCampaigns ──────────────────────────────────────────────────

/**
 * Flip every level (campaign → adset → ad) from PAUSED to ACTIVE.
 *
 * Meta's hierarchy: an entity only serves if ALL its ancestors are ACTIVE.
 * Flipping just the campaign leaves adsets/ads at effective_status=PAUSED,
 * which is what showed up in Ads Manager as "广告组已关闭" — the campaign
 * was on but nothing below it was.
 *
 * Strategy: activate top-down in parallel within each level. Top-down order
 * is cosmetic — Meta computes effective_status from the hierarchy regardless
 * of which write lands first — but it avoids the weird transient state where
 * an ad is ACTIVE while its parent adset is still PAUSED.
 *
 * Returns an array of per-id results so partial failures are visible:
 *   [{ level: 'campaign', id, status: 'ACTIVE' }, { level: 'adset', id, error: '...' }]
 */
export async function* activateCampaigns({ campaign_ids = [], adset_ids = [], ad_ids = [] }, { userId }) {
  const account = await getMetaAccountForUser(userId);
  if (!account) throw new Error('Meta account not configured');
  const { access_token } = account;

  const results = [];

  async function activateOne(level, id) {
    try {
      await metaPost(id, { status: 'ACTIVE' }, access_token);
      return { level, id, status: 'ACTIVE' };
    } catch (err) {
      return { level, id, error: err.message };
    }
  }

  // Level-by-level: campaigns first, then adsets, then ads. Within a level
  // we fan out in parallel — at 4-8 entities the API handles this fine.
  for (const [level, ids] of [
    ['campaign', campaign_ids],
    ['adset',    adset_ids],
    ['ad',       ad_ids],
  ]) {
    if (!ids.length) continue;
    const levelResults = await Promise.all(ids.map(id => activateOne(level, id)));
    for (const r of levelResults) {
      results.push(r);
      if (r.error) {
        yield { type: 'activate_failed', level: r.level, id: r.id, error: r.error };
      } else {
        yield { type: 'activated', level: r.level, id: r.id };
      }
    }
  }

  return results;
}
