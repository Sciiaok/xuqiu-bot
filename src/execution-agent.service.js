import { anthropic, MODELS } from './llm-client.js';
import { callTool, listTools } from './meta-ads-mcp-client.js';
import { config } from './config.js';
import { mapCountriesToISO } from '../lib/country-codes.js';

const FETCH_TIMEOUT = 60_000;
const MAX_TOOL_ITERATIONS = 20;

// ── MCP tool allowlist for execution ─────────────────────────────────

const MCP_TOOL_ALLOWLIST = new Set([
  'upload_ad_image',
  'create_campaign',
  'create_adset',
  'create_ad',
  'create_ad_creative',
  'get_account_pages',
]);

// ── Custom tools (not available in MCP) ──────────────────────────────

const CREATE_LEAD_FORM_TOOL = {
  name: 'create_lead_form',
  description: 'Create an Instant Form (Lead Gen Form) on the Facebook Page. Required before creating lead_generation ad sets. Returns form_id.',
  input_schema: {
    type: 'object',
    required: ['name', 'questions'],
    properties: {
      name: { type: 'string', description: 'Form name' },
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['FULL_NAME', 'EMAIL', 'PHONE', 'COMPANY_NAME', 'JOB_TITLE', 'CITY', 'COUNTRY', 'CUSTOM'],
            },
            label: { type: 'string', description: 'Only needed for CUSTOM type' },
          },
        },
        description: 'Form fields. Always include FULL_NAME and EMAIL at minimum.',
      },
      headline: { type: 'string', description: 'Form headline' },
      description: { type: 'string', description: 'Form description' },
      privacy_policy_url: { type: 'string', description: 'Privacy policy URL' },
      thank_you_message: { type: 'string', description: 'Post-submission message' },
    },
  },
};

const SUBMIT_EXECUTION_RESULT_TOOL = {
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
};

// ── System prompt ────────────────────────────────────────────────────

function buildExecutionPrompt(accountId, pageId) {
  return `You are a Meta Ads execution agent. You create campaigns, ad sets, and ads using the provided tools.

## Account Info
- account_id: ${accountId}
- page_id: ${pageId || 'NOT CONFIGURED'}

## Workflow
1. Upload images: call upload_ad_image with image_url for each creative asset
2. Lead forms: if any campaign uses lead_gen/leads objective, call create_lead_form FIRST (one per language)
3. Create campaigns: call create_campaign for each campaign (one campaign per country)
4. Create ad sets: call create_adset for each ad set within its campaign
5. Create ad creatives: call create_ad_creative with image_hash + page_id + ad copy
6. Create ads: call create_ad with creative_id + adset_id
7. Submit: call submit_execution_result with all created entities and any errors

## Account Assets
WhatsApp phone numbers, Instagram accounts, and other assets are provided in the ACCOUNT ASSETS section of the user message. Use these IDs directly — do NOT make separate API calls to fetch them.

## Objective Mapping
The media plan uses short names. Map them for create_campaign:
- lead_gen / leads → OUTCOME_LEADS
- traffic → OUTCOME_TRAFFIC
- brand_awareness / awareness → OUTCOME_AWARENESS
- conversions / sales → OUTCOME_SALES
- engagement → OUTCOME_ENGAGEMENT

## Campaign Rules
- status: always PAUSED (ads go live after user approval)
- bid_strategy: LOWEST_COST_WITHOUT_CAP
- daily_budget: in CENTS (multiply dollars by 100)
- special_ad_categories: [] (empty array)
- One campaign per country — never mix countries (CBO drains budget to cheapest)

## Ad Set Rules
- Do NOT set daily_budget on ad sets — budget comes from campaign (CBO)
- Do NOT set bid_amount — inherited from campaign
- optimization_goal: use LEAD_GENERATION for lead campaigns, LINK_CLICKS for traffic
- billing_event: IMPRESSIONS (works with all goals)
- For LEAD_GENERATION: set promoted_object: { "page_id": "${pageId}" } and destination_type: "ON_AD"
- targeting: use geo_locations.countries with 2-letter ISO codes (ZA, NG, SA, etc.)
  Set age_min, age_max. Enable targeting_automation: { "advantage_audience": 1 }
  Do NOT include interests — let Advantage+ handle targeting
- Schedule: set start_time and end_time (ISO 8601) using duration_days from the plan

## Ad Creative Rules
- Pass page_id to create_ad_creative
- Set call_to_action_type: LEARN_MORE, SIGN_UP, SHOP_NOW, GET_QUOTE, WHATSAPP_MESSAGE, APPLY_NOW, DOWNLOAD
- For lead gen: pass lead_gen_form_id from create_lead_form result

## Error Handling
- If a tool call errors, record the error and CONTINUE with next entity
- If a campaign fails, skip all its child ad sets and ads
- If an ad set fails, skip its child ads
- Do NOT retry failed tool calls
- At the end, call submit_execution_result with status: "completed" (no errors), "partial" (some errors), or "failed" (all failed)`;
}

// ── Lead Form (direct API — MCP does not support this) ───────────────

let _cachedPageToken = null;
async function getPageAccessToken(pageId, systemToken) {
  if (_cachedPageToken) return _cachedPageToken;
  const version = config.meta?.apiVersion || 'v21.0';
  const res = await fetch(
    `https://graph.facebook.com/${version}/${pageId}?fields=access_token&access_token=${systemToken}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
  );
  const data = await res.json();
  if (data.error) throw new Error(`Failed to get page token: ${data.error.message}`);
  _cachedPageToken = data.access_token;
  return _cachedPageToken;
}

export async function createLeadForm({ name, questions, headline, description, privacy_policy_url, thank_you_message }) {
  const pageId = config.meta?.pageId;
  if (!pageId) throw new Error('META_PAGE_ID is not configured');
  const systemToken = config.meta?.accessToken;
  if (!systemToken) throw new Error('META_ACCESS_TOKEN is not configured');

  const token = await getPageAccessToken(pageId, systemToken);

  const metaQuestions = (questions || []).map(q => {
    if (q.type === 'CUSTOM') return { type: 'CUSTOM', label: q.label || 'Other' };
    return { type: q.type };
  });
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

  const version = config.meta?.apiVersion || 'v21.0';
  const res = await fetch(`https://graph.facebook.com/${version}/${pageId}/leadgen_forms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Meta API error: ${data.error.message}`);
  return { form_id: data.id, name };
}

// ── Batch helpers ────────────────────────────────────────────────────

const OBJECTIVE_MAP = {
  lead_gen: 'OUTCOME_LEADS', leads: 'OUTCOME_LEADS', lead_generation: 'OUTCOME_LEADS',
  traffic: 'OUTCOME_TRAFFIC',
  brand_awareness: 'OUTCOME_AWARENESS', awareness: 'OUTCOME_AWARENESS',
  conversions: 'OUTCOME_SALES', sales: 'OUTCOME_SALES',
  engagement: 'OUTCOME_ENGAGEMENT',
  reach: 'OUTCOME_AWARENESS',
};

const CTA_MAP = {
  'Learn More': 'LEARN_MORE',
  'Shop Now': 'SHOP_NOW',
  'Send WhatsApp': 'WHATSAPP_MESSAGE',
  'WhatsApp': 'WHATSAPP_MESSAGE',
  'Send WhatsApp Message': 'WHATSAPP_MESSAGE',
  'Send Message to WhatsApp': 'WHATSAPP_MESSAGE',
  'Send Message': 'MESSAGE_PAGE',
  'Sign Up': 'SIGN_UP',
  'Get Quote': 'GET_QUOTE',
  'Apply Now': 'APPLY_NOW',
  'Download': 'DOWNLOAD',
  'Contact Us': 'CONTACT_US',
  'Subscribe': 'SUBSCRIBE',
  'Book Now': 'BOOK_TRAVEL',
  // Chinese aliases
  '发送WhatsApp消息': 'WHATSAPP_MESSAGE',
  '在WhatsApp上发消息': 'WHATSAPP_MESSAGE',
  'WhatsApp联系': 'WHATSAPP_MESSAGE',
  '联系我们': 'CONTACT_US',
  '立即获取报价': 'GET_QUOTE',
  '获取详细资料': 'LEARN_MORE',
};

function buildBatchTargeting(targeting = {}) {
  const countries = targeting.countries || [];
  const ageMin = targeting.age_range?.[0] || targeting.age_min || 18;
  const ageMax = targeting.age_range?.[1] || targeting.age_max || 65;
  const spec = {
    geo_locations: { countries: mapCountriesToISO(countries) },
    age_min: Math.min(ageMin, 18),
    age_max: Math.max(ageMax, 65),
    targeting_automation: { advantage_audience: 1 },
  };
  if (targeting.gender === 'male') spec.genders = [1];
  else if (targeting.gender === 'female') spec.genders = [2];
  return spec;
}

function pickOptimizationGoal(metaObjective) {
  switch (metaObjective) {
    case 'OUTCOME_LEADS': return 'LEAD_GENERATION';
    case 'OUTCOME_TRAFFIC': return 'LINK_CLICKS';
    case 'OUTCOME_AWARENESS': return 'REACH';
    case 'OUTCOME_SALES': return 'OFFSITE_CONVERSIONS';
    case 'OUTCOME_ENGAGEMENT': return 'POST_ENGAGEMENT';
    default: return 'LINK_CLICKS';
  }
}

/**
 * Upload multiple images via MCP and return a { name: image_hash } map.
 *
 * @param {Array<{name: string, url: string}>} images
 * @param {Object} [options]
 * @param {Function} [options.onProgress]
 * @returns {Promise<Object>} Map of name → image_hash
 */
export async function uploadImages(images, options = {}) {
  const onProgress = options.onProgress;
  const accountId = `act_${config.meta?.adAccountId}`;
  const result = {};
  const CONCURRENCY = 5;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < images.length; i += CONCURRENCY) {
    const batch = images.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (image) => {
        const res = await callTool('upload_ad_image', { account_id: accountId, image_url: image.url });
        const hash = res.image_hash || res.hash || res.images?.[Object.keys(res.images)[0]]?.hash;
        return { name: image.name, hash };
      }),
    );

    for (let j = 0; j < settled.length; j++) {
      const image = batch[j];
      const outcome = settled[j];
      if (outcome.status === 'fulfilled' && outcome.value.hash) {
        result[image.name] = outcome.value.hash;
        onProgress?.({ step: 'upload_image', name: image.name, image_hash: outcome.value.hash });
      } else {
        const error = outcome.status === 'rejected' ? outcome.reason.message : 'No hash returned';
        onProgress?.({ step: 'upload_image', name: image.name, error });
      }
    }
  }

  return result;
}

/**
 * Create a full campaign structure: campaign → adsets → creatives → ads via MCP.
 *
 * @param {Object} input - Campaign object with nested ad_sets[].ads[]
 * @param {Object} [options]
 * @param {Function} [options.onProgress]
 * @returns {Promise<Object>} { status, campaign_id, ad_sets, errors }
 */
export async function createFullCampaign(input, options = {}) {
  const onProgress = options.onProgress;
  const accountId = `act_${config.meta?.adAccountId}`;
  const pageId = config.meta?.pageId;
  const metaObjective = OBJECTIVE_MAP[input.objective] || input.objective;
  const isLeadGen = metaObjective === 'OUTCOME_LEADS';
  const errors = [];
  const adSetResults = [];

  // Create campaign
  let campaignId;
  try {
    const campaignRes = await callTool('create_campaign', {
      account_id: accountId,
      name: input.name,
      objective: metaObjective,
      status: 'PAUSED',
      special_ad_categories: [],
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      daily_budget: Math.round((input.daily_budget || 0) * 100),
    });
    campaignId = campaignRes.id || campaignRes.campaign_id;
    if (!campaignId) {
      throw new Error(`create_campaign returned no ID: ${JSON.stringify(campaignRes).slice(0, 200)}`);
    }
    onProgress?.({ step: 'create_campaign', name: input.name, campaign_id: campaignId });
  } catch (err) {
    errors.push({ level: 'campaign', name: input.name, error: err.message });
    return { status: 'failed', campaign_id: null, ad_sets: [], errors };
  }

  // Create ad sets
  for (const adSet of input.ad_sets || []) {
    let adSetId;
    try {
      const adSetParams = {
        account_id: accountId,
        campaign_id: campaignId,
        name: adSet.name,
        status: 'PAUSED',
        optimization_goal: pickOptimizationGoal(metaObjective),
        billing_event: 'IMPRESSIONS',
        targeting: buildBatchTargeting(adSet.targeting),
      };

      if (isLeadGen && pageId) {
        adSetParams.promoted_object = { page_id: pageId };
        adSetParams.destination_type = 'ON_AD';
      }

      // Schedule
      if (input.duration_days > 0) {
        const now = new Date();
        adSetParams.start_time = now.toISOString();
        adSetParams.end_time = new Date(now.getTime() + input.duration_days * 24 * 60 * 60 * 1000).toISOString();
      }

      const adSetRes = await callTool('create_adset', adSetParams);
      adSetId = adSetRes.id || adSetRes.adset_id || adSetRes.ad_set_id;
      if (!adSetId) {
        throw new Error(`create_adset returned no ID: ${JSON.stringify(adSetRes).slice(0, 300)}`);
      }
      onProgress?.({ step: 'create_adset', name: adSet.name, adset_id: adSetId });
    } catch (err) {
      errors.push({ level: 'adset', name: adSet.name, error: err.message });
      continue;
    }

    // Create ads within this ad set
    const adResults = [];
    for (const ad of adSet.ads || []) {
      if (!ad.image_hash) {
        errors.push({ level: 'ad', name: ad.name, error: 'Missing image_hash' });
        continue;
      }

      try {
        // MCP create_ad_creative uses flat params (not object_story_spec)
        const creativeParams = {
          account_id: accountId,
          name: `${ad.name} Creative`,
          page_id: pageId,
          image_hash: ad.image_hash,
          message: ad.primary_text,
          headline: ad.headline,
          description: ad.description,
          link_url: ad.link_url || input.link_url,
          call_to_action_type: CTA_MAP[ad.cta] || 'LEARN_MORE',
        };

        if (isLeadGen && ad.lead_gen_form_id) {
          creativeParams.lead_gen_form_id = ad.lead_gen_form_id;
        }

        const creativeRes = await callTool('create_ad_creative', creativeParams);
        const creativeId = creativeRes.id || creativeRes.creative_id;
        if (!creativeId) {
          throw new Error(`create_ad_creative returned no ID: ${JSON.stringify(creativeRes).slice(0, 300)}`);
        }

        // MCP create_ad uses flat creative_id (not nested creative object)
        const adRes = await callTool('create_ad', {
          account_id: accountId,
          adset_id: adSetId,
          name: ad.name,
          status: 'PAUSED',
          creative_id: creativeId,
        });
        const adId = adRes.id || adRes.ad_id;
        if (!adId) {
          throw new Error(`create_ad returned no ID: ${JSON.stringify(adRes).slice(0, 300)}`);
        }

        adResults.push({ ad_id: adId, creative_id: creativeId, name: ad.name });
        onProgress?.({ step: 'create_ad', name: ad.name, ad_id: adId, creative_id: creativeId });
      } catch (err) {
        errors.push({ level: 'ad', name: ad.name, error: err.message });
      }
    }

    adSetResults.push({ id: adSetId, name: adSet.name, ads: adResults });
  }

  const status = errors.length === 0 ? 'completed' : adSetResults.length === 0 ? 'failed' : 'partial';
  return { status, campaign_id: campaignId, ad_sets: adSetResults, errors };
}

// ── Batch execution (direct MCP calls, no Claude agent) ─────────────

/**
 * Execute a media plan using direct MCP tool calls (no Claude agent).
 * Images are uploaded first, then campaigns/adsets/ads are created.
 *
 * @param {Object} plan - MediaPlan from generateMediaPlan()
 * @param {Object} creatives - Map of ad name → { url, image_hash }
 * @param {Object} [options]
 * @param {string} [options.link_url] - Default landing page URL
 * @param {Function} [options.onProgress]
 * @param {Object} [options.accountAssets]
 * @returns {Promise<Object>} Execution results
 */
export async function executeMediaPlanBatch(plan, creatives = {}, options = {}) {
  const onProgress = options.onProgress;
  const metaPlatform = plan.platforms?.find(p => p.platform === 'meta');
  if (!metaPlatform) {
    return { status: 'skipped', reason: 'No Meta platform in plan', campaigns: [], errors: [] };
  }

  onProgress?.({ step: 'batch_start' });

  // 1. Upload images that have URLs but no hash
  const needsUpload = Object.entries(creatives)
    .filter(([, c]) => c.url && !c.image_hash)
    .map(([name, c]) => ({ name, url: c.url }));

  const uploadedHashes = needsUpload.length > 0
    ? await uploadImages(needsUpload, { onProgress })
    : {};

  // 2. Merge pre-existing hashes with newly uploaded
  const allHashes = { ...uploadedHashes };
  for (const [name, c] of Object.entries(creatives)) {
    if (c.image_hash) allHashes[name] = c.image_hash;
  }

  const duration_days = plan.duration_days || 30;
  const link_url = options.link_url || 'https://revopanda.com';

  // 3. Create lead forms if any campaign uses lead_gen
  const campaigns = metaPlatform.campaigns || [];
  const hasLeadGen = campaigns.some(c => {
    const obj = OBJECTIVE_MAP[c.objective] || c.objective;
    return obj === 'OUTCOME_LEADS';
  });

  let lead_gen_form_id = null;
  if (hasLeadGen) {
    try {
      const formResult = await createLeadForm({
        name: `${metaPlatform.campaigns[0]?.name || 'Campaign'} Lead Form`,
        questions: [{ type: 'FULL_NAME' }, { type: 'EMAIL' }, { type: 'PHONE' }],
      });
      lead_gen_form_id = formResult.form_id;
    } catch (err) {
      // Non-fatal: continue without lead form
    }
  }

  // 4. Create each campaign
  const allCampaignResults = [];
  const allErrors = [];

  for (const campaign of campaigns) {
    // Enrich ads with image_hashes and lead_gen_form_id
    const enrichedAdSets = (campaign.ad_sets || []).map(adSet => ({
      ...adSet,
      ads: (adSet.ads || []).map(ad => ({
        ...ad,
        image_hash: allHashes[ad.name] || ad.image_hash,
        link_url: ad.link_url || link_url,
        lead_gen_form_id: lead_gen_form_id || ad.lead_gen_form_id,
      })),
    }));

    const result = await createFullCampaign(
      { ...campaign, duration_days, link_url, lead_gen_form_id, ad_sets: enrichedAdSets },
      { onProgress },
    );

    if (result.campaign_id) {
      allCampaignResults.push({
        id: result.campaign_id,
        name: campaign.name,
        ad_sets: result.ad_sets,
      });
    }
    allErrors.push(...result.errors);
  }

  onProgress?.({ step: 'batch_done' });

  const status = allErrors.length === 0
    ? 'completed'
    : allCampaignResults.length === 0
      ? 'failed'
      : 'partial';

  return {
    status,
    platform: 'meta',
    campaigns: allCampaignResults,
    errors: allErrors,
  };
}

export const executeMediaPlan = executeMediaPlanBatch;

// ── Main execution via Claude agent + MCP tools ─────────────────────

/**
 * Execute a media plan using a Claude agent that autonomously calls
 * MCP tools (Meta Ads API) to create campaigns, ad sets, and ads.
 *
 * @param {Object} plan - MediaPlan from generateMediaPlan()
 * @param {Object} creatives - Map of ad name → { url } (public image URLs)
 * @param {Object} [options]
 * @param {string} [options.link_url] - Default landing page URL
 * @returns {Promise<Object>} Execution results
 */
export async function executeMediaPlanMCP(plan, creatives = {}, options = {}) {
  const onProgress = options.onProgress;
  const metaPlatform = plan.platforms?.find(p => p.platform === 'meta');
  if (!metaPlatform) {
    return { status: 'skipped', reason: 'No Meta platform in plan', campaigns: [], errors: [] };
  }

  const accountId = `act_${config.meta?.adAccountId}`;
  const pageId = config.meta?.pageId;

  // 1. Get MCP tool definitions and filter to execution-relevant tools
  const allMcpTools = await listTools();
  const mcpTools = allMcpTools
    .filter(t => MCP_TOOL_ALLOWLIST.has(t.name))
    .map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));

  // 2. Combine MCP tools + custom tools
  const tools = [...mcpTools, CREATE_LEAD_FORM_TOOL, SUBMIT_EXECUTION_RESULT_TOOL];

  // 3. Build context for Claude
  const creativeSummary = Object.entries(creatives)
    .filter(([, c]) => !c.error && c.url)
    .map(([name, c]) => `- "${name}": ${c.url}`)
    .join('\n');

  // Account assets from orchestrator (WhatsApp numbers, IG accounts, etc.)
  const accountAssets = options.accountAssets;
  let assetsSection = '';
  if (accountAssets?.available) {
    const parts = [];
    if (accountAssets.whatsapp_phone_numbers?.length) {
      parts.push(`WhatsApp Phone Numbers:\n${accountAssets.whatsapp_phone_numbers.map(p => `  - ${p.display_phone_number} (ID: ${p.phone_number_id}, name: ${p.verified_name})`).join('\n')}`);
    }
    if (accountAssets.instagram_accounts?.length) {
      parts.push(`Instagram Accounts:\n${accountAssets.instagram_accounts.map(ig => `  - @${ig.username} (ID: ${ig.instagram_account_id})`).join('\n')}`);
    }
    if (parts.length) assetsSection = `\nACCOUNT ASSETS:\n${parts.join('\n')}\n`;
  }

  const messages = [{
    role: 'user',
    content: `Execute this media plan on Meta Ads. All entities must be PAUSED.

MEDIA PLAN:
${JSON.stringify(metaPlatform)}

DURATION: ${plan.duration_days || 30} days

CREATIVE ASSETS (image URLs to upload):
${creativeSummary || 'No creatives available — skip ad creation for ads without images.'}

DEFAULT LANDING URL: ${options.link_url || 'https://revopanda.com'}
${assetsSection}

Start by uploading the creative images, then create campaigns, ad sets, creatives, and ads. Call submit_execution_result when done.`,
  }];

  // 4. Claude agent loop
  let response = await anthropic.messages.create({
    model: MODELS.SONNET,
    max_tokens: 8192,
    system: buildExecutionPrompt(accountId, pageId),
    messages,
    tools,
    tool_choice: { type: 'auto' },
  });

  let toolCallCount = 0;
  let errorCount = 0;
  onProgress?.({ step: 'execution_start', detail: '开始执行 Meta 广告投放' });

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    if (response.stop_reason !== 'tool_use') break;

    const toolBlocks = response.content.filter(c => c.type === 'tool_use');
    messages.push({ role: 'assistant', content: response.content });

    // Check for submit_execution_result first
    const submitBlock = toolBlocks.find(t => t.name === 'submit_execution_result');
    if (submitBlock) {
      onProgress?.({ step: 'execution_done', detail: `投放执行完成：${toolCallCount} 次 API 调用${errorCount ? `，${errorCount} 个错误` : ''}`, tool_calls: toolCallCount, errors: errorCount });
      return { platform: 'meta', ...submitBlock.input };
    }

    // Execute all tool calls
    const toolResults = [];
    for (const block of toolBlocks) {
      toolCallCount++;
      onProgress?.({ step: 'tool_call', detail: `执行 ${block.name} (${toolCallCount})`, tool: block.name, iteration, tool_calls: toolCallCount });
      let result;
      try {
        if (block.name === 'create_lead_form') {
          result = await createLeadForm(block.input);
        } else {
          result = await callTool(block.name, block.input);
        }
      } catch (err) {
        errorCount++;
        result = { error: err.message };
        onProgress?.({ step: 'tool_error', detail: `✗ ${block.name} 失败: ${err.message}`, tool: block.name, error: err.message, tool_calls: toolCallCount, errors: errorCount });
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: 'user', content: toolResults });

    response = await anthropic.messages.create({
      model: MODELS.SONNET,
      max_tokens: 8192,
      system: buildExecutionPrompt(accountId, pageId),
      messages,
      tools,
      tool_choice: { type: 'auto' },
    });
  }

  // Force submit if Claude didn't call submit_execution_result
  messages.push({ role: 'assistant', content: response.content });

  // If the last response had tool_use blocks (e.g. loop hit MAX_TOOL_ITERATIONS),
  // we must provide tool_result for each before sending the next user message.
  const pendingToolUse = response.content.filter(c => c.type === 'tool_use');
  if (pendingToolUse.length > 0) {
    messages.push({
      role: 'user',
      content: [
        ...pendingToolUse.map(block => ({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({ skipped: 'Max iterations reached' }),
        })),
        { type: 'text', text: 'Max iterations reached. Please call submit_execution_result now with your results.' },
      ],
    });
  } else {
    messages.push({
      role: 'user',
      content: 'Please call submit_execution_result now with your results.',
    });
  }

  response = await anthropic.messages.create({
    model: MODELS.SONNET,
    max_tokens: 4096,
    system: buildExecutionPrompt(accountId, pageId),
    messages,
    tools,
    tool_choice: { type: 'tool', name: 'submit_execution_result' },
  });

  const forced = response.content.find(c => c.type === 'tool_use' && c.name === 'submit_execution_result');
  if (forced) {
    return { platform: 'meta', ...forced.input };
  }

  throw new Error('Execution agent did not produce results');
}

// ── Activate campaigns via MCP ──────────────────────────────────────

/**
 * Activate all PAUSED campaigns from execution results.
 * Called after user approves the plan.
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
      await callTool('update_campaign', { campaign_id: id, status: 'ACTIVE' });
      activated.push(id);
    } catch (err) {
      errors.push({ id, error: err.message });
    }
  }

  return { activated, errors };
}

// ── Preview (no API calls) ──────────────────────────────────────────

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
