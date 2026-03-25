import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { mapCountriesToISO } from '../lib/country-codes.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL && { baseURL: config.anthropic.baseURL }),
});

const FETCH_TIMEOUT = 60_000;
const MAX_TOOL_ITERATIONS = 15; // Execution may need many tool calls

// ── Meta Graph API helpers ─────────────────────────────────────────────

function metaUrl(path) {
  const version = config.meta?.apiVersion || 'v21.0';
  return `https://graph.facebook.com/${version}/${path}`;
}

let _cachedPageToken = null;
async function getPageAccessToken(pageId, systemToken) {
  if (_cachedPageToken) return _cachedPageToken;
  const res = await fetch(metaUrl(`${pageId}?fields=access_token&access_token=${systemToken}`), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const data = await res.json();
  if (data.error) throw new Error(`Failed to get page token: ${data.error.message}`);
  _cachedPageToken = data.access_token;
  return _cachedPageToken;
}

async function metaPost(path, body) {
  const token = config.meta?.accessToken;
  if (!token) throw new Error('META_ACCESS_TOKEN is not configured');

  const res = await fetch(metaUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  const data = await res.json();
  if (data.error) {
    const detail = data.error.error_user_msg || data.error.error_user_title || '';
    const err = new Error(`Meta API error: ${data.error.message}${detail ? ' — ' + detail : ''}`);
    err.code = data.error.code;
    err.subcode = data.error.error_subcode;
    err.type = data.error.type;
    err.blameFields = data.error.error_data?.blame_field_specs;
    throw err;
  }
  return data;
}

// ── Tool definitions ───────────────────────────────────────────────────

const EXECUTION_TOOLS = [
  {
    name: 'meta_upload_media',
    description: 'Upload an image to the Meta ad account. Returns an image_hash for use in ad creatives. Currently accepts a filename reference (the actual image should be pre-uploaded to storage).',
    input_schema: {
      type: 'object',
      required: ['filename'],
      properties: {
        filename: { type: 'string', description: 'Filename reference for the image' },
      },
    },
  },
  {
    name: 'meta_create_campaign',
    description: 'Create a Meta Ads campaign. All campaigns are created in PAUSED status.',
    input_schema: {
      type: 'object',
      required: ['name', 'objective', 'daily_budget'],
      properties: {
        name: { type: 'string', description: 'Campaign name' },
        objective: {
          type: 'string',
          enum: ['lead_gen', 'traffic', 'brand_awareness', 'conversions', 'engagement'],
          description: 'Campaign objective',
        },
        daily_budget: { type: 'number', description: 'Daily budget in dollars' },
      },
    },
  },
  {
    name: 'meta_create_lead_form',
    description: 'Create an Instant Form (Lead Gen Form) on the Facebook Page. Required before creating ad sets with lead_generation optimization. Returns a form_id to use in meta_create_adset.',
    input_schema: {
      type: 'object',
      required: ['name', 'questions'],
      properties: {
        name: { type: 'string', description: 'Form name, e.g. "BYD Dealer Inquiry Form"' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['FULL_NAME', 'EMAIL', 'PHONE', 'COMPANY_NAME', 'JOB_TITLE', 'CITY', 'COUNTRY', 'CUSTOM'],
                description: 'Question type. Use predefined types when possible.',
              },
              label: { type: 'string', description: 'Only needed for CUSTOM type questions' },
            },
          },
          description: 'Form fields. Always include FULL_NAME and EMAIL at minimum.',
        },
        headline: { type: 'string', description: 'Form headline shown to users' },
        description: { type: 'string', description: 'Form description/body text' },
        privacy_policy_url: { type: 'string', description: 'Privacy policy URL (required by Meta). Use the company website if no dedicated page.' },
        thank_you_message: { type: 'string', description: 'Message shown after form submission' },
      },
    },
  },
  {
    name: 'meta_create_adset',
    description: 'Create an ad set within a campaign. Budget is managed at campaign level (CBO), so do NOT pass daily_budget here. For lead_generation ad sets, you MUST pass lead_gen_form_id from meta_create_lead_form.',
    input_schema: {
      type: 'object',
      required: ['campaign_id', 'name', 'targeting', 'optimization_goal'],
      properties: {
        campaign_id: { type: 'string', description: 'Parent campaign ID returned by meta_create_campaign' },
        name: { type: 'string' },
        lead_gen_form_id: { type: 'string', description: 'Form ID from meta_create_lead_form. Required when optimization_goal is lead_generation.' },
        targeting: {
          type: 'object',
          properties: {
            countries: { type: 'array', items: { type: 'string' }, description: '2-letter ISO country codes, e.g. ["ZA","SA","NG"]' },
            age_range: { type: 'array', items: { type: 'number' }, description: '[min_age, max_age], e.g. [25, 55]' },
            gender: { type: 'string', enum: ['all', 'male', 'female'] },
          },
        },
        optimization_goal: {
          type: 'string',
          enum: ['lead_generation', 'link_clicks', 'landing_page_views', 'impressions', 'reach', 'conversions'],
          description: 'Use lead_generation for lead campaigns. Requires lead_gen_form_id.',
        },
        duration_days: { type: 'number', description: 'Campaign duration in days from the media plan. Ad set auto-schedules: start=now, end=now+duration_days.' },
      },
    },
  },
  {
    name: 'meta_create_ad',
    description: 'Create an ad with creative within an ad set.',
    input_schema: {
      type: 'object',
      required: ['adset_id', 'name', 'primary_text', 'headline', 'description', 'cta', 'image_hash', 'link_url'],
      properties: {
        adset_id: { type: 'string', description: 'Parent ad set ID' },
        name: { type: 'string' },
        primary_text: { type: 'string', description: 'Main body text' },
        headline: { type: 'string' },
        description: { type: 'string' },
        cta: {
          type: 'string',
          enum: ['Learn More', 'Shop Now', 'Sign Up', 'Contact Us', 'Get Quote', 'Send WhatsApp', 'Download', 'Apply Now'],
        },
        image_hash: { type: 'string', description: 'Image hash from meta_upload_media' },
        link_url: { type: 'string', description: 'Landing page URL' },
      },
    },
  },
  {
    name: 'submit_execution_result',
    description: 'Submit the final execution results. Call this after creating all campaigns, ad sets, and ads.',
    input_schema: {
      type: 'object',
      required: ['status', 'campaigns', 'errors'],
      properties: {
        status: { type: 'string', enum: ['completed', 'partial', 'failed'] },
        platform: { type: 'string' },
        campaigns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              ad_sets: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    ads: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
        errors: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              level: { type: 'string' },
              name: { type: 'string' },
              error: { type: 'string' },
            },
          },
        },
      },
    },
  },
];

const EXECUTION_SYSTEM_PROMPT = `You are a Meta Ads execution agent. You create campaigns, ad sets, and ads via the Meta Marketing API.

## Workflow
1. Read the media plan (note: duration_days at the top level)
2. If any campaign has objective=lead_gen: call meta_create_lead_form FIRST (one per language)
3. For each campaign: call meta_create_campaign (ensure one campaign per country)
4. For each ad_set: call meta_create_adset with campaign_id + lead_gen_form_id + duration_days
5. For each ad: call meta_create_ad with adset_id + image_hash
6. Call submit_execution_result with all results

## Meta Ads API Best Practices

### Campaign Level
- Objective mapping: lead_gen → OUTCOME_LEADS, traffic → OUTCOME_TRAFFIC, brand_awareness → OUTCOME_AWARENESS
- Budget is set at campaign level (CBO — Campaign Budget Optimization). Do NOT set budget on ad sets.
- bid_strategy is handled automatically (LOWEST_COST_WITHOUT_CAP). Do NOT pass bid_amount.
- Each country MUST have its own campaign — never put multiple countries in one campaign (CBO will drain budget to cheapest country).

### Lead Gen Forms (Instant Forms)
- OUTCOME_LEADS campaigns with lead_generation optimization REQUIRE an Instant Form.
- Call meta_create_lead_form BEFORE creating ad sets. Include FULL_NAME, EMAIL, PHONE, and COMPANY_NAME as questions.
- Pass the returned form_id as lead_gen_form_id when calling meta_create_adset.
- You can share one form across multiple ad sets if they target the same language. Create separate forms for different languages.

### Ad Set Level — CRITICAL RULES
- optimization_goal: use "lead_generation" for lead campaigns. The system maps it to the correct Meta enum.
- For lead_generation ad sets, you MUST pass lead_gen_form_id — without it Meta will reject the ad set.
- ALWAYS pass duration_days (from the media plan's duration_days field). The system auto-schedules: start=now, end=now+duration_days.
- Do NOT set daily_budget on ad sets — budget comes from the parent campaign (CBO).
- Do NOT set bid_amount or bid_strategy on ad sets — inherited from campaign.
- targeting: only pass country codes (2-letter ISO: ZA, SA, NG, KE) + age_range + gender. Nothing else.
- Do NOT include interests — Advantage+ audience finds high-intent users automatically.
- All entities are created as PAUSED. They go live after the user approves.

### Valid optimization_goal → billing_event combinations
| optimization_goal   | billing_event options     |
|---------------------|---------------------------|
| lead_generation     | IMPRESSIONS               |
| link_clicks         | LINK_CLICKS, IMPRESSIONS  |
| landing_page_views  | IMPRESSIONS               |
| impressions         | IMPRESSIONS               |
| reach               | IMPRESSIONS               |
| conversions         | IMPRESSIONS               |
When in doubt, use IMPRESSIONS — it works with all optimization goals.

### Ad Level
- CTA mapping: Learn More → LEARN_MORE, Send WhatsApp → WHATSAPP_MESSAGE, Get Quote → GET_QUOTE, Apply Now → APPLY_NOW, Download → DOWNLOAD
- image_hash: use the hash from the creatives map. If missing for an ad, skip it and record error.

## Error Handling
- If a tool call returns an error, record it and CONTINUE with the next entity. Do not retry.
- If a campaign fails, skip all its child ad sets and ads.
- If an ad set fails, skip all its child ads.

## Final
- All entities are created PAUSED — ads go live after user approval.
- You MUST call submit_execution_result as your final action.`;

// ── Tool execution ─────────────────────────────────────────────────────

async function executeTool(toolName, toolInput) {
  switch (toolName) {
    case 'meta_upload_media':
      return uploadMedia(Buffer.from('placeholder'), toolInput.filename);
    case 'meta_create_campaign':
      return createCampaign(toolInput);
    case 'meta_create_lead_form':
      return createLeadForm(toolInput);
    case 'meta_create_adset':
      return createAdSet(toolInput);
    case 'meta_create_ad':
      return createAd(toolInput);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// ── Low-level Meta API functions ──────────────────────────────────────

/**
 * Upload an image to the ad account.
 */
export async function uploadMedia(imageBuffer, filename = 'ad_image.png') {
  const adAccountId = config.meta?.adAccountId;
  if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID is not configured');
  const token = config.meta?.accessToken;
  if (!token) throw new Error('META_ACCESS_TOKEN is not configured');

  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: 'image/png' });
  formData.append('filename', blob, filename);
  formData.append('access_token', token);

  const res = await fetch(metaUrl(`act_${adAccountId}/adimages`), {
    method: 'POST',
    body: formData,
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Meta API error: ${data.error.message}`);

  const images = data.images || {};
  const imageData = Object.values(images)[0];
  if (!imageData?.hash) throw new Error('No image hash returned from Meta');

  return { image_hash: imageData.hash };
}

/**
 * Create a Lead Gen Form (Instant Form) on the Facebook Page.
 */
export async function createLeadForm({ name, questions, headline, description, privacy_policy_url, thank_you_message }) {
  const pageId = config.meta?.pageId;
  if (!pageId) throw new Error('META_PAGE_ID is not configured');
  const systemToken = config.meta?.accessToken;
  if (!systemToken) throw new Error('META_ACCESS_TOKEN is not configured');

  // Lead Gen Forms require a Page Access Token, not a System User Token
  const token = await getPageAccessToken(pageId, systemToken);

  // Build questions array for Meta API
  const metaQuestions = (questions || []).map(q => {
    if (q.type === 'CUSTOM') {
      return { type: 'CUSTOM', label: q.label || 'Other' };
    }
    return { type: q.type };
  });

  // Ensure at minimum FULL_NAME and EMAIL
  const types = metaQuestions.map(q => q.type);
  if (!types.includes('FULL_NAME')) metaQuestions.unshift({ type: 'FULL_NAME' });
  if (!types.includes('EMAIL')) metaQuestions.push({ type: 'EMAIL' });

  const body = {
    name: name || 'Lead Form',
    questions: JSON.stringify(metaQuestions),
    privacy_policy: { url: privacy_policy_url || 'https://revopanda.com/privacy' },
    follow_up_action_url: privacy_policy_url || 'https://revopanda.com',
    access_token: token,
  };

  if (headline) body.context_card = JSON.stringify({
    title: headline,
    style: 'PARAGRAPH_STYLE',
    content: [description || headline],
  });

  body.thank_you_page = JSON.stringify({
    title: 'Thank You',
    body: thank_you_message || 'Thank you for your interest! We will contact you shortly.',
    button_type: 'WHATSAPP',
    button_text: 'WhatsApp Us',
  });

  const res = await fetch(`https://graph.facebook.com/${config.meta.apiVersion}/${pageId}/leadgen_forms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Meta API error: ${data.error.message}`);

  return { form_id: data.id, name };
}

/**
 * Create a Meta ad campaign.
 */
export async function createCampaign({ name, objective, daily_budget, status = 'PAUSED' }) {
  const adAccountId = config.meta?.adAccountId;
  if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID is not configured');

  const body = {
    name,
    objective: mapObjective(objective),
    status,
    special_ad_categories: [],
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
  };

  // Use Advantage Campaign Budget (CBO) — budget is set at campaign level,
  // ad sets must NOT have their own daily_budget.
  if (daily_budget) {
    body.daily_budget = Math.round(daily_budget * 100);
  }

  return metaPost(`act_${adAccountId}/campaigns`, body);
}

/**
 * Create a Meta ad set.
 */
export async function createAdSet({
  campaign_id,
  name,
  targeting,
  optimization_goal,
  lead_gen_form_id,
  billing_event = 'IMPRESSIONS',
  duration_days,
  status = 'PAUSED',
}) {
  const adAccountId = config.meta?.adAccountId;
  if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID is not configured');

  // Drop interests — let Meta Advantage+ audience handle targeting optimization.
  // Manual interest targeting often causes "audience too small" errors in niche B2B markets.
  if (targeting?.interests) {
    targeting = { ...targeting };
    delete targeting.interests;
  }

  const mappedGoal = mapOptimizationGoal(optimization_goal);

  const body = {
    campaign_id,
    name,
    targeting: buildMetaTargeting(targeting),
    optimization_goal: mappedGoal,
    billing_event,
    // bid_amount not needed — campaign sets LOWEST_COST_WITHOUT_CAP
    status,
  };

  // LEAD_GENERATION requires promoted_object with page_id + destination_type ON_AD
  // Note: lead_gen_form_id goes on the ad creative, NOT on promoted_object
  const pageId = config.meta?.pageId;
  if (['LEAD_GENERATION', 'LEADS'].includes(mappedGoal) && pageId) {
    body.optimization_goal = 'LEAD_GENERATION';
    body.promoted_object = { page_id: pageId };
    body.destination_type = 'ON_AD';
    body.billing_event = 'IMPRESSIONS';
  } else if (['LEAD_GENERATION', 'LEADS'].includes(mappedGoal)) {
    // No page_id: fall back to LINK_CLICKS which works with OUTCOME_LEADS campaigns
    body.optimization_goal = 'LINK_CLICKS';
    body.billing_event = 'LINK_CLICKS';
  }

  // Ensure compatible billing_event for the optimization_goal
  if (['LINK_CLICKS', 'LANDING_PAGE_VIEWS'].includes(body.optimization_goal)) {
    body.billing_event = 'LINK_CLICKS';
  }

  // Schedule: start now, end after duration_days
  if (duration_days && duration_days > 0) {
    const now = new Date();
    body.start_time = now.toISOString();
    const end = new Date(now.getTime() + duration_days * 24 * 60 * 60 * 1000);
    body.end_time = end.toISOString();
  }

  return metaPost(`act_${adAccountId}/adsets`, body);
}

/**
 * Create an ad creative + ad.
 */
export async function createAd({
  adset_id,
  name,
  primary_text,
  headline,
  description,
  cta,
  image_hash,
  link_url,
  lead_gen_form_id,
  status = 'PAUSED',
}) {
  const adAccountId = config.meta?.adAccountId;
  if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID is not configured');
  const pageId = config.meta?.pageId;

  // Build call_to_action — for lead gen, attach form_id in value
  const callToAction = { type: mapCTA(cta) };
  if (lead_gen_form_id) {
    callToAction.value = { lead_gen_form_id };
  }

  // Step 1: Create ad creative
  const creative = await metaPost(`act_${adAccountId}/adcreatives`, {
    name: `Creative - ${name}`,
    object_story_spec: {
      page_id: pageId,
      link_data: {
        image_hash,
        link: link_url,
        message: primary_text,
        name: headline,
        description,
        call_to_action: callToAction,
      },
    },
  });

  // Step 2: Create ad using the creative
  const ad = await metaPost(`act_${adAccountId}/ads`, {
    name,
    adset_id,
    creative: { creative_id: creative.id },
    status,
  });

  return { creative_id: creative.id, ad_id: ad.id };
}

/**
 * Activate all PAUSED campaigns (and their child ad sets + ads) from execution results.
 * Called after user approves the plan.
 *
 * @param {Object} executionResult - The phase_results.execution object
 * @returns {{ activated: string[], errors: Array<{id: string, error: string}> }}
 */
export async function activateCampaigns(executionResult) {
  const campaignIds = (executionResult?.campaigns || [])
    .map(c => c.id)
    .filter(Boolean);

  if (!campaignIds.length) return { activated: [], errors: [] };

  const activated = [];
  const errors = [];

  for (const id of campaignIds) {
    try {
      await metaPost(id, { status: 'ACTIVE' });
      activated.push(id);
    } catch (err) {
      errors.push({ id, error: err.message });
    }
  }

  return { activated, errors };
}

// ── Main entry point (deterministic execution) ──────────────────────────

/**
 * Execute a media plan by directly calling Meta APIs.
 * No LLM involved — deterministic traversal of plan structure.
 *
 * @param {Object} plan - MediaPlan from generateMediaPlan()
 * @param {Object} creatives - Map of ad name → { image_hash }
 * @param {Object} [options]
 * @param {string} [options.link_url] - Default landing page URL
 * @returns {Promise<Object>} Execution results
 */
export async function executeMediaPlan(plan, creatives = {}, options = {}) {
  const metaPlatform = plan.platforms?.find(p => p.platform === 'meta');
  if (!metaPlatform) {
    return { status: 'skipped', reason: 'No Meta platform in plan', campaigns: [], errors: [] };
  }

  const campaignResults = [];
  const errors = [];
  const linkUrl = options.link_url || 'https://revopanda.com';
  const durationDays = plan.duration_days || 30;

  // Step 1: Create lead forms if any campaign uses lead_gen
  const leadFormIds = {}; // language → form_id
  const hasLeadGen = metaPlatform.campaigns?.some(c =>
    (c.objective || '').toLowerCase().includes('lead'));

  if (hasLeadGen) {
    // Detect languages needed from ad names
    const languages = new Set();
    for (const c of metaPlatform.campaigns || []) {
      for (const as of c.ad_sets || []) {
        for (const ad of as.ads || []) {
          const langMatch = (ad.name || '').match(/_([A-Z]{2})(?:_|$)/);
          languages.add(langMatch?.[1] || 'EN');
        }
      }
    }

    for (const lang of languages) {
      try {
        const { form_id } = await createLeadForm({
          name: `Lead Form (${lang}) — ${plan.summary?.slice(0, 50) || 'Campaign'}`,
          questions: [
            { type: 'FULL_NAME' },
            { type: 'EMAIL' },
            { type: 'PHONE' },
            { type: 'COMPANY_NAME' },
          ],
          privacy_policy_url: linkUrl,
          thank_you_message: 'Thank you for your interest! We will contact you shortly.',
        });
        leadFormIds[lang] = form_id;
      } catch (err) {
        errors.push({ level: 'lead_form', name: `Lead Form (${lang})`, error: err.message });
      }
    }
  }

  // Default form for fallback
  const defaultFormId = leadFormIds['EN'] || Object.values(leadFormIds)[0] || null;

  // Step 2: Create campaigns → ad sets → ads
  for (const planCampaign of metaPlatform.campaigns || []) {
    let campaignId;
    try {
      const campResult = await createCampaign({
        name: planCampaign.name,
        objective: planCampaign.objective || 'lead_gen',
        daily_budget: planCampaign.daily_budget,
      });
      campaignId = campResult.id;
    } catch (err) {
      errors.push({ level: 'campaign', name: planCampaign.name, error: err.message });
      // Skip all children
      for (const as of planCampaign.ad_sets || []) {
        errors.push({ level: 'ad_set', name: as.name, error: `Skipped — parent campaign failed` });
        for (const ad of as.ads || []) {
          errors.push({ level: 'ad', name: ad.name, error: `Skipped — parent campaign failed` });
        }
      }
      continue;
    }

    const adSetResults = [];

    for (const planAdSet of planCampaign.ad_sets || []) {
      // Detect language for lead form
      const langMatch = (planAdSet.name || '').match(/_([A-Z]{2})(?:_|$)/);
      const lang = langMatch?.[1] || 'EN';
      const formId = leadFormIds[lang] || defaultFormId;

      let adSetId;
      try {
        const asResult = await createAdSet({
          campaign_id: campaignId,
          name: planAdSet.name,
          targeting: planAdSet.targeting || {},
          optimization_goal: planAdSet.optimization_goal || 'lead_generation',
          lead_gen_form_id: formId,
          duration_days: durationDays,
        });
        adSetId = asResult.id;
      } catch (err) {
        errors.push({ level: 'ad_set', name: planAdSet.name, error: err.message });
        for (const ad of planAdSet.ads || []) {
          errors.push({ level: 'ad', name: ad.name, error: `Skipped — parent ad set failed` });
        }
        continue;
      }

      const adResults = [];

      for (const planAd of planAdSet.ads || []) {
        const creative = creatives[planAd.name];
        if (!creative?.image_hash) {
          errors.push({ level: 'ad', name: planAd.name, error: 'No image_hash in creatives map' });
          continue;
        }

        try {
          const adResult = await createAd({
            adset_id: adSetId,
            name: planAd.name,
            primary_text: planAd.primary_text || planAd.headline || planAd.name,
            headline: planAd.headline || planAd.name,
            description: planAd.description || '',
            cta: planAd.cta || 'Learn More',
            image_hash: creative.image_hash,
            link_url: linkUrl,
            lead_gen_form_id: formId || undefined,
          });
          adResults.push({ name: planAd.name, ad_id: adResult.ad_id, creative_id: adResult.creative_id });
        } catch (err) {
          errors.push({ level: 'ad', name: planAd.name, error: err.message });
        }
      }

      adSetResults.push({ id: adSetId, name: planAdSet.name, ads: adResults });
    }

    campaignResults.push({ id: campaignId, name: planCampaign.name, ad_sets: adSetResults });
  }

  const status = errors.length === 0 ? 'completed'
    : campaignResults.some(c => c.ad_sets.length > 0) ? 'partial'
    : 'failed';

  return { status, platform: 'meta', campaigns: campaignResults, errors };
}

/**
 * Generate a human-readable preview of what will be created.
 */
export function previewExecution(plan) {
  const metaPlatform = plan.platforms?.find(p => p.platform === 'meta');
  if (!metaPlatform) return { preview: 'No Meta campaigns in this plan.', entity_counts: { campaigns: 0, ad_sets: 0, ads: 0 } };

  const lines = [
    `Platform: Meta Ads`,
    `Budget: $${metaPlatform.budget_amount} (${metaPlatform.budget_allocation}% of total)`,
    `Rationale: ${metaPlatform.rationale}`,
    '',
  ];

  for (const c of metaPlatform.campaigns) {
    lines.push(`Campaign: ${c.name}`);
    lines.push(`  Objective: ${c.objective}`);
    lines.push(`  Daily Budget: $${c.daily_budget}`);

    for (const as of c.ad_sets || []) {
      lines.push(`  Ad Set: ${as.name}`);
      lines.push(`    Countries: ${as.targeting?.countries?.join(', ') || 'N/A'}`);
      lines.push(`    Age: ${as.targeting?.age_range?.join('-') || 'N/A'}`);
      lines.push(`    Interests: ${as.targeting?.interests?.slice(0, 3).join(', ') || 'N/A'}`);

      for (const ad of as.ads || []) {
        lines.push(`    Ad: ${ad.name} (${ad.format})`);
        lines.push(`      Headline: ${ad.headline}`);
        lines.push(`      CTA: ${ad.cta}`);
      }
    }
    lines.push('');
  }

  return {
    preview: lines.join('\n'),
    entity_counts: {
      campaigns: metaPlatform.campaigns.length,
      ad_sets: metaPlatform.campaigns.reduce((sum, c) => sum + (c.ad_sets?.length || 0), 0),
      ads: metaPlatform.campaigns.reduce((sum, c) =>
        sum + (c.ad_sets || []).reduce((s, as) => s + (as.ads?.length || 0), 0), 0),
    },
  };
}

// ── Mapping helpers ───────────────────────────────────────────────────

function mapObjective(objective) {
  const map = {
    'lead_gen': 'OUTCOME_LEADS', 'lead_generation': 'OUTCOME_LEADS', 'leads': 'OUTCOME_LEADS',
    'traffic': 'OUTCOME_TRAFFIC', 'brand_awareness': 'OUTCOME_AWARENESS', 'awareness': 'OUTCOME_AWARENESS',
    'conversions': 'OUTCOME_SALES', 'sales': 'OUTCOME_SALES', 'engagement': 'OUTCOME_ENGAGEMENT',
    'app_installs': 'OUTCOME_APP_PROMOTION',
  };
  return map[(objective || '').toLowerCase().replace(/\s+/g, '_')] || objective || 'OUTCOME_LEADS';
}

function mapOptimizationGoal(goal) {
  const map = {
    'lead_generation': 'LEAD_GENERATION', 'leads': 'LEAD_GENERATION', 'lead': 'LEAD_GENERATION',
    'lead_gen': 'LEAD_GENERATION', 'lead_quality': 'QUALITY_LEAD', 'quality_lead': 'QUALITY_LEAD',
    'link_clicks': 'LINK_CLICKS', 'clicks': 'LINK_CLICKS',
    'impressions': 'IMPRESSIONS', 'reach': 'REACH',
    'conversions': 'OFFSITE_CONVERSIONS', 'landing_page_views': 'LANDING_PAGE_VIEWS',
  };
  return map[(goal || '').toLowerCase().replace(/\s+/g, '_')] || goal || 'LINK_CLICKS';
}

function mapCTA(cta) {
  const map = {
    'learn more': 'LEARN_MORE', 'shop now': 'SHOP_NOW', 'sign up': 'SIGN_UP',
    'contact us': 'CONTACT_US', 'get quote': 'GET_QUOTE', 'send message': 'MESSAGE_PAGE',
    'whatsapp': 'WHATSAPP_MESSAGE', 'send whatsapp': 'WHATSAPP_MESSAGE',
    'download': 'DOWNLOAD', 'apply now': 'APPLY_NOW',
  };
  return map[(cta || '').toLowerCase()] || cta || 'LEARN_MORE';
}

/**
 * Resolve interest names to Meta interest IDs via the search API.
 * Returns array of { id, name } objects.
 */
async function resolveInterestIds(interestNames) {
  const token = config.meta?.accessToken;
  if (!token || !interestNames?.length) return [];

  const resolved = [];
  for (const name of interestNames.slice(0, 10)) {
    try {
      const res = await fetch(
        metaUrl(`search?type=adinterest&q=${encodeURIComponent(name)}&access_token=${token}`),
        { signal: AbortSignal.timeout(10_000) },
      );
      const data = await res.json();
      const match = data.data?.[0];
      if (match?.id) {
        resolved.push({ id: match.id, name: match.name });
      }
    } catch { /* skip unresolvable interests */ }
  }
  return resolved;
}

function buildMetaTargeting(targeting) {
  if (!targeting) return {};
  const spec = {};

  if (targeting.countries?.length) {
    spec.geo_locations = {
      countries: mapCountriesToISO(targeting.countries),
    };
  }
  // Advantage+ audience constraints: age_min <= 25, age_max >= 65
  if (targeting.age_range?.length === 2) {
    spec.age_min = Math.min(targeting.age_range[0], 25);
    spec.age_max = Math.max(targeting.age_range[1], 65);
  } else {
    if (targeting.age_min) spec.age_min = Math.min(targeting.age_min, 25);
    if (targeting.age_max) spec.age_max = Math.max(targeting.age_max, 65);
  }
  if (targeting.gender && targeting.gender !== 'all') {
    spec.genders = targeting.gender === 'male' ? [1] : [2];
  }
  // Note: interests are resolved to Meta IDs by resolveInterestIds() before
  // buildMetaTargeting is called. If interests still have no id, skip them.
  if (targeting.interests?.length) {
    const withIds = targeting.interests
      .filter(i => typeof i === 'object' && i.id)
      .map(i => ({ id: i.id, name: i.name }));
    if (withIds.length > 0) {
      spec.flexible_spec = [{ interests: withIds }];
    }
  }
  // Enable Advantage+ audience — Meta's algorithm finds high-intent users
  // automatically from page, creative, and landing page signals.
  // Much more effective than manual interest targeting for B2B niche markets.
  spec.targeting_automation = { advantage_audience: 1 };
  return spec;
}
