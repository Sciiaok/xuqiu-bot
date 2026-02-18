# Sales Prompt Optimization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Optimize Claude prompt for better negotiation and sales skills, replacing score_delta with inquiry_quality four-tier system.

**Architecture:** Update SYSTEM_PROMPT and JSON_SCHEMA in claude.service.js, rename state-machine.js to inquiry-quality.js with simplified logic, remove NURTURE routing, update queue-processor.js to use new schema.

**Tech Stack:** Node.js ES6 modules, Anthropic Claude API, Supabase

---

## Task 1: Create inquiry-quality.js (replacing state-machine.js)

**Files:**
- Create: `src/inquiry-quality.js`

**Step 1: Create the new inquiry-quality.js file**

```javascript
/**
 * Inquiry Quality Standards
 * Defines field requirements for each quality level and global limits
 */

const GLOBAL_MAX_TURNS = 30;

const INQUIRY_QUALITY_STANDARD_CONFIG = {
  GOOD: {
    required_fields: ['brand', 'car_model', 'color'],
  },
  QUALIFY: {
    required_fields: ['color_quantity', 'destination_port'],
  },
  PROOF: {
    required_fields: ['company_name', 'international_commercial_term'],
  },
};

/**
 * Get missing fields for a given inquiry quality level
 * @param {string} inquiryQuality - BAD | GOOD | QUALIFY | PROOF
 * @param {Object} leadData - Lead data object
 * @returns {string[]} - Array of missing field names
 */
export function getMissingFields(inquiryQuality, leadData) {
  if (inquiryQuality === 'BAD' || !INQUIRY_QUALITY_STANDARD_CONFIG[inquiryQuality]) {
    return [];
  }

  const config = INQUIRY_QUALITY_STANDARD_CONFIG[inquiryQuality];
  return config.required_fields.filter(field => {
    const value = leadData[field];

    if (Array.isArray(value)) {
      return value.length === 0;
    }

    if (typeof value === 'string') {
      return value.trim() === '';
    }

    return !value;
  });
}

/**
 * Check if global max turns has been reached
 * @param {number} messageCount - Total message count in conversation
 * @returns {boolean} - True if limit reached
 */
export function hasReachedGlobalMaxTurns(messageCount) {
  return Math.floor(messageCount / 2) >= GLOBAL_MAX_TURNS;
}

/**
 * Get global max turns constant
 * @returns {number}
 */
export function getGlobalMaxTurns() {
  return GLOBAL_MAX_TURNS;
}

/**
 * Map inquiry_quality to legacy stage for backward compatibility
 * @param {string} inquiryQuality - BAD | GOOD | QUALIFY | PROOF
 * @returns {string} - GREET | QUALIFY | PROOF
 */
export function mapInquiryQualityToStage(inquiryQuality) {
  const mapping = {
    BAD: 'GREET',
    GOOD: 'GREET',
    QUALIFY: 'QUALIFY',
    PROOF: 'PROOF',
  };
  return mapping[inquiryQuality] || 'GREET';
}

export default {
  GLOBAL_MAX_TURNS,
  INQUIRY_QUALITY_STANDARD_CONFIG,
  getMissingFields,
  hasReachedGlobalMaxTurns,
  getGlobalMaxTurns,
  mapInquiryQualityToStage,
};
```

**Step 2: Verify file created**

Run: `ls -la src/inquiry-quality.js`
Expected: File exists

**Step 3: Commit**

```bash
git add src/inquiry-quality.js
git commit -m "feat: add inquiry-quality.js replacing state-machine logic"
```

---

## Task 2: Update JSON_SCHEMA in claude.service.js

**Files:**
- Modify: `src/claude.service.js:113-223`

**Step 1: Replace JSON_SCHEMA definition**

Replace the entire `const JSON_SCHEMA = { ... }` block with:

```javascript
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
```

**Step 2: Commit**

```bash
git add src/claude.service.js
git commit -m "feat: update JSON_SCHEMA with inquiry_quality and business_value"
```

---

## Task 3: Rewrite SYSTEM_PROMPT in claude.service.js

**Files:**
- Modify: `src/claude.service.js:8-110`

**Step 1: Replace SYSTEM_PROMPT**

Replace the entire `const SYSTEM_PROMPT = \`...\`` block with:

```javascript
const SYSTEM_PROMPT = `You are a B2B lead qualification assistant for a vehicle export company specializing in BYD and other vehicles worldwide.

═══ CUSTOMER INTENT CLASSIFICATION ═══

Classify each conversation into one of these intents:

1. personal_consumer (C端)
   - Single car inquiry, personal purchase intent
   - Action: Send company website link, route to FAQ_END
   - Example: "How much is one BYD Seal?"

2. business_inquiry (B端主动询盘)
   - Proactive inquiry: model + quantity + price request
   - Action: Fast track qualification, collect inquiry details
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

BAD: Invalid/C-end/Spam
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
```

**Step 2: Commit**

```bash
git add src/claude.service.js
git commit -m "feat: rewrite SYSTEM_PROMPT with intent classification and sales techniques"
```

---

## Task 4: Update getResponse function in claude.service.js

**Files:**
- Modify: `src/claude.service.js:287-363`

**Step 1: Update getResponse function signature and context building**

Find the `getResponse` function and replace it with:

```javascript
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
```

**Step 2: Commit**

```bash
git add src/claude.service.js
git commit -m "feat: update getResponse to use simplified context"
```

---

## Task 5: Update queue-processor.js to use new schema

**Files:**
- Modify: `lib/queue-processor.js`

**Step 1: Update imports**

Replace state-machine imports with:

```javascript
import {
  getMissingFields,
  hasReachedGlobalMaxTurns,
  getGlobalMaxTurns,
  mapInquiryQualityToStage,
} from '../src/inquiry-quality.js';
```

**Step 2: Remove lead-scorer import**

Delete or comment out:

```javascript
// import { getScoreBreakdown } from '../src/lead-scorer.js';
```

**Step 3: Update processConversationQueue function**

Replace the function body to use new schema:

```javascript
export async function processConversationQueue(conversationId) {
  // 1. Acquire and lock pending messages (distributed lock)
  const messages = await acquirePendingMessages(conversationId);

  // If no messages (possibly handled by another instance), return
  if (!messages || messages.length === 0) {
    console.log(`No pending messages for conversation ${conversationId} (possibly handled by another instance)`);
    return { processed: false, reason: 'no_messages' };
  }

  const waId = messages[0].wa_id;
  const messageIds = messages.map((m) => m.id);
  console.log(`\n--- Processing ${messages.length} aggregated message(s) for ${waId} ---`);

  try {
    // 2. Aggregate message content (newline-separated)
    const aggregatedContent = messages.map((m) => m.content).join('\n');
    console.log(`Aggregated content: "${aggregatedContent}"`);

    // 3. Get session (includes full conversation history)
    const session = await getSession(waId);

    // 4. Build context info (simplified - just missing fields)
    const contextInfo = {
      missing_fields: getMissingFields(session._lead?.inquiry_quality || 'GOOD', session.lead_data),
    };

    // 5. Single Claude call to process all aggregated messages
    const claudeResponse = await getResponse(
      session.messages,
      aggregatedContent,
      contextInfo
    );

    // 6. Process message and update all data (handles multi-lead internally)
    const updatedSession = await processMessage(waId, aggregatedContent, claudeResponse);

    // Log multi-lead info
    const leadsCount = (claudeResponse.leads || []).length;
    if (leadsCount > 1) {
      console.log(`  Multi-lead: ${leadsCount} leads extracted`);
      claudeResponse.leads.forEach((lead, i) => {
        console.log(`    Lead ${i + 1}: ${lead.car_model || '?'} → ${lead.destination_country || '?'}`);
      });
    }

    // 7. Log new schema fields
    console.log(`Intent: ${claudeResponse.conversation_intent}`);
    console.log(`Quality: ${claudeResponse.inquiry_quality}, Value: ${claudeResponse.business_value}`);
    console.log(`Route: ${claudeResponse.route}`);

    // 8. Send single response to user (skip if empty - spam case)
    if (claudeResponse.next_message && claudeResponse.next_message.trim() !== '') {
      await sendMessage(waId, claudeResponse.next_message);
      console.log(`Assistant: ${claudeResponse.next_message}`);
    } else {
      console.log(`Assistant: [no response - spam/invalid detected]`);
    }

    // 9. Check global max turns - force FAQ_END if exceeded
    let finalRoute = claudeResponse.route;
    if (hasReachedGlobalMaxTurns(updatedSession.messages?.length || 0)) {
      console.log(`Global max turns (${getGlobalMaxTurns()}) reached - routing to FAQ_END`);
      finalRoute = 'FAQ_END';
    }

    // 10. Handle routing for all active leads in conversation
    if (finalRoute !== 'CONTINUE') {
      console.log(`\nExecuting routing: ${finalRoute}`);
      const routingResult = await executeConversationRouting(
        finalRoute,
        updatedSession.conversation_id,
        waId,
        claudeResponse.handoff_summary
      );

      if (routingResult.success) {
        console.log(`Routing completed: ${routingResult.leadsRouted || 1} lead(s) routed`);
      } else {
        console.log(`Routing failed: ${routingResult.reason || 'unknown'}`);
      }
    }

    // 11. Mark queue messages as completed
    await markAsCompleted(messageIds);
    console.log('---\n');

    return {
      processed: true,
      messageCount: messages.length,
      aggregatedContent,
      response: claudeResponse.next_message,
    };
  } catch (error) {
    console.error(`Error processing queue for ${waId}:`, error);

    // Mark as failed for retry
    await markAsFailed(messageIds, error.message);

    return {
      processed: false,
      error: error.message,
      messageCount: messages.length,
    };
  }
}
```

**Step 4: Commit**

```bash
git add lib/queue-processor.js
git commit -m "feat: update queue-processor to use inquiry_quality schema"
```

---

## Task 6: Simplify routing.service.js

**Files:**
- Modify: `src/routing.service.js`

**Step 1: Remove routeToNurture and routeLeadToNurture functions**

Delete lines 69-119 (`routeToNurture`) and lines 238-289 (`routeLeadToNurture`).

**Step 2: Update executeRouting function**

```javascript
export async function executeRouting(route, session, handoffSummary) {
  switch (route) {
    case 'HUMAN_NOW':
      return await routeToSales(session, handoffSummary);

    case 'FAQ_END':
      return await sendFAQResources(session.wa_id);

    case 'CONTINUE':
      return { success: true, action: 'continue_conversation' };

    default:
      console.log(`Unknown route: ${route}`);
      return { success: false, reason: 'unknown_route' };
  }
}
```

**Step 3: Update executeLeadRouting function**

```javascript
export async function executeLeadRouting(route, lead, handoffSummary) {
  switch (route) {
    case 'HUMAN_NOW':
      return await routeLeadToSales(lead, handoffSummary);

    case 'FAQ_END':
      await updateLead(lead.id, { route: 'FAQ_END' });
      return { success: true, action: 'marked_faq_end' };

    case 'CONTINUE':
      return { success: true, action: 'continue_conversation' };

    default:
      console.log(`Unknown route: ${route}`);
      return { success: false, reason: 'unknown_route' };
  }
}
```

**Step 4: Update default export**

```javascript
export default {
  routeToSales,
  routeLeadToSales,
  sendFAQResources,
  executeRouting,
  executeLeadRouting,
  executeConversationRouting,
};
```

**Step 5: Commit**

```bash
git add src/routing.service.js
git commit -m "feat: simplify routing by removing NURTURE"
```

---

## Task 7: Update session.js to handle new schema

**Files:**
- Modify: `lib/session.js:94-193`

**Step 1: Update processMessage function**

Update the function to handle new Claude response fields:

```javascript
export async function processMessage(waId, userMessageContent, claudeResponse) {
  // Get current session state
  const session = await getSession(waId);

  // 1. Get leads array (with backward compatibility for extracted_fields)
  let leadsData = claudeResponse.leads || [];
  if (leadsData.length === 0 && claudeResponse.extracted_fields) {
    leadsData = [{ ...claudeResponse.extracted_fields }];
  }

  // 2. Create user message (initially without lead association)
  const userMessage = await createMessage({
    conversationId: session.conversation_id,
    role: 'user',
    content: userMessageContent,
    sentBy: 'customer',
  });

  // 3. Process each lead
  const processedLeads = [];
  for (const leadData of leadsData) {
    const leadKey = generateLeadKey(leadData);

    const targetLead = await findOrCreateLeadByKey(
      session.conversation_id,
      session.contact_id,
      leadKey
    );

    // Update lead with extracted fields and new schema fields
    await updateLeadFromClaudeFields(targetLead.id, leadData, targetLead.score);

    // Update inquiry_quality and business_value on first lead
    if (processedLeads.length === 0) {
      await updateLead(targetLead.id, {
        inquiry_quality: claudeResponse.inquiry_quality,
        business_value: claudeResponse.business_value,
        conversation_intent: claudeResponse.conversation_intent,
        route: claudeResponse.route,
      });
    }

    processedLeads.push(targetLead);
  }

  // 4. Associate user message with first lead
  if (processedLeads.length > 0) {
    await updateMessage(userMessage.id, {
      leadId: processedLeads[0].id,
    });
  }

  // 5. Create assistant message (skip if empty)
  if (claudeResponse.next_message && claudeResponse.next_message.trim() !== '') {
    await createMessage({
      conversationId: session.conversation_id,
      role: 'assistant',
      content: claudeResponse.next_message,
      sentBy: 'bot',
      leadId: processedLeads[0]?.id || null,
    });
    await updateConversationOnMessage(session.conversation_id);
  }

  // 6. Update conversation timestamp
  await updateConversationOnMessage(session.conversation_id);

  // 7. Update contact company name if extracted
  const companyName = leadsData.find(l => l.company_name)?.company_name;
  if (companyName) {
    await updateContact(session.contact_id, { company_name: companyName });
  }

  // 8. Handle conversation closure on terminal routes
  if (claudeResponse.route && claudeResponse.route !== 'CONTINUE') {
    const activeLeads = await getLeadsByConversation(session.conversation_id);
    if (activeLeads.length === 0) {
      const reasonMap = {
        'HUMAN_NOW': 'route_human',
        'FAQ_END': 'route_faq',
      };
      await closeConversation(session.conversation_id, reasonMap[claudeResponse.route] || 'manual');
    }
  }

  return getSession(waId);
}
```

**Step 2: Remove updateSessionStage function**

Delete or comment out lines 196-206 as stage is no longer managed separately.

**Step 3: Commit**

```bash
git add lib/session.js
git commit -m "feat: update session.js to handle inquiry_quality schema"
```

---

## Task 8: Delete deprecated files

**Files:**
- Delete: `src/state-machine.js`
- Keep but deprecate: `src/lead-scorer.js`

**Step 1: Remove state-machine.js**

```bash
git rm src/state-machine.js
```

**Step 2: Add deprecation comment to lead-scorer.js**

Add at the top of the file:

```javascript
/**
 * @deprecated This file is deprecated. Scoring logic has moved to Claude prompt.
 * Kept for backward compatibility during migration.
 */
```

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove state-machine.js, deprecate lead-scorer.js"
```

---

## Task 9: Test the changes locally

**Step 1: Start development server**

Run: `npm run dev`
Expected: Server starts on port 3002 without errors

**Step 2: Send test WhatsApp message**

Use WhatsApp to send a test message to the bot.
Expected: Bot responds with new prompt behavior

**Step 3: Check logs**

Expected log output should show:
- Intent classification
- inquiry_quality level
- business_value assessment
- Route decision

---

## Task 10: Final commit and cleanup

**Step 1: Run linter**

Run: `npm run lint`
Expected: No errors

**Step 2: Create summary commit if needed**

```bash
git add -A
git commit -m "feat: complete sales prompt optimization

- Add inquiry_quality 4-tier system (BAD/GOOD/QUALIFY/PROOF)
- Add customer intent classification
- Add business_value assessment
- Remove score_delta and NURTURE routing
- Simplify state management"
```
