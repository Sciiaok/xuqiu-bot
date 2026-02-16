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
✅ GOOD: "Perfect! Are you a dealer, store owner, or trading org?"`;


const JSON_SCHEMA = {
  type: 'object',
  required: ['stage', 'extracted_fields', 'score_delta', 'reasons', 'risk_flags', 'route', 'next_message', 'handoff_summary'],
  additionalProperties: false,
  properties: {
    stage: {
      type: 'string',
      enum: ['GREET', 'QUALIFY', 'PROOF'],
      description: 'Current conversation stage',
    },
    extracted_fields: {
      type: 'object',
      additionalProperties: false,
      properties: {
        destination_country: {
          type: 'string',
          description: 'Country name (e.g., "UAE", "Saudi Arabia", "Qatar")',
        },
        destination_port: {
          type: 'string',
          description: 'Port or city name (e.g., "Dubai", "Jebel Ali", "Riyadh")',
        },
        qty_bucket: {
          type: 'string',
          enum: ['1-5', '6-20', '20+'],
          description: 'Quantity range',
        },
        car_model: {
          type: 'string',
          description: 'Car model interested in (e.g., "BYD Seal", "BYD Atto 3", "BYD Han")',
        },
        loading_port: {
          type: 'string',
          description: 'Port of loading/origin (e.g., "Shanghai", "Tianjin", "Guangzhou")',
        },
        international_commercial_term: {
          type: 'string',
          description: 'Incoterms preference (e.g., "FOB", "CIF", "EXW", "DDP")',
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
          description: 'Purchase timeline (urgent, this month, this quarter, exploring)',
        },
        budget_indication: {
          type: 'string',
          description: 'Budget indication if mentioned',
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
  },
};

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

    // Append JSON instruction to system prompt
    const jsonInstruction = `\n\nRESPONSE FORMAT: You MUST respond with valid JSON only, no markdown. Use this exact structure:
{"stage":"GREET|QUALIFY|PROOF","extracted_fields":{"destination_country":"","destination_port":"","qty_bucket":"1-5|6-20|20+","car_model":"","loading_port":"","international_commercial_term":"FOB|CIF|EXW|DDP","company_name":"","buyer_type":"dealer|store_owner|trading_org","timeline":"","budget_indication":""},"score_delta":0,"reasons":[],"risk_flags":[],"route":"CONTINUE|HUMAN_NOW|NURTURE|FAQ_END","next_message":"","handoff_summary":""}`;

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
    console.log('  Extracted fields:', Object.keys(parsed.extracted_fields).filter(k => parsed.extracted_fields[k]));

    return parsed;
  } catch (error) {
    console.error('Claude API error:', error);

    // Return fallback response
    return {
      extracted_fields: {},
      next_message: "I apologize, but I'm having technical difficulties. Could you please try again?",
    };
  }
}
