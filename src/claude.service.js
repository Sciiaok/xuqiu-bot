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
   - TERM (FOB|CIF):"

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

═══ MULTI-LEAD EXTRACTION ═══

Extract each distinct (car_model + destination_country) as separate lead.

Examples:
- "BYD Seal to Dubai, Atto 3 to Saudi" → 2 leads
- "50 units red, 30 units black" → 1 lead with color_quantity array

COLOR QUANTITY FORMAT:
- [{color: "white", qty: 6}, {color: "black", qty: 4}]
- Use "|" for exterior|interior: {color: "gray|black", qty: 7}

═══ MESSAGE STYLE ═══

❌ TOO LONG: "Excellent! 50 units of BYD Seal 05 to Jebel Ali is a substantial order. To provide you with accurate information..."
✅ GOOD: "Great, friend! 50 units to Jebel Ali 👍 What's your company name?"
✅ GOOD: "Thanks, dear! Which country are you shipping to?"`;


const JSON_SCHEMA = {
  type: 'object',
  required: ['conversation_intent', 'inquiry_quality', 'business_value', 'leads', 'route', 'next_message', 'handoff_summary'],
  additionalProperties: false,
  properties: {
    conversation_intent: {
      type: 'string',
      enum: ['personal_consumer', 'business_inquiry', 'business_cooperation', 'other'],
      description: 'Customer intent classification',
    },
    conversation_intent_summary: {
      type: 'string',
      description: 'Brief summary when intent is "other"',
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
        properties: {
          brand: {
            type: 'string',
            description: 'Car brand (e.g., BYD, Toyota)',
          },
          car_model: {
            type: 'string',
            description: 'Car model (REQUIRED for lead matching)',
          },
          destination_country: {
            type: 'string',
            description: 'Country name',
          },
          destination_port: {
            type: 'string',
            description: 'Port or city name',
          },
          loading_port: {
            type: 'string',
            description: 'Port of loading/origin',
          },
          international_commercial_term: {
            type: 'string',
            enum: ['FOB', 'CIF', 'EXW', 'DDP'],
            description: 'Incoterms preference',
          },
          company_name: {
            type: 'string',
            description: 'Company or business name',
          },
          timeline: {
            type: 'string',
            description: 'Purchase timeline',
          },
          color_quantity: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                color: { type: 'string', description: 'Color: "exterior" or "exterior|interior"' },
                qty: { type: 'number', description: 'Quantity for this color' },
              },
            },
            description: 'Array of color-quantity pairs',
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

/**
 * Get an intelligent response from Claude
 * @param {Array} conversationHistory - Array of {role, content} message objects
 * @param {string} userMessage - The latest user message
 * @param {Object} contextInfo - Context information (missing_fields)
 * @returns {Promise<Object>} - Parsed JSON response
 */
export async function getResponse(conversationHistory, userMessage, contextInfo = {}) {
  try {
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

    // Build enhanced system prompt with context
    const missingFieldsText = contextInfo.missing_fields?.length > 0
      ? `Missing fields to collect: ${contextInfo.missing_fields.join(', ')}`
      : 'No specific fields required';

    const enhancedPrompt = `${SYSTEM_PROMPT}

CURRENT CONTEXT:
- ${missingFieldsText}`;

    console.log(`Calling Claude API with ${messages.length} messages...`);

    // Generate JSON instruction from schema (single source of truth)
    const jsonInstruction = generateJsonInstruction(JSON_SCHEMA);

    const response = await anthropic.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: enhancedPrompt + jsonInstruction,
      messages: messages,
    });

    // Extract the JSON content
    const content = response.content[0];
    if (content.type !== 'text') {
      throw new Error('Unexpected response type from Claude');
    }

    // Parse JSON, handling possible markdown code blocks
    let jsonText = content.text.trim();
    if (jsonText.startsWith('```json')) jsonText = jsonText.slice(7);
    else if (jsonText.startsWith('```')) jsonText = jsonText.slice(3);
    if (jsonText.endsWith('```')) jsonText = jsonText.slice(0, -3);

    const parsed = JSON.parse(jsonText.trim());
    console.log('✓ Claude response received');
    console.log('  Intent:', parsed.conversation_intent);
    console.log('  Quality:', parsed.inquiry_quality);
    console.log('  Value:', parsed.business_value);
    console.log('  Route:', parsed.route);
    console.log('  Leads count:', (parsed.leads || []).length);

    return parsed;
  } catch (error) {
    console.error('Claude API error:', error);

    // Return fallback response
    return {
      conversation_intent: 'other',
      conversation_intent_summary: 'Error processing',
      inquiry_quality: 'BAD',
      business_value: 'LOW',
      leads: [],
      route: 'CONTINUE',
      next_message: "I apologize, but I'm having technical difficulties. Could you please try again?",
      handoff_summary: '',
    };
  }
}

// Export schema for testing/debugging
export { JSON_SCHEMA, generateJsonInstruction };
