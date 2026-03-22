import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import {
  downloadWhatsAppMediaBuffer,
  isClaudeSupportedImageMimeType,
} from './whatsapp-media.service.js';
import { createTraceLogger } from '../lib/core-trace.js';
import { buildProductTools, executeProductTool } from './product-search.service.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL && { baseURL: config.anthropic.baseURL }),
});

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

/**
 * Get an intelligent response from Claude
 * @param {Array} conversationHistory - Array of {role, content, metadata} message objects
 * @param {string|Object|Array} userMessage - The latest user message or multimodal message batch
 * @param {Object} contextInfo - Context information (missing_fields)
 * @returns {Promise<Object>} - Parsed JSON response
 */
export async function getResponse(conversationHistory, userMessage, contextInfo = {}, agentConfig = null, traceContext = {}) {
  const logger = createTraceLogger({
    component: 'claude',
    trace_id: traceContext.traceId,
    conversation_id: traceContext.conversationId,
    wa_id: traceContext.waId,
  });
  const historyMessages = Array.isArray(conversationHistory) ? conversationHistory : [];

  async function buildClaudeContent(message) {
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
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType,
              data: buffer.toString('base64'),
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

    if (blocks.length === 0) {
      return '';
    }

    if (blocks.length === 1 && blocks[0].type === 'text') {
      return blocks[0].text;
    }

    return blocks;
  }

  async function normalizeLatestUserMessage(input) {
    if (typeof input === 'string') {
      return input;
    }

    const items = Array.isArray(input) ? input : [input];
    const blocks = [];

    for (const item of items) {
      const content = await buildClaudeContent({ role: 'user', ...item });
      if (typeof content === 'string') {
        if (content.trim()) {
          blocks.push({ type: 'text', text: content });
        }
        continue;
      }
      blocks.push(...content);
    }

    if (blocks.length === 0) {
      return '';
    }

    if (blocks.length === 1 && blocks[0].type === 'text') {
      return blocks[0].text;
    }

    return blocks;
  }

  const sanitizedHistory = await Promise.all(
    historyMessages.map(async (msg) => ({
      role: msg.role,
      content: await buildClaudeContent(msg),
    }))
  );
  const latestUserContent = await normalizeLatestUserMessage(userMessage);

  // Build messages array with conversation history + new user message
  const messages = [
    ...sanitizedHistory,
    {
      role: 'user',
      content: latestUserContent,
    },
  ].filter((message) => {
    if (typeof message.content === 'string') {
      return message.content.trim() !== '';
    }
    return Array.isArray(message.content) && message.content.length > 0;
  });

  // Use agent config if provided, otherwise fall back to hardcoded defaults
  const systemPrompt = agentConfig?.system_prompt || SYSTEM_PROMPT;
  const outputSchema = agentConfig?.output_schema && Object.keys(agentConfig.output_schema).length > 0
    ? agentConfig.output_schema
    : JSON_SCHEMA;

  // Build enhanced system prompt with context
  const missingFieldsText = contextInfo.missing_fields?.length > 0
    ? `Missing fields to collect: ${contextInfo.missing_fields.join(', ')}`
    : 'No specific fields required';

  const priorState = contextInfo.prior_state;
  const priorStateLines = [];
  if (priorState) {
    priorStateLines.push(`Prior classification: intent=${priorState.conversation_intent}, quality=${priorState.inquiry_quality}, value=${priorState.business_value}`);
    const collected = [
      priorState.car_model && `product=${priorState.car_model}`,
      priorState.qty_bucket && `qty=${priorState.qty_bucket}`,
      priorState.destination_country && `destination=${priorState.destination_country}`,
      priorState.company_name && `company=${priorState.company_name}`,
    ].filter(Boolean);
    if (collected.length > 0) {
      priorStateLines.push(`Collected so far: ${collected.join(', ')}`);
    }
    priorStateLines.push('IMPORTANT: Do NOT downgrade intent or quality unless the customer EXPLICITLY contradicts prior business signals (e.g. "actually I only need 1 for personal use"). Job titles like "self employed", "mechanic", etc. are NOT contradictions.');
  }

  const carRecommendation = contextInfo.car_recommendation || '';

  const dynamicContext = `CURRENT CONTEXT:
- ${missingFieldsText}${priorStateLines.length > 0 ? '\n- ' + priorStateLines.join('\n- ') : ''}${carRecommendation ? '\n- ' + carRecommendation : ''}`;

  // Split system prompt into static (cached) + dynamic (uncached) blocks
  const systemBlocks = [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: { type: 'ephemeral' },
    },
    {
      type: 'text',
      text: dynamicContext,
    },
  ];

  // Cache conversation history: mark the last history message so all prior
  // turns are served from cache on subsequent requests
  if (sanitizedHistory.length > 0) {
    const lastMsg = sanitizedHistory[sanitizedHistory.length - 1];
    if (typeof lastMsg.content === 'string') {
      lastMsg.content = [
        { type: 'text', text: lastMsg.content, cache_control: { type: 'ephemeral' } },
      ];
    } else if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
      lastMsg.content[lastMsg.content.length - 1].cache_control = { type: 'ephemeral' };
    }
  }

  logger.info('claude.request.started', {
    message_count: messages.length,
    history_count: sanitizedHistory.length,
    latest_input_type: Array.isArray(latestUserContent) ? 'multimodal' : 'text',
    has_agent_config: Boolean(agentConfig),
    model: config.anthropic.model,
    context_info: buildTraceContextInfo(contextInfo),
  });

  // Check if this agent has product knowledge tools
  const agentId = agentConfig?.id;
  let productTools = [];
  if (agentId) {
    try {
      productTools = await buildProductTools(agentId);
    } catch (e) {
      logger.warn('claude.product_tools.failed', { error: e.message });
    }
  }

  const hasProductTools = productTools.length > 0;
  let parsed;

  if (hasProductTools) {
    // Tool-use mode: product tools + submit_response tool
    // TODO: switch to programmatic tool calling (code_execution_20260120) when OpenRouter supports it
    const submitResponseTool = {
      name: 'submit_response',
      description: 'Submit your final response. Call this after gathering any needed product information. You MUST call this tool as your final action.',
      input_schema: outputSchema,
      cache_control: { type: 'ephemeral' },
    };
    // Add cache_control to the last product tool so all tool definitions are cached together
    const cachedProductTools = productTools.map((tool, i) =>
      i === productTools.length - 1
        ? { ...tool, cache_control: { type: 'ephemeral' } }
        : tool
    );
    const allTools = [...cachedProductTools, submitResponseTool];

    let response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: systemBlocks,
      messages: messages,
      tools: allTools,
      tool_choice: { type: 'auto' },
    });

    // Tool-use loop (max 5 iterations to prevent runaway)
    let iterations = 0;
    while (iterations < 5) {
      // If Claude stopped without calling any tool, force submit_response
      if (response.stop_reason !== 'tool_use') {
        logger.info('claude.tool_use.force_submit', { stop_reason: response.stop_reason });
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: 'Please call submit_response with your structured response now.' });
        response = await anthropic.messages.create({
          model: config.anthropic.model,
          max_tokens: 4096,
          system: systemBlocks,
          messages: messages,
          tools: allTools,
          tool_choice: { type: 'tool', name: 'submit_response' },
        });
      }
      if (response.stop_reason !== 'tool_use') break;
      iterations++;
      const toolUse = response.content.find(c => c.type === 'tool_use');

      // submit_response = final answer
      if (toolUse.name === 'submit_response') {
        parsed = toolUse.input;
        logger.info('claude.tool_use.submit_response', { iterations });
        break;
      }

      // Execute product tool
      logger.info('claude.tool_use.call', {
        tool: toolUse.name,
        iteration: iterations,
      });
      const toolResult = await executeProductTool(toolUse.name, toolUse.input, agentId);
      messages.push({ role: 'assistant', content: response.content });
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: toolResult }],
      });
      response = await anthropic.messages.create({
        model: config.anthropic.model,
        max_tokens: 4096,
        system: systemBlocks,
        messages: messages,
        tools: allTools,
      });
    }

    // Fallback: if Claude ended without submit_response, extract text
    if (!parsed) {
      const textBlock = response.content.find(c => c.type === 'text');
      if (textBlock) {
        parsed = JSON.parse(textBlock.text);
      } else {
        throw new Error('Claude did not produce a response');
      }
    }
  } else {
    // Standard mode: json_schema output (no product tools)
    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 4096,
      system: systemBlocks,
      messages: messages,
      output_config: {
        format: {
          type: 'json_schema',
          schema: outputSchema,
        },
      },
    });

    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude');
    }
    parsed = JSON.parse(content.text);
  }

  // Normalize non-standard agent output to standard pipeline format
  if (agentConfig?.output_schema && Object.keys(agentConfig.output_schema).length > 0) {
    normalizeAgentResponse(parsed);
  }

  // Clean up empty strings from structured output (required fields output "" when unknown)
  if (parsed.leads) {
    parsed.leads = parsed.leads.map(lead => {
      const cleaned = {};
      for (const [key, value] of Object.entries(lead)) {
        if (value === '') continue;
        cleaned[key] = value;
      }
      return cleaned;
    });
  }

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
export { SYSTEM_PROMPT, JSON_SCHEMA, generateJsonInstruction };
