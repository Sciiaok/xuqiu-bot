# Lead Creation and Routing Fix Design

## Problem Statement

Two issues identified in the lead qualification flow:

1. **Empty Lead Creation**: When a user sends a greeting ("Hello friend"), the system creates an empty lead immediately, before any product intent is expressed.

2. **FAQ_END Misrouting**: When a user expresses product interest ("I want BYD SEAL 05 dmi 128km"), the system incorrectly routes to FAQ_END, treating it as a personal consumer inquiry.

## Solution Overview

### Fix 1: Delayed Lead Creation

**Current Flow:**
```
webhook → getSession() → findOrCreateLead() → creates empty lead
                              ↓
processMessage() → updates empty lead
```

**New Flow:**
```
webhook → getSession() → no lead creation, returns contact + conversation only
                              ↓
processMessage() → Claude returns leads → has car_model?
                                            → yes → findOrCreateLeadByKey()
                                            → no  → save messages only, no lead
```

**Definition of Valid Lead:**
- Claude returns `leads` array with at least one item containing `car_model`
- `car_model` is the core signal of product intent

**Files to Modify:**
- `lib/session.js`: Remove auto-creation in `getSession()`, add validity check in `processMessage()`
- `lib/queue-processor.js`: Handle `session._lead` being null (already uses optional chaining)

### Fix 2: Stricter personal_consumer Classification

**Current Rule:**
```
personal_consumer: Single car inquiry, personal purchase intent
Example: "How much is one BYD Seal?"
```

**New Rule:**
```
personal_consumer: MUST have EXPLICIT personal signals:
  - "for myself", "for my family", "personal use"
  - "just one", "only need 1"
  - Asking about retail price, test drive, dealer location
AND must NOT have any business signals.

IMPORTANT: Unclear quantity ≠ personal_consumer.
Default to business_inquiry when intent is ambiguous.
```

**Routing Changes:**

| Scenario | Old | New |
|----------|-----|-----|
| "I want BYD Seal" | personal_consumer → FAQ_END | business_inquiry → CONTINUE |
| "I want one BYD Seal for myself" | personal_consumer → FAQ_END | personal_consumer → FAQ_END |
| "How much is BYD Seal?" | personal_consumer → FAQ_END | business_inquiry → CONTINUE |

**File to Modify:**
- `src/claude.service.js`: Update SYSTEM_PROMPT customer intent classification section

## Implementation Details

### session.js Changes

**getSession():**
```javascript
// Before
const lead = await findOrCreateLead(conversation.id, contact.id);

// After
const lead = await findLeadByConversation(conversation.id); // may return null
```

**processMessage():**
```javascript
// Add at the beginning
const hasValidLead = claudeResponse.leads?.some(lead => lead.car_model);

if (!hasValidLead) {
  // Save messages without lead association
  await createMessage({ conversationId, role: 'user', content, leadId: null });
  if (claudeResponse.next_message?.trim()) {
    await createMessage({ conversationId, role: 'assistant', content: claudeResponse.next_message, leadId: null });
  }
  await updateConversationOnMessage(conversationId);
  return getSession(waId);
}

// Continue with existing lead processing logic...
```

### claude.service.js SYSTEM_PROMPT Changes

Update the CUSTOMER INTENT CLASSIFICATION section to require explicit personal signals for personal_consumer classification and default ambiguous cases to business_inquiry.

## Testing Scenarios

1. **Greeting only**: "Hello friend" → No lead created, conversation continues
2. **Product intent**: "I want BYD Seal 05" → Lead created with car_model, route=CONTINUE
3. **Explicit personal**: "I want one BYD Seal for myself" → Lead created, route=FAQ_END
4. **Multi-lead**: "BYD Seal to Dubai, Atto 3 to Saudi" → 2 leads created

## Risks and Mitigations

- **Risk**: Messages without leads may complicate conversation history queries
- **Mitigation**: Messages are still linked to conversation_id, queries work unchanged

- **Risk**: Prompt changes may have unintended effects on other classifications
- **Mitigation**: Keep changes focused on personal_consumer criteria only
