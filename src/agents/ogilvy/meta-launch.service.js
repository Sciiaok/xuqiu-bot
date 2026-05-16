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
import { config } from '../../config.js';
import { getMetaAccountForUser } from './whatsapp-accounts.service.js';
import { isAllowedCreativeUrl } from './creative.service.js';

const FETCH_TIMEOUT = 60_000;
const GRAPH_VERSION = config.meta.apiVersion || 'v21.0';

// ── Graph API helpers ──────────────────────────────────────────────────

function graphUrl(path) {
  return `https://graph.facebook.com/${GRAPH_VERSION}/${path}`;
}

async function metaPost(path, body, token, { step } = {}) {
  const res = await fetch(graphUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const data = await res.json();
  if (data.error) {
    const msg = data.error.error_user_msg || data.error.error_user_title || data.error.message;
    // Include the step (campaign / adset / creative / ad / activate) so the
    // user can tell at which stage Meta rejected the request.
    const err = new Error(step ? `Meta API [${step}]: ${msg}` : `Meta API: ${msg}`);
    err.metaError = data.error;
    err.metaStatus = res.status;
    err.step = step;
    throw err;
  }
  return data;
}

async function metaUploadImage(imageUrl, { ad_account_id, access_token }) {
  // Graph can't ingest third-party URLs directly without special perms, so we
  // re-download + upload multipart. Works for any public image (incl. ours on
  // Supabase storage).
  //
  // NOTE: `ad_account_id` is stored with the `act_` prefix in DB (see
  // app/api/meta/connect/route.js: normalized to `act_<numeric>`), so we use
  // it as-is. Do NOT prepend another `act_` — Meta will reject with
  // "Object with ID 'act_act_…' does not exist".
  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!imgRes.ok) throw new Error(`Failed to download image: ${imgRes.status}`);
  const blob = await imgRes.blob();

  const formData = new FormData();
  const filename = imageUrl.split('/').pop()?.split('?')[0] || 'ad_image.png';
  formData.append('filename', blob, filename);
  formData.append('access_token', access_token);

  const res = await fetch(graphUrl(`${ad_account_id}/adimages`), {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Meta API [image]: ${data.error.message}`);
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
  // Pre-flight: scan every ad's image_url and refuse the whole launch if any
  // of them weren't produced by our own generate_ad_creative. Catching it
  // here (before any Meta API call) avoids the previous failure mode where a
  // tampered plan still produced a real campaign on Meta before the deep-
  // nested per-ad check fired. The per-ad check below is kept as defense in
  // depth in case future code adds a path that bypasses this scan.
  for (const c of plan?.campaigns || []) {
    for (const as of c?.ad_sets || []) {
      for (const ad of as?.ads || []) {
        const u = ad?.creative?.image_url;
        if (u && !isAllowedCreativeUrl(u)) {
          throw new Error(
            `Refusing to launch ad "${ad.name}": image_url is not from our generate_ad_creative output. ` +
            'Plan tampering or a stale plan from an older session is the likely cause; delete this session and rebuild.',
          );
        }
      }
    }
  }

  const account = await getMetaAccountForUser(userId);
  if (!account) throw new Error('Meta 未连接：请先在「设置 → Meta 连接」完成接入');
  const { access_token, ad_account_id, page_id } = account;
  if (!access_token || !ad_account_id) {
    throw new Error('Meta 连接缺 token 或广告账户：去「设置 → Meta 连接」重新接入');
  }
  if (!page_id) {
    throw new Error('Facebook Page ID 未配置：去「设置 → Meta 连接 → Facebook 主页」粘贴主页 ID（CTWA 广告必须绑主页）');
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
    // Fail fast on missing / malformed budget. Without a positive integer
    // daily_budget, Meta silently treats the campaign as "no campaign budget"
    // and then rejects the adset with a cryptic
    //   "若不使用广告系列预算，则必须在 is_adset_budget_sharing_enabled ..."
    // error. Surfacing it up front beats chasing it through Graph responses.
    const dailyBudget = Number(campaign.daily_budget_cents);
    if (!Number.isInteger(dailyBudget) || dailyBudget <= 0) {
      throw new Error(
        `campaign "${campaign.name}" 缺少有效的 daily_budget_cents（收到：${JSON.stringify(campaign.daily_budget_cents)}）。` +
        '需要正整数，单位为分（例如 $20/天 = 2000）。',
      );
    }

    // 1. Campaign (CBO: daily_budget + bid_strategy live here, not on adset).
    // Meta requires is_adset_budget_sharing_enabled to be explicit on any
    // campaign with >1 adset (and is harmless on single-adset campaigns).
    // Passing `false` opts out of the 20%-shared-budget optimization — safer
    // default for MVP where per-adset spend should be predictable.
    const campaignPayload = {
      name: campaign.name,
      objective: 'OUTCOME_ENGAGEMENT',
      status: 'PAUSED',
      buying_type: 'AUCTION',
      special_ad_categories: [],
      daily_budget: dailyBudget,
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      is_adset_budget_sharing_enabled: false,
    };
    const { id: campaignId } = await metaPost(
      `${ad_account_id}/campaigns`,
      campaignPayload,
      access_token,
      { step: `campaign "${campaign.name}"` },
    );
    out.campaign_ids.push(campaignId);
    yield { type: 'campaign_created', name: campaign.name, id: campaignId };

    for (const adSet of campaign.ad_sets || []) {
      // Meta requires non-empty geo_locations.countries. If the LLM emitted
      // an empty array, Graph would reject with a vague "targeting is
      // required" message — catch it up front with a clear explanation.
      const countries = Array.isArray(adSet.targeting?.countries)
        ? adSet.targeting.countries.filter(c => typeof c === 'string' && c.trim())
        : [];
      if (countries.length === 0) {
        throw new Error(
          `ad_set "${adSet.name}" 的 targeting.countries 为空。至少需要 1 个 ISO-2 国家码（例 "TH"、"ID"）。`,
        );
      }

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
          geo_locations: { countries },
          // Meta requires advantage_audience explicitly since 2025. 0 = opt out,
          // keeping the targeting we specified exactly. Matches our reference
          // live ad (adset 120243642835730034).
          targeting_automation: { advantage_audience: 0 },
        },
        status: 'PAUSED',
      };
      const { id: adsetId } = await metaPost(
        `${ad_account_id}/adsets`,
        adsetPayload,
        access_token,
        { step: `adset "${adSet.name}"` },
      );
      out.adset_ids.push(adsetId);
      yield { type: 'adset_created', name: adSet.name, id: adsetId };

      for (const ad of adSet.ads || []) {
        const creative = ad.creative || {};
        if (!creative.image_url) {
          yield { type: 'error', ad: ad.name, error: '缺少 creative.image_url，跳过此广告' };
          continue;
        }
        // Hard fail (vs. skip with `continue`): plan_json carrying a non-
        // whitelisted URL got past validatePlanShape, which is either a code
        // bug or a tampered DB row. Aborting the whole launch is the safe
        // move — better than uploading an attacker-controlled asset to Meta
        // and continuing as if everything were fine.
        if (!isAllowedCreativeUrl(creative.image_url)) {
          throw new Error(
            `Refusing to launch ad "${ad.name}": image_url is not from our generate_ad_creative output. ` +
            'Plan tampering or a stale plan from an older session is the likely cause; delete this session and rebuild.',
          );
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
        const { id: creativeId } = await metaPost(
          `${ad_account_id}/adcreatives`,
          creativePayload,
          access_token,
          { step: `creative "${ad.name}"` },
        );
        out.creative_ids.push(creativeId);
        yield { type: 'creative_created', ad: ad.name, id: creativeId };

        // 5. Ad pointing to this creative
        const adPayload = {
          name: ad.name,
          adset_id: adsetId,
          creative: { creative_id: creativeId },
          status: 'PAUSED',
        };
        const { id: adId } = await metaPost(
          `${ad_account_id}/ads`,
          adPayload,
          access_token,
          { step: `ad "${ad.name}"` },
        );
        out.ad_ids.push(adId);
        yield { type: 'ad_created', ad: ad.name, id: adId };
      }
    }
  }

  return out;
}

// ── fetchAdStatuses (read effective_status from Meta) ──────────────────

/**
 * Batch-fetch `effective_status` for every ad ID. This is distinct from what
 * we set via /pause /resume: configured_status tells Meta "we want this on",
 * effective_status tells us what's actually happening — IN_PROCESS while
 * Meta reviews, ACTIVE when it's truly serving, DISAPPROVED if rejected,
 * WITH_ISSUES / PENDING_BILLING_INFO if blocked on something else.
 *
 * Returns: [{ id, name, effective_status, issues_info? }]. Missing IDs are
 * omitted from the response (Meta drops them silently).
 */
export async function fetchAdStatuses(adIds, { userId }) {
  if (!Array.isArray(adIds) || adIds.length === 0) return [];
  const account = await getMetaAccountForUser(userId);
  if (!account) throw new Error('Meta 未连接：请先在「设置 → Meta 连接」完成接入');
  const { access_token } = account;

  // Batch lookup: GET /v21.0/?ids=AD_1,AD_2&fields=… returns
  // { AD_1: {...}, AD_2: {...} }. One request for any number of ads.
  const url = new URL(graphUrl(''));
  url.searchParams.set('ids', adIds.join(','));
  url.searchParams.set('fields', 'id,name,effective_status,issues_info');
  url.searchParams.set('access_token', access_token);

  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  const data = await res.json();
  if (data.error) {
    const msg = data.error.error_user_msg || data.error.message;
    throw new Error(`Meta API [ad-status]: ${msg}`);
  }
  return Object.values(data).filter((row) => row && row.id);
}

// ── setCampaignsStatus (pause / resume) ────────────────────────────────

/**
 * Flip every level (campaign → adset → ad) to a target status (ACTIVE or
 * PAUSED). Mirrors activateCampaigns but as a one-shot async function — pause
 * and resume don't need streaming (just N small status-update calls, no image
 * uploads, no entity creation).
 *
 * Returns per-id results so partial failures are visible:
 *   [{ level, id, status: 'PAUSED' }, { level, id, error: '...' }]
 */
export async function setCampaignsStatus(
  { campaign_ids = [], adset_ids = [], ad_ids = [] },
  target,
  { userId },
) {
  if (target !== 'ACTIVE' && target !== 'PAUSED') {
    throw new Error(`setCampaignsStatus: target must be ACTIVE or PAUSED, got ${target}`);
  }
  const account = await getMetaAccountForUser(userId);
  if (!account) throw new Error('Meta 未连接：请先在「设置 → Meta 连接」完成接入');
  const { access_token } = account;

  const results = [];
  // Same top-down order as activateCampaigns — cosmetic, but avoids the
  // transient state where an ad is ACTIVE while its parent adset is still
  // PAUSED (or vice-versa on pause).
  for (const [level, ids] of [
    ['campaign', campaign_ids],
    ['adset',    adset_ids],
    ['ad',       ad_ids],
  ]) {
    if (!ids.length) continue;
    const levelResults = await Promise.all(ids.map(async (id) => {
      try {
        await metaPost(id, { status: target }, access_token, { step: `set ${level} ${id} → ${target}` });
        return { level, id, status: target };
      } catch (err) {
        return { level, id, error: err.message };
      }
    }));
    results.push(...levelResults);
  }
  return results;
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
  if (!account) throw new Error('Meta 未连接：请先在「设置 → Meta 连接」完成接入');
  const { access_token } = account;

  const results = [];

  async function activateOne(level, id) {
    try {
      await metaPost(id, { status: 'ACTIVE' }, access_token, { step: `activate ${level} ${id}` });
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
