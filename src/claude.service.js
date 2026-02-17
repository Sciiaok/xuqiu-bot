import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
});

const SYSTEM_PROMPT = `You are a B2B lead qualification assistant for a vehicle export company specializing in BYD and other vehicles to WorldWide.

CONVERSATION STAGES:
1. GREET: Initial contact, gather basic intent (car_model, destination, quantity)
2. QUALIFY: Deep qualification (company, buyer type, timeline, budget indication)
3. PROOF: Verify legitimacy and readiness (Incoterms preference)

SCORING GUIDELINES (score_delta: -30 to +30 per turn):
Identity Trust (0-30 points):
  +10: Provides company name
  +10: Mentions verifiable details (registration, office location)
  +10: Provides Incoterms preference (FOB, CIF, etc.)
  -10: Vague or generic company info
  -15: Refuses to share company details

Transaction Intent (0-40 points):
  +15: Specific quantity mentioned (20+ units = +20)
  +10: Clear destination port/city
  +10: Mentions timeline (urgent = +15)
  +5: Discusses budget or financing
  -20: Only asks for prices without context
  -15: Very vague requirements

Requirement Clarity (0-20 points):
  +10: Specific model preferences
  +5: Technical requirements mentioned
  +5: Delivery/logistics discussion
  -10: Extremely vague needs

Risk Flags (deductions):
  -10: "price_focused" - only interested in prices
  -10: "vague_location" - unclear destination
  -10: "no_company" - refuses company info
  -15: "suspicious_behavior" - inconsistent info
  -5: "unrealistic_expectations" - demands immediate pricing

ROUTING LOGIC:
- CONTINUE: Keep qualifying (stage not complete or score unknown)
- HUMAN_NOW: score ≥75 and stage PROOF complete - High-quality lead ready for sales
- NURTURE: score 50-74 - Medium quality, needs follow-up
- FAQ_END: score <50 - Low quality, send resources

RULES:
1. Ask only ONE question per message
2. Keep responses under 120 characters - WhatsApp style, short and friendly
3. Use friendly greetings: "Friend", "Dear", casual tone
4. Never promise final prices
5. Progress through stages: GREET → QUALIFY → PROOF
6. In GREET: Focus on destination, quantity, and car model
7. In QUALIFY: Get company, buyer type, timeline, loading port (optional)
8. In PROOF: Verify legitimacy, ask Incoterms (required: FOB, CIF, EXW, DDP)
9. Calculate score_delta based on information quality
10. Provide clear reasons for scoring
11. Flag risks when detected
12. Route appropriately based on total score and stage

MESSAGE STYLE (WhatsApp-friendly, under 120 chars):
❌ TOO LONG: "Excellent! 50 units of BYD Seal 05 to Jebel Ali is a substantial order. To provide you with accurate information and pricing, may I know your company name?"
✅ GOOD: "Great, friend! 50 units to Jebel Ali 👍 What's your company name?"
✅ GOOD: "Thanks, dear! Which country are you shipping to?"
✅ GOOD: "Perfect! Are you a dealer, store owner, or trading org?"

MULTI-LEAD EXTRACTION:
User messages may contain multiple product inquiries. Extract each distinct inquiry as a separate lead in the leads array.

RULES:
1. Each UNIQUE (car_model + destination_country) combination = 1 lead entry
2. Return leads as an array, even if only 1 lead
3. ALWAYS include car_model and/or destination_country for lead matching
4. Shared info (company_name, buyer_type) can be included in each relevant lead
5. If user asks follow-up without mentioning car/destination, infer from conversation context

EXAMPLES:

Single inquiry:
User: "I want BYD Seal 50 units to Dubai"
→ leads: [{ car_model: "BYD Seal", destination_country: "UAE", qty_bucket: "20+" }]

Multiple inquiries in one message:
User: "I want BYD Seal to Dubai, also Atto 3 to Saudi, and Han to Qatar"
→ leads: [
    { car_model: "BYD Seal", destination_country: "UAE" },
    { car_model: "BYD Atto 3", destination_country: "Saudi Arabia" },
    { car_model: "BYD Han", destination_country: "Qatar" }
  ]

Follow-up (infer context):
Previous: BYD Seal to Dubai
User: "I want red color, 5 units"
→ leads: [{ car_model: "BYD Seal", destination_country: "UAE", color_quantity: [{color: "red", qty: 5}] }]

General question (no lead update):
User: "What payment methods do you accept?"
→ leads: []

COLOR QUANTITY EXTRACTION:
When user mentions specific colors and quantities, extract them into color_quantity array within the relevant lead.
- Format: [{"color": "exterior" or "exterior|interior", "qty": number}]
- Examples:
  - "白色6台，黑色4台" → [{color: "white", qty: 6}, {color: "black", qty: 4}]
  - "灰色外观黑内饰7台" → [{color: "gray|black", qty: 7}]
- Use "|" to separate exterior and interior colors
- Leave empty [] if no specific color/quantity mentioned`;


const JSON_SCHEMA = {
  type: 'object',
  required: ['stage', 'leads', 'score_delta', 'reasons', 'risk_flags', 'route', 'next_message', 'handoff_summary'],
  additionalProperties: false,
  properties: {
    stage: {
      type: 'string',
      enum: ['GREET', 'QUALIFY', 'PROOF'],
      description: 'Current conversation stage',
    },
    leads: {
      type: 'array',
      description: 'Array of leads extracted from user message(s). Usually 1, can be multiple for multi-inquiry messages.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          car_model: {
            type: 'string',
            description: 'Car model (REQUIRED for lead matching)',
          },
          destination_country: {
            type: 'string',
            description: 'Country name (REQUIRED for lead matching)',
          },
          destination_port: {
            type: 'string',
            description: 'Port or city name',
          },
          qty_bucket: {
            type: 'string',
            enum: ['1-5', '6-20', '20+'],
            description: 'Quantity range',
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
          buyer_type: {
            type: 'string',
            enum: ['dealer', 'store_owner', 'trading_org'],
            description: 'Type of buyer',
          },
          timeline: {
            type: 'string',
            description: 'Purchase timeline',
          },
          budget_indication: {
            type: 'string',
            description: 'Budget indication if mentioned',
          },
          brand: {
            type: 'string',
            description: 'Vehicle brand (e.g., BYD, Toyota)',
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
    score_delta: {
      type: 'number',
      description: 'Score change for this turn (-30 to +30)',
    },
    reasons: {
      type: 'array',
      items: { type: 'string' },
      description: 'Reasons for score change',
    },
    risk_flags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Detected risk flags (e.g., "vague_location", "no_company", "price_focused")',
    },
    route: {
      type: 'string',
      enum: ['CONTINUE', 'HUMAN_NOW', 'NURTURE', 'FAQ_END'],
      description: 'Routing decision based on score and stage',
    },
    next_message: {
      type: 'string',
      description: 'The next question or response (max 120 chars, WhatsApp-style friendly with "Friend"/"Dear")',
    },
    handoff_summary: {
      type: 'string',
      description: 'Summary for sales team if routing to HUMAN_NOW or NURTURE',
    },
    // Deprecated: kept for backward compatibility
    extracted_fields: {
      type: 'object',
      description: 'DEPRECATED: Use leads array instead',
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
 * @param {Object} stageInfo - Current stage information and guidance
 * @param {number} currentScore - Current lead score
 * @returns {Promise<Object>} - Parsed JSON response with extracted_fields and next_message
 */
export async function getResponse(conversationHistory, userMessage, stageInfo, currentScore = 0) {
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

    // Build enhanced system prompt with stage context
    const enhancedPrompt = `${SYSTEM_PROMPT}

CURRENT CONTEXT:
- Stage: ${stageInfo.stage}
- Current Score: ${currentScore} points
- Stage Progress: ${stageInfo.progress}%
- ${stageInfo.guidance}
- Missing Fields: ${stageInfo.missing_fields.length > 0 ? stageInfo.missing_fields.join(', ') : 'None'}

Focus on collecting: ${stageInfo.missing_fields.length > 0 ? stageInfo.missing_fields.join(', ') : 'verification and readiness signals'}`;

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
    console.log('  Leads count:', (parsed.leads || []).length);
    if (parsed.leads?.length > 0) {
      const leadSummaries = parsed.leads.map(l => `${l.car_model || '?'}→${l.destination_country || '?'}`);
      console.log('  Leads:', leadSummaries.join(', '));
    }

    return parsed;
  } catch (error) {
    console.error('Claude API error:', error);

    // Return fallback response
    return {
      leads: [],
      score_delta: 0,
      reasons: [],
      risk_flags: [],
      route: 'CONTINUE',
      next_message: "I apologize, but I'm having technical difficulties. Could you please try again?",
      handoff_summary: '',
    };
  }
}

// Export schema for testing/debugging
export { JSON_SCHEMA, generateJsonInstruction };
