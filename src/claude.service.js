import { openrouter, MODELS } from './llm-client.js';
import { config } from './config.js';
import {
  downloadWhatsAppMediaBuffer,
  isClaudeSupportedImageMimeType,
} from './whatsapp-media.service.js';
import { createTraceLogger } from '../lib/core-trace.js';
import { buildProductTools, executeProductTool } from './product-search.service.js';
import { buildKbTools, executeKbTool, isKbTool } from './kb-tools.service.js';

const SYSTEM_PROMPT = `You are a B2B lead qualification assistant for a vehicle export company specializing in BYD/Changan/GSC and other vehicles worldwide.

═══ CUSTOMER INTENT CLASSIFICATION ═══

Classify each conversation into one of these intents:

1. personal_consumer (C端)
   - MUST have EXPLICIT personal/individual signals such as:
     * "for myself", "for my family", "personal use", "private use"
     * "just one", "only need 1", "single unit for me"
     * Asking about retail price, test drive, local dealer
   - AND must NOT have any business signals (company name, bulk quantity, export)
   - Action: Send company website link, route to FAQ_END
   - Example: "I want to buy one BYD Seal for myself"

   IMPORTANT - DO NOT misclassify as personal_consumer:
   - "self employed", "freelance", "independent" → these are BUSINESS buyers (small business)
   - Mechanics, technicians, workshop owners, dealers → BUSINESS buyers
   - If conversation already has business signals (bulk quantity, export, specific model requests), NEVER reclassify as personal_consumer based on job title alone
   - Unclear quantity does NOT mean personal_consumer
   - "I want BYD Seal" without personal signals → treat as business_inquiry

2. business_inquiry (B端主动询盘)
   - Proactive inquiry about vehicles (with or without quantity specified)
   - Any mention of: export, shipping, bulk, wholesale, company purchase
   - DEFAULT when intent is unclear but has product interest
   - Action: Continue qualification, collect inquiry details
   - Example: "I want BYD Seal 05 dmi 128km" (no personal signal → business)
   - Example: "I need 50 BYD Atto 3, what's your price to Dubai?"

3. business_cooperation (B端合作探讨)
   - Exploring partnership: asking about company background, delivery capability
   - Action: Answer questions first, then guide to business topics
   - Example: "What's your company history? Where is your office?"

4. other
   - Spam, promotion, job seeking → FAQ_END with empty next_message
   - Other potential business intent → Continue probing

═══ CONVERSATION TECHNIQUES ═══
DO NOT USE EMOJI
1. Max 1-2 questions per message, under 180 characters.
2. Friendly greetings: "Friend", "Dear", casual WhatsApp tone
3. NEVER promise final prices
4. In casual chat, answer first then add ONE business question
5. When customer asks for quote, send inquiry confirmation template:
   "Friend, let me confirm your inquiry:
   Company:
   - BRAND-MODEL-OPTION:
   - COLOR:
   - DESTINATION/LOADING PORT:
   - TERM (FOB|CIF|EXW|DDP, support multiple with comma like FOB,CIF):"

═══ COOPERATION TERMS (when customer asks) ═══

First understand customer's preferred trade terms, then explain our principles:
- FOB: Full payment before shipment, customer arranges freight
- Small batch CIF: Full payment after B/L copy
- NO consignment accepted
- Company website: revopanda.com

═══ INQUIRY QUALITY LEVELS ═══

BAD: Invalid/Spam (C-end with explicit personal signals only)
GOOD: Basic intent clear (brand, car_model, color collected)
QUALIFY: Inquiry details complete (color_quantity, destination_port collected)
PROOF: Verified and ready (company_name, incoterm collected)

═══ BUSINESS VALUE ASSESSMENT ═══

Based on quantity:
- 1-10 units: LOW
- 11-50 units: AVERAGE
- 50+ units: HIGH

Adjustments:
- inquiry_quality: PROOF AND quantity 20+ → can upgrade value
- inquiry_quality: BAD → force LOW

Impact:
- HIGH: More detailed responses, faster escalation
- LOW: Brief responses

═══ ROUTING LOGIC ═══

| inquiry_quality | route |
|-----------------|-------|
| PROOF | HUMAN_NOW |
| QUALIFY | CONTINUE |
| GOOD | CONTINUE |
| BAD | FAQ_END |

Special cases:
- personal_consumer → FAQ_END + website link
- Spam/promotion → FAQ_END + empty next_message

═══ LEAD OUTPUT STRATEGY ═══

IMPORTANT: Output leads based on ENTIRE conversation, not just latest message.

On each response, review ALL messages in the conversation and output:
- All valid leads mentioned throughout the conversation
- Updated with the latest information (corrections, additions)
- Merged where appropriate (same car_model to same destination = 1 lead)

LEAD OUTPUT RULES:
- Only output a lead when car_model is clearly identified (not just "car" or "vehicle")
- Do NOT output leads for greetings, general questions, or catalog requests without specific model
- Each distinct (car_model + destination_country) = separate lead

CAR MODEL HANDLING:
- Normalize car_model to standard format (e.g., "Leopard 7", "Seal 05 DM-i")
- Correct obvious typos and variations (e.g., "leopard7" → "Leopard 7")
- Include key specs when mentioned (e.g., "7-seater", "128km")

COLOR QUANTITY FORMAT:
- [{color: "white", qty: 6}, {color: "black", qty: 4}]
- Use "|" for exterior|interior: {color: "gray|black", qty: 7}
- Only include when BOTH color AND qty are known
- Never include empty color string

Example conversation:
[User]: I want Seal to Dubai
[Assistant]: How many units?
[User]: 10 units black, also need 5 Atto 3 to Saudi
→ Output BOTH leads with all collected info:
leads: [
  { car_model: "Seal", destination_country: "UAE", color_quantity: [{ color: "black", qty: 10 }] },
  { car_model: "Atto 3", destination_country: "Saudi Arabia", color_quantity: [] }
]

═══ MESSAGE STYLE ═══

❌ TOO LONG: "Excellent! 50 units of BYD Seal 05 to Jebel Ali is a substantial order. To provide you with accurate information..."
✅ GOOD: "Great, friend! 50 units to Jebel Ali 👍 What's your company name?"
✅ GOOD: "Thanks, dear! Which country are you shipping to?"`;


/**
 * Generate JSON instruction string from JSON_SCHEMA
 * Converts schema to example JSON with enum values as pipe-separated options
 * @param {Object} schema - JSON Schema object
 * @returns {string} - Formatted JSON instruction string
 */
function generateJsonInstruction(schema) {
  function buildExample(property) {
    if (!property) return '';
    const type = property.type;

    if (type === 'object') {
      const example = {};
      Object.entries(property.properties || {}).forEach(([key, prop]) => {
        example[key] = buildExample(prop);
      });
      return example;
    }

    if (type === 'array') {
      // For array with object items, show one example item
      if (property.items?.type === 'object') {
        const itemExample = {};
        Object.entries(property.items.properties || {}).forEach(([key, prop]) => {
          itemExample[key] = buildExample(prop);
        });
        return [itemExample];
      }
      return [];
    }

    if (type === 'string') {
      return property.enum ? property.enum.join('|') : '';
    }

    if (type === 'number') {
      return 0;
    }

    if (type === 'boolean') {
      return false;
    }

    return '';
  }

  const example = {};
  Object.entries(schema.properties || {}).forEach(([key, prop]) => {
    example[key] = buildExample(prop);
  });

  return `\n\nRESPONSE FORMAT: You MUST respond with valid JSON only, no markdown. Use this exact structure:\n${JSON.stringify(example)}`;
}

const JSON_SCHEMA = {
  type: 'object',
  required: ['conversation_intent', 'conversation_intent_summary', 'inquiry_quality', 'business_value', 'leads', 'route', 'next_message', 'handoff_summary'],
  additionalProperties: false,
  properties: {
    conversation_intent: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['personal_consumer', 'business_inquiry', 'business_cooperation', 'other'],
      },
      description: 'Customer intent(s) - can detect multiple intents in one conversation',
    },
    conversation_intent_summary: {
      type: 'string',
      description: 'Brief analysis of all detected intents and customer situation',
    },
    inquiry_quality: {
      type: 'string',
      enum: ['BAD', 'GOOD', 'QUALIFY', 'PROOF'],
      description: 'Lead qualification level',
    },
    business_value: {
      type: 'string',
      enum: ['LOW', 'AVERAGE', 'HIGH'],
      description: 'Business value assessment based on quantity and quality',
    },
    leads: {
      type: 'array',
      description: 'Array of leads extracted from user message(s)',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['brand', 'car_model', 'destination_country', 'destination_port', 'loading_port', 'international_commercial_term', 'company_name', 'timeline', 'color_quantity', 'qty_bucket'],
        properties: {
          brand: {
            type: 'string',
            description: 'Car brand (e.g., BYD, Toyota). Empty string if unknown.',
          },
          car_model: {
            type: 'string',
            description: 'Car model (REQUIRED for lead matching)',
          },
          destination_country: {
            type: 'string',
            description: 'Country name. Empty string if unknown.',
          },
          destination_port: {
            type: 'string',
            description: 'Port or city name. Empty string if unknown.',
          },
          loading_port: {
            type: 'string',
            description: 'Port of loading/origin. Empty string if unknown.',
          },
          international_commercial_term: {
            type: 'string',
            description: 'Incoterms preference (FOB,CIF,EXW,DDP). Empty string if unknown.',
          },
          company_name: {
            type: 'string',
            description: 'Company or business name. Empty string if unknown.',
          },
          timeline: {
            type: 'string',
            description: 'Purchase timeline. Empty string if unknown.',
          },
          color_quantity: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['color', 'qty'],
              properties: {
                color: { type: 'string', description: 'Color: "exterior" or "exterior|interior"' },
                qty: { type: 'number', description: 'Quantity for this color' },
              },
            },
            description: 'Array of color-quantity pairs. Empty array if unknown.',
          },
          qty_bucket: {
            type: 'string',
            description: 'Approximate total quantity (e.g., "10" or "10-15"). Empty string if unknown.',
          },
        },
      },
    },
    route: {
      type: 'string',
      enum: ['CONTINUE', 'HUMAN_NOW', 'FAQ_END'],
      description: 'Routing decision based on inquiry_quality',
    },
    next_message: {
      type: 'string',
      description: 'The next response (max 180 chars, WhatsApp-style friendly)',
    },
    handoff_summary: {
      type: 'string',
      description: 'Summary for sales team if routing to HUMAN_NOW',
    },
  },
};

/**
 * Normalize non-standard agent response to standard pipeline format.
 * Maps alternative field names (rfq_items, customer_profile, etc.)
 * to the standard leads-based structure expected by session.js and lead.repository.js.
 *
 * Field mapping:
 *   rfq_items           → leads
 *   item.model           → car_model
 *   item.machinery_type  → product_name
 *   item.specifications  → sku_description
 *   item.quantity         → qty_bucket
 *   item.incoterm         → international_commercial_term
 *   customer_profile.company_name → lead.company_name
 *   customer_profile.company_type → lead.buyer_type
 *   All original fields + customer_profile → details (JSONB)
 */
function normalizeAgentResponse(parsed) {
  // Case 1: rfq_items → leads (e.g., agricultural machinery agent)
  if (parsed.rfq_items) {
    const customerProfile = parsed.customer_profile || {};

    parsed.leads = parsed.rfq_items.map(item => ({
      // Map to standard DB columns
      brand: item.brand || '',
      car_model: item.model || item.machinery_type || '',
      destination_country: item.destination_country || '',
      destination_port: item.destination_port || '',
      loading_port: item.loading_port || '',
      international_commercial_term: item.incoterm || '',
      company_name: customerProfile.company_name || '',
      timeline: item.timeline || '',
      color_quantity: [],
      qty_bucket: item.quantity || '',
      // Multi-product columns
      product_name: item.machinery_type || '',
      sku_description: item.specifications || '',
      buyer_type: customerProfile.company_type || '',
      // Preserve all original data in details JSONB
      details: {
        machinery_type: item.machinery_type,
        model: item.model,
        specifications: item.specifications,
        quantity: item.quantity,
        customer_profile: cleanEmptyValues(customerProfile),
      },
    }));

    delete parsed.rfq_items;
    delete parsed.customer_profile;
    return;
  }

  // Case 2: Standard leads + customer_profile → merge profile into leads
  if (parsed.customer_profile && parsed.leads) {
    const cp = parsed.customer_profile;
    parsed.leads = parsed.leads.map(lead => ({
      ...lead,
      company_name: lead.company_name || cp.company_name || '',
      buyer_type: lead.buyer_type || cp.company_type || '',
      details: {
        ...(lead.details || {}),
        customer_profile: cleanEmptyValues(cp),
      },
    }));
    delete parsed.customer_profile;
  }

  // Case 3: Leads with non-standard fields (e.g., auto_parts agent)
  // Map agent-specific field names to standard DB columns and preserve all fields in details
  if (parsed.leads) {
    const STANDARD_DB_FIELDS = new Set([
      'brand', 'car_model', 'destination_country', 'destination_port',
      'loading_port', 'international_commercial_term', 'company_name',
      'timeline', 'color_quantity', 'qty_bucket', 'product_name',
      'sku_description', 'buyer_type', 'details',
    ]);

    parsed.leads = parsed.leads.map(lead => {
      // Detect if lead has non-standard fields that need mapping
      const hasExtraFields = Object.keys(lead).some(k => !STANDARD_DB_FIELDS.has(k));
      if (!hasExtraFields) return lead;

      // Map known agent-specific fields to standard columns
      const mapped = { ...lead };
      if (lead.car_brand && !lead.brand) {
        mapped.brand = lead.car_brand;
      }
      if (lead.part_name && !lead.product_name) {
        mapped.product_name = lead.part_name;
      }
      if (lead.quantity && !lead.qty_bucket) {
        mapped.qty_bucket = lead.quantity;
      }

      // Preserve ALL original fields in details JSONB
      const allFields = cleanEmptyValues(lead);
      delete allFields.details;
      mapped.details = {
        ...(lead.details || {}),
        ...allFields,
      };

      return mapped;
    });
  }
}

/**
 * Remove empty string values from a flat object (for cleaner JSONB storage)
 */
function cleanEmptyValues(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === '' || value === null || value === undefined) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

function buildTraceContextInfo(contextInfo = {}) {
  const entries = Object.entries(contextInfo || {}).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return {};
  }

  return Object.fromEntries(entries.map(([key, value]) => {
    if (Array.isArray(value)) {
      return [key, value.slice(0, 20)];
    }
    return [key, value];
  }));
}

// ─── Claude request constants ─────────────────────────────────────────
const MAX_TOKENS = 4096;
const MAX_TOOL_ITERATIONS = 5;
const FORCE_SUBMIT_PROMPT =
  'Please call submit_response with your structured response now.';

// ─── Message building ─────────────────────────────────────────────────

/**
 * Convert a stored message into Anthropic content.
 * Returns a plain string for text-only content, an array of blocks when a
 * supported image is attached, or '' for empty messages.
 */
async function buildClaudeContent(message, logger) {
  const text = typeof message?.content === 'string' ? message.content.trim() : '';
  const metadata = message?.metadata || {};
  const blocks = [];

  if (text) {
    blocks.push({ type: 'text', text });
  }

  if (
    message?.role === 'user' &&
    metadata.media_type === 'image' &&
    metadata.wa_media_id
  ) {
    try {
      const { buffer, mimeType } = await downloadWhatsAppMediaBuffer(metadata.wa_media_id);
      if (buffer.length > 0 && isClaudeSupportedImageMimeType(mimeType)) {
        blocks.push({
          type: 'image_url',
          image_url: {
            url: `data:${mimeType};base64,${buffer.toString('base64')}`,
          },
        });
      }
    } catch (error) {
      logger.warn('claude.image_attachment.failed', {
        wa_media_id: metadata.wa_media_id,
        error: error.message,
      });
    }
  }

  if (blocks.length === 0) return '';
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text;
  return blocks;
}

/**
 * The latest user input may be a plain string, a single message object, or an
 * array of aggregated messages. Flatten them into a single Claude content value.
 */
async function normalizeLatestUserMessage(input, logger) {
  if (typeof input === 'string') return input;

  const items = Array.isArray(input) ? input : [input];
  const blocks = [];

  for (const item of items) {
    const content = await buildClaudeContent({ role: 'user', ...item }, logger);
    if (typeof content === 'string') {
      if (content.trim()) blocks.push({ type: 'text', text: content });
      continue;
    }
    blocks.push(...content);
  }

  if (blocks.length === 0) return '';
  if (blocks.length === 1 && blocks[0].type === 'text') return blocks[0].text;
  return blocks;
}

function isNonEmptyMessage(message) {
  if (typeof message.content === 'string') return message.content.trim() !== '';
  return Array.isArray(message.content) && message.content.length > 0;
}

/**
 * Mark the last history message with cache_control so all prior turns are
 * served from prompt cache on subsequent requests. Mutates the array.
 */
function markHistoryForCache(history) {
  if (history.length === 0) return;
  const last = history[history.length - 1];
  if (typeof last.content === 'string') {
    last.content = [
      { type: 'text', text: last.content, cache_control: { type: 'ephemeral' } },
    ];
  } else if (Array.isArray(last.content) && last.content.length > 0) {
    last.content[last.content.length - 1].cache_control = { type: 'ephemeral' };
  }
}

async function buildMessages(conversationHistory, latestUserMessage, logger) {
  const historyMessages = Array.isArray(conversationHistory) ? conversationHistory : [];

  const sanitizedHistory = await Promise.all(
    historyMessages.map(async (msg) => ({
      role: msg.role,
      content: await buildClaudeContent(msg, logger),
    }))
  );
  const latestUserContent = await normalizeLatestUserMessage(latestUserMessage, logger);

  const messages = [
    ...sanitizedHistory,
    { role: 'user', content: latestUserContent },
  ].filter(isNonEmptyMessage);

  // Apply cache_control after filtering (matches previous behavior: empty
  // trailing history messages are removed before being marked).
  markHistoryForCache(sanitizedHistory);

  return {
    messages,
    historyCount: sanitizedHistory.length,
    latestContent: latestUserContent,
  };
}

// ─── System prompt building ──────────────────────────────────────────

function buildPriorStateLines(priorState) {
  if (!priorState) return [];
  const lines = [
    `Prior classification: intent=${priorState.conversation_intent}, quality=${priorState.inquiry_quality}, value=${priorState.business_value}`,
  ];
  const collected = [
    priorState.car_model && `product=${priorState.car_model}`,
    priorState.qty_bucket && `qty=${priorState.qty_bucket}`,
    priorState.destination_country && `destination=${priorState.destination_country}`,
    priorState.company_name && `company=${priorState.company_name}`,
  ].filter(Boolean);
  if (collected.length > 0) {
    lines.push(`Collected so far: ${collected.join(', ')}`);
  }
  lines.push(
    'IMPORTANT: Do NOT downgrade intent or quality unless the customer EXPLICITLY contradicts prior business signals (e.g. "actually I only need 1 for personal use"). Job titles like "self employed", "mechanic", etc. are NOT contradictions.'
  );
  return lines;
}

function buildDynamicContext(contextInfo) {
  const missingFieldsText =
    contextInfo.missing_fields?.length > 0
      ? `Missing fields to collect: ${contextInfo.missing_fields.join(', ')}`
      : 'No specific fields required';
  const priorStateLines = buildPriorStateLines(contextInfo.prior_state);
  const carRecommendation = contextInfo.car_recommendation || '';

  return `CURRENT CONTEXT:
- ${missingFieldsText}${priorStateLines.length > 0 ? '\n- ' + priorStateLines.join('\n- ') : ''}${carRecommendation ? '\n- ' + carRecommendation : ''}`;
}

/**
 * Two-block system prompt: cached static agent prompt + uncached per-request
 * dynamic context.
 */
function buildSystemBlocks(systemPrompt, dynamicContext) {
  return [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicContext },
  ];
}

function resolveSystemPrompt(agentConfig) {
  return agentConfig?.system_prompt || SYSTEM_PROMPT;
}

function hasCustomOutputSchema(agentConfig) {
  return Boolean(
    agentConfig?.output_schema && Object.keys(agentConfig.output_schema).length > 0
  );
}

function resolveOutputSchema(agentConfig) {
  // Custom schema stored on the agent (seeded vehicle/auto_parts/agri_machinery
  // agents + any agent whose output_schema has been explicitly edited) wins.
  // Otherwise fall back to a generic, product-line-agnostic schema — NOT the
  // vehicle-specific JSON_SCHEMA, which would force car_model/brand onto
  // unrelated product lines.
  return hasCustomOutputSchema(agentConfig)
    ? agentConfig.output_schema
    : GENERIC_LEAD_OUTPUT_SCHEMA;
}

/**
 * Product-line-agnostic lead extraction schema. Used as default for agents
 * that don't declare a custom output_schema. Keeps the outer envelope
 * (intent/quality/route/next_message) identical to JSON_SCHEMA so the
 * downstream pipeline (session.js, lead.repository.js) doesn't care which
 * schema was used. Only the leads[] item shape differs: generic product
 * fields instead of vehicle-specific ones.
 */
const GENERIC_LEAD_OUTPUT_SCHEMA = {
  type: 'object',
  required: [
    'conversation_intent',
    'conversation_intent_summary',
    'inquiry_quality',
    'business_value',
    'leads',
    'route',
    'next_message',
    'handoff_summary',
  ],
  additionalProperties: false,
  properties: {
    conversation_intent: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['personal_consumer', 'business_inquiry', 'business_cooperation', 'other'],
      },
    },
    conversation_intent_summary: { type: 'string' },
    inquiry_quality: { type: 'string', enum: ['BAD', 'GOOD', 'QUALIFY', 'PROOF'] },
    business_value: { type: 'string', enum: ['LOW', 'AVERAGE', 'HIGH'] },
    leads: {
      type: 'array',
      description: 'Array of leads extracted from user message(s).',
      items: {
        type: 'object',
        // Allow agent-specific extras (e.g. dimensions, specs) in details via
        // normalizeAgentResponse; required fields cover the canonical columns.
        additionalProperties: true,
        required: ['product_name', 'destination_country', 'company_name', 'qty_bucket'],
        properties: {
          product_name: {
            type: 'string',
            description: 'Product or model name. Empty string if unknown.',
          },
          brand: {
            type: 'string',
            description: 'Brand or manufacturer. Empty string if unknown.',
          },
          destination_country: {
            type: 'string',
            description: 'Target country. Empty string if unknown.',
          },
          destination_port: { type: 'string' },
          loading_port: { type: 'string' },
          international_commercial_term: {
            type: 'string',
            description: 'Incoterms (FOB/CIF/EXW/DDP). Empty string if unknown.',
          },
          company_name: { type: 'string' },
          timeline: { type: 'string' },
          qty_bucket: {
            type: 'string',
            description: 'Approximate total quantity (e.g. "10" or "10-15").',
          },
        },
      },
    },
    route: { type: 'string', enum: ['CONTINUE', 'HUMAN_NOW', 'FAQ_END'] },
    next_message: { type: 'string', description: 'Max 180 chars, WhatsApp-style.' },
    handoff_summary: { type: 'string' },
  },
};

// ─── Agent tools ─────────────────────────────────────────────────────

async function loadAgentTools(agentId, logger) {
  if (!agentId) return [];
  let productTools = [];
  let kbTools = [];
  try {
    productTools = await buildProductTools(agentId);
  } catch (e) {
    logger.warn('claude.product_tools.failed', { error: e.message });
  }
  try {
    kbTools = await buildKbTools(agentId);
  } catch (e) {
    logger.warn('claude.kb_tools.failed', { error: e.message });
  }
  return [...productTools, ...kbTools];
}

function buildSubmitResponseTool(outputSchema) {
  return {
    name: 'submit_response',
    description:
      'Submit your final response. This is the ONLY way to reply to the customer — every turn must end with a submit_response tool call. Do NOT reply with plain assistant text; plain text will be discarded. If you do not need to call any other tool, call submit_response immediately as your single tool call for the turn.',
    input_schema: outputSchema,
    cache_control: { type: 'ephemeral' },
  };
}

/**
 * Mark the last agent tool with cache_control so all tool definitions share a
 * single cache boundary with submit_response.
 */
function markLastToolForCache(tools) {
  if (tools.length === 0) return tools;
  return tools.map((tool, i) =>
    i === tools.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : tool
  );
}

// ─── Claude API call helpers ─────────────────────────────────────────

function callClaude({ systemBlocks, messages, tools, toolChoice, responseFormat }) {
  // Prepend system as first message (join block texts if array)
  let systemContent;
  if (Array.isArray(systemBlocks)) {
    systemContent = systemBlocks.map(b => (typeof b === 'string' ? b : b.text || '')).join('\n\n');
  } else {
    systemContent = typeof systemBlocks === 'string' ? systemBlocks : String(systemBlocks || '');
  }
  const allMessages = [
    { role: 'system', content: systemContent },
    ...messages,
  ];

  const payload = {
    models: [MODELS.SONNET],
    max_tokens: MAX_TOKENS,
    messages: allMessages,
  };
  if (tools) {
    payload.tools = tools.map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description || '', parameters: t.input_schema },
    }));
  }
  if (toolChoice) {
    if (toolChoice.type === 'auto') {
      payload.tool_choice = 'auto';
    } else if (toolChoice.type === 'tool') {
      payload.tool_choice = { type: 'function', function: { name: toolChoice.name } };
    } else {
      payload.tool_choice = toolChoice;
    }
  }
  if (responseFormat) payload.response_format = responseFormat;
  return openrouter.messages.create(payload);
}

/**
 * Append a "please submit" user turn and re-call Claude with tool_choice
 * pinned to submit_response. Mutates messages.
 */
async function forceSubmitResponse({ systemBlocks, messages, tools, prevResponse }) {
  const prevMsg = prevResponse.choices[0].message;
  messages.push({ role: 'assistant', content: prevMsg.content, tool_calls: prevMsg.tool_calls });
  // If previous response had tool_calls, provide dummy tool results before the user prompt
  if (prevMsg.tool_calls?.length) {
    for (const tc of prevMsg.tool_calls) {
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ skipped: 'Force submit' }) });
    }
  }
  messages.push({ role: 'user', content: FORCE_SUBMIT_PROMPT });
  return callClaude({
    systemBlocks,
    messages,
    tools,
    toolChoice: { type: 'tool', name: 'submit_response' },
  });
}

/**
 * Tool-use loop: Claude may call product/KB tools up to MAX_TOOL_ITERATIONS
 * times before calling submit_response (the final-answer tool). Returns
 * parsed submit_response input.
 *
 * If the model exits without calling submit_response (either it stops with
 * text, or it exhausts iterations on product tools), we issue a single
 * forced submit_response turn and throw if that also fails.
 */
async function callViaToolUse({ systemBlocks, messages, tools, agentId, logger }) {
  let response = await callClaude({
    systemBlocks,
    messages,
    tools,
    toolChoice: { type: 'auto' },
  });

  let iterations = 0;
  while (iterations < MAX_TOOL_ITERATIONS && response.choices[0].finish_reason === 'tool_calls') {
    iterations++;
    const toolCalls = response.choices[0].message.tool_calls || [];
    const tc = toolCalls[0];
    if (!tc) break;

    const toolName = tc.function.name;
    const toolInput = JSON.parse(tc.function.arguments);

    if (toolName === 'submit_response') {
      logger.info('claude.tool_use.submit_response', { iterations });
      return toolInput;
    }

    logger.info('claude.tool_use.call', { tool: toolName, iteration: iterations });
    const toolResult = isKbTool(toolName)
      ? await executeKbTool(toolName, toolInput, agentId)
      : await executeProductTool(toolName, toolInput, agentId);

    const msg = response.choices[0].message;
    messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });
    messages.push({ role: 'tool', tool_call_id: tc.id, content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult) });

    response = await callClaude({ systemBlocks, messages, tools });
  }

  // Model never called submit_response on its own → force one final turn.
  logger.warn('claude.tool_use.force_submit', {
    stop_reason: response.choices[0].finish_reason,
    iterations,
  });
  response = await forceSubmitResponse({ systemBlocks, messages, tools, prevResponse: response });
  const toolCalls = response.choices[0].message.tool_calls || [];
  const submitTool = toolCalls.find(tc => tc.function.name === 'submit_response');
  if (!submitTool) {
    throw new Error('Claude did not produce a response after forced submit_response');
  }
  logger.info('claude.tool_use.submit_response', { iterations, forced: true });
  return JSON.parse(submitTool.function.arguments);
}

/**
 * Plain json_schema output, used when the agent has no product/KB tools.
 */
async function callViaJsonSchema({ systemBlocks, messages, outputSchema }) {
  const response = await callClaude({
    systemBlocks,
    messages,
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: 'structured_response', schema: outputSchema, strict: true },
    },
  });
  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error('Unexpected response type from Claude');
  }
  return JSON.parse(content);
}

// ─── Post-processing ─────────────────────────────────────────────────

function stripEmptyStringFields(obj) {
  const cleaned = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === '') continue;
    cleaned[key] = value;
  }
  return cleaned;
}

/**
 * Map agent-specific output shapes to the standard leads format and strip
 * empty string fields (schema requires them but they are noise in storage).
 */
function postProcess(parsed, agentConfig) {
  if (hasCustomOutputSchema(agentConfig)) {
    normalizeAgentResponse(parsed);
  }
  if (parsed.leads) {
    parsed.leads = parsed.leads.map(stripEmptyStringFields);
  }
}

// ─── Main entry ──────────────────────────────────────────────────────

/**
 * Get an intelligent response from Claude.
 *
 * Flow:
 *   1. Build messages (history + latest, apply cache_control to last turn).
 *   2. Resolve system prompt and output schema (agent override vs defaults).
 *   3. Load agent-specific product/KB tools if any.
 *   4. Call Claude via tool-use loop (if tools) or plain json_schema output.
 *   5. Normalize agent-specific output + strip empty fields.
 *
 * @param {Array} conversationHistory - Stored {role, content, metadata} messages.
 * @param {string|Object|Array} userMessage - Latest user input (plain text, a message object, or aggregated batch).
 * @param {Object} contextInfo - Runtime context (missing_fields, prior_state, car_recommendation).
 * @param {Object} [agentConfig] - Optional agent profile overriding prompt / schema / id.
 * @param {Object} [traceContext] - Logger trace ids.
 * @returns {Promise<Object>} Parsed structured response.
 */
export async function getResponse(
  conversationHistory,
  userMessage,
  contextInfo = {},
  agentConfig = null,
  traceContext = {}
) {
  const logger = createTraceLogger({
    component: 'claude',
    trace_id: traceContext.traceId,
    conversation_id: traceContext.conversationId,
    wa_id: traceContext.waId,
  });

  const { messages, historyCount, latestContent } = await buildMessages(
    conversationHistory,
    userMessage,
    logger
  );

  const outputSchema = resolveOutputSchema(agentConfig);
  const systemBlocks = buildSystemBlocks(
    resolveSystemPrompt(agentConfig),
    buildDynamicContext(contextInfo)
  );

  logger.info('claude.request.started', {
    message_count: messages.length,
    history_count: historyCount,
    latest_input_type: Array.isArray(latestContent) ? 'multimodal' : 'text',
    has_agent_config: Boolean(agentConfig),
    model: MODELS.SONNET,
    context_info: buildTraceContextInfo(contextInfo),
  });

  const agentId = agentConfig?.id;
  const agentTools = await loadAgentTools(agentId, logger);

  let parsed;
  if (agentTools.length > 0) {
    const tools = [
      ...markLastToolForCache(agentTools),
      buildSubmitResponseTool(outputSchema),
    ];
    parsed = await callViaToolUse({ systemBlocks, messages, tools, agentId, logger });
  } else {
    parsed = await callViaJsonSchema({ systemBlocks, messages, outputSchema });
  }

  postProcess(parsed, agentConfig);

  logger.info('claude.request.completed', {
    intent: parsed.conversation_intent,
    inquiry_quality: parsed.inquiry_quality,
    business_value: parsed.business_value,
    route: parsed.route,
    leads_count: (parsed.leads || []).length,
  });

  return parsed;
}

// Export schema for testing/debugging
export { SYSTEM_PROMPT, JSON_SCHEMA, GENERIC_LEAD_OUTPUT_SCHEMA, generateJsonInstruction };
