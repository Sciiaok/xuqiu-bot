import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
});

const SYSTEM_PROMPT = `You are a B2B lead qualification assistant for a vehicle export company specializing in BYD and other vehicles worldwide.

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

   IMPORTANT: Unclear quantity does NOT mean personal_consumer.
   "I want BYD Seal" without personal signals → treat as business_inquiry

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

1. Max 1-2 questions per message, under 180 characters
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
 * Get an intelligent response from Claude
 * @param {Array} conversationHistory - Array of {role, content} message objects
 * @param {string} userMessage - The latest user message
 * @param {Object} contextInfo - Context information (missing_fields)
 * @returns {Promise<Object>} - Parsed JSON response
 */
export async function getResponse(conversationHistory, userMessage, contextInfo = {}, agentConfig = null) {
  // Sanitize conversation history - Claude only accepts 'role' and 'content'
  const sanitizedHistory = conversationHistory.map(msg => ({
    role: msg.role,
    content: msg.content,
  }));

  // Build messages array with conversation history + new user message
  const messages = [
    ...sanitizedHistory,
    {
      role: 'user',
      content: userMessage,
    },
  ];

  // Use agent config if provided, otherwise fall back to hardcoded defaults
  const systemPrompt = agentConfig?.system_prompt || SYSTEM_PROMPT;
  const outputSchema = agentConfig?.output_schema && Object.keys(agentConfig.output_schema).length > 0
    ? agentConfig.output_schema
    : JSON_SCHEMA;

  // Build enhanced system prompt with context
  const missingFieldsText = contextInfo.missing_fields?.length > 0
    ? `Missing fields to collect: ${contextInfo.missing_fields.join(', ')}`
    : 'No specific fields required';

  const enhancedPrompt = `${systemPrompt}

CURRENT CONTEXT:
- ${missingFieldsText}`;

  console.log(`Calling Claude API with ${messages.length} messages...`);

const response = await anthropic.messages.create({
    model: config.anthropic.model,
    max_tokens: 4096,
    system: enhancedPrompt,
    messages: messages,
    output_config: {
      format: {
        type: 'json_schema',
        schema: outputSchema,
      },
    },
  });

  // Extract the JSON content
  const content = response.content[0];
  if (content.type !== 'text') {
    throw new Error('Unexpected response type from Claude');
  }

  const parsed = JSON.parse(content.text);

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

  console.log('✓ Claude response received');
  console.log('  Intent:', parsed.conversation_intent);
  console.log('  Quality:', parsed.inquiry_quality);
  console.log('  Value:', parsed.business_value);
  console.log('  Route:', parsed.route);
  console.log('  Leads count:', (parsed.leads || []).length);

  return parsed;
}

// Export schema for testing/debugging
export { SYSTEM_PROMPT, JSON_SCHEMA, generateJsonInstruction };
