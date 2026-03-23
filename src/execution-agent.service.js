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
    const err = new Error(`Meta API error: ${data.error.message}`);
    err.code = data.error.code;
    err.type = data.error.type;
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
    name: 'meta_create_adset',
    description: 'Create an ad set within a campaign. Includes targeting configuration.',
    input_schema: {
      type: 'object',
      required: ['campaign_id', 'name', 'targeting', 'daily_budget', 'optimization_goal'],
      properties: {
        campaign_id: { type: 'string', description: 'Parent campaign ID' },
        name: { type: 'string' },
        targeting: {
          type: 'object',
          properties: {
            countries: { type: 'array', items: { type: 'string' } },
            age_range: { type: 'array', items: { type: 'number' } },
            gender: { type: 'string', enum: ['all', 'male', 'female'] },
            interests: { type: 'array', items: { type: 'string' } },
          },
        },
        daily_budget: { type: 'number', description: 'Daily budget in dollars' },
        optimization_goal: { type: 'string' },
        billing_event: { type: 'string', description: 'Default: IMPRESSIONS' },
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

const EXECUTION_SYSTEM_PROMPT = `You are a Meta Ads execution agent.

Your job: take a media plan and create all the campaigns, ad sets, and ads via the Meta API tools.

Workflow:
1. Read the media plan carefully
2. For each campaign in the Meta platform section:
   a. Call meta_create_campaign
   b. For each ad_set: call meta_create_adset with the campaign_id
   c. For each ad: call meta_create_ad with the adset_id and image_hash
3. Collect all created entity IDs
4. Call submit_execution_result with the final results

Rules:
- All entities are created in PAUSED status (the human will review before activating)
- If a tool call fails, record the error and continue with the next entity
- Use the image_hash from the creatives map provided in the brief
- Map objectives: lead_gen → OUTCOME_LEADS, traffic → OUTCOME_TRAFFIC, brand_awareness → OUTCOME_AWARENESS
- Map CTAs: Learn More → LEARN_MORE, Send WhatsApp → WHATSAPP_MESSAGE
- You MUST call submit_execution_result as your final action`;

// ── Tool execution ─────────────────────────────────────────────────────

async function executeTool(toolName, toolInput) {
  switch (toolName) {
    case 'meta_upload_media':
      return uploadMedia(Buffer.from('placeholder'), toolInput.filename);
    case 'meta_create_campaign':
      return createCampaign(toolInput);
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
 * Create a Meta ad campaign.
 */
export async function createCampaign({ name, objective, daily_budget, status = 'PAUSED' }) {
  const adAccountId = config.meta?.adAccountId;
  if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID is not configured');

  return metaPost(`act_${adAccountId}/campaigns`, {
    name,
    objective: mapObjective(objective),
    daily_budget: Math.round(daily_budget * 100),
    status,
    special_ad_categories: [],
  });
}

/**
 * Create a Meta ad set.
 */
export async function createAdSet({
  campaign_id,
  name,
  targeting,
  daily_budget,
  optimization_goal,
  billing_event = 'IMPRESSIONS',
  bid_amount = 100,
  status = 'PAUSED',
}) {
  const adAccountId = config.meta?.adAccountId;
  if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID is not configured');

  // Resolve interest names to Meta IDs
  if (targeting?.interests?.length && typeof targeting.interests[0] === 'string') {
    const resolved = await resolveInterestIds(targeting.interests);
    targeting = { ...targeting, interests: resolved };
  }

  const mappedGoal = mapOptimizationGoal(optimization_goal);

  const body = {
    campaign_id,
    name,
    targeting: buildMetaTargeting(targeting),
    optimization_goal: mappedGoal,
    billing_event,
    bid_amount,
    status,
  };

  // LEAD_GENERATION requires promoted_object with a valid Facebook Page ID
  const pageId = config.meta?.pageId;
  if (['LEAD_GENERATION', 'LEADS'].includes(mappedGoal) && pageId) {
    body.optimization_goal = 'LEAD_GENERATION';
    body.promoted_object = { page_id: pageId };
  } else if (['LEAD_GENERATION', 'LEADS'].includes(mappedGoal)) {
    // No page_id: use LINK_CLICKS which is compatible with OUTCOME_LEADS campaigns
    body.optimization_goal = 'LINK_CLICKS';
    body.billing_event = 'IMPRESSIONS';
  }

  // Only set adset-level budget if provided and > 0
  // (campaigns with campaign-level budget don't allow adset budgets)
  if (daily_budget) {
    body.daily_budget = Math.round(daily_budget * 100);
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
  status = 'PAUSED',
}) {
  const adAccountId = config.meta?.adAccountId;
  if (!adAccountId) throw new Error('META_AD_ACCOUNT_ID is not configured');
  const pageId = config.whatsapp?.phoneNumberId;

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
        call_to_action: { type: mapCTA(cta) },
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

// ── Main entry point (tool_use mode) ───────────────────────────────────

/**
 * Execute a media plan using Claude tool_use.
 * Claude reads the plan and orchestrates Meta API calls via tools.
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

  const messages = [{
    role: 'user',
    content: `Execute this media plan by creating all entities via the Meta API tools.

MEDIA PLAN (Meta platform only):
${JSON.stringify(metaPlatform, null, 2)}

AVAILABLE CREATIVES (ad name → image_hash):
${JSON.stringify(creatives, null, 2)}

DEFAULT LINK URL: ${options.link_url || 'https://revopanda.com'}

Create all campaigns, ad sets, and ads in order. For each ad, use the image_hash from the creatives map. If an image_hash is missing for an ad, skip it and record the error. After all entities are created, call submit_execution_result.`,
  }];

  let response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: EXECUTION_SYSTEM_PROMPT,
    messages,
    tools: EXECUTION_TOOLS,
    tool_choice: { type: 'auto' },
  });

  // Tool-use loop
  let iterations = 0;
  while (iterations < MAX_TOOL_ITERATIONS) {
    if (response.stop_reason !== 'tool_use') break;
    iterations++;

    const toolUseBlocks = response.content.filter(c => c.type === 'tool_use');

    // Check for submit_execution_result
    const submitBlock = toolUseBlocks.find(t => t.name === 'submit_execution_result');
    if (submitBlock) {
      return submitBlock.input;
    }

    // Execute tools
    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      let result;
      try {
        result = await executeTool(toolUse.name, toolUse.input);
      } catch (err) {
        result = { error: err.message };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: EXECUTION_SYSTEM_PROMPT,
      messages,
      tools: EXECUTION_TOOLS,
      tool_choice: { type: 'auto' },
    });
  }

  // Final check
  const finalSubmit = response.content.find(c => c.type === 'tool_use' && c.name === 'submit_execution_result');
  if (finalSubmit) return finalSubmit.input;

  // Force submit
  messages.push({ role: 'assistant', content: response.content });
  messages.push({ role: 'user', content: 'Please call submit_execution_result with the results now.' });

  response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: EXECUTION_SYSTEM_PROMPT,
    messages,
    tools: EXECUTION_TOOLS,
    tool_choice: { type: 'tool', name: 'submit_execution_result' },
  });

  const forced = response.content.find(c => c.type === 'tool_use' && c.name === 'submit_execution_result');
  if (forced) return forced.input;

  throw new Error('Execution agent did not produce results');
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
    'lead_generation': 'LEAD_GENERATION', 'leads': 'LEAD_GENERATION',
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
  if (targeting.age_range?.length === 2) {
    spec.age_min = targeting.age_range[0];
    spec.age_max = targeting.age_range[1];
  } else {
    if (targeting.age_min) spec.age_min = targeting.age_min;
    if (targeting.age_max) spec.age_max = targeting.age_max;
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
  // Meta requires advantage_audience flag
  spec.targeting_automation = { advantage_audience: 0 };
  return spec;
}
