# Lead Creation and Routing Fix Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix empty lead creation on greetings and FAQ_END misrouting for product inquiries.

**Architecture:** Modify session.js to delay lead creation until Claude returns a valid lead (with car_model). Update claude.service.js prompt to require explicit personal signals for personal_consumer classification.

**Tech Stack:** Next.js, Supabase, Anthropic Claude API

---

## Task 1: Add findLeadByConversation import to session.js

**Files:**
- Modify: `lib/session.js:24-32`

**Step 1: Update import statement**

Change the lead.repository.js import to include `findLeadByConversation`:

```javascript
import {
  findOrCreateLead,
  findOrCreateLeadByKey,
  findLeadByConversation,
  updateLead,
  updateLeadFromClaude,
  updateLeadFromClaudeFields,
  getLeadsByConversation,
  formatLeadDataForUI,
} from './repositories/lead.repository.js';
```

**Step 2: Verify no syntax errors**

Run: `node --check lib/session.js`
Expected: No output (success)

**Step 3: Commit**

```bash
git add lib/session.js
git commit -m "refactor: add findLeadByConversation import"
```

---

## Task 2: Modify getSession to not auto-create lead

**Files:**
- Modify: `lib/session.js:41-84`

**Step 1: Replace findOrCreateLead with findLeadByConversation**

Change line 49 from:
```javascript
  const lead = await findOrCreateLead(conversation.id, contact.id);
```

To:
```javascript
  // Find existing lead (don't auto-create on first message)
  const lead = await findLeadByConversation(conversation.id);
```

**Step 2: Handle null lead in return object**

Update the return object to handle null lead (lines 58-83):

```javascript
  // Return session-like object for backward compatibility
  return {
    // IDs for new schema
    contact_id: contact.id,
    conversation_id: conversation.id,
    lead_id: lead?.id || null,

    // Backward compatible fields
    wa_id: waId,
    messages: messages,
    stage: lead?.stage || 'GREET',
    stage_turn_count: Math.floor(messages.length / 2),
    score: lead?.score || 0,
    score_history: [],
    risk_flags: riskFlags,
    lead_data: lead ? formatLeadDataForUI({ ...lead, contact }) : {},
    route: lead?.route || 'CONTINUE',

    // Timestamps
    created_at: conversation.started_at,
    updated_at: conversation.last_message_at,

    // Raw objects for advanced use
    _contact: contact,
    _conversation: conversation,
    _lead: lead,
  };
```

**Step 3: Verify no syntax errors**

Run: `node --check lib/session.js`
Expected: No output (success)

**Step 4: Commit**

```bash
git add lib/session.js
git commit -m "refactor: getSession no longer auto-creates lead"
```

---

## Task 3: Modify processMessage to handle no-lead case

**Files:**
- Modify: `lib/session.js:94-180`

**Step 1: Add valid lead check after getting leads array**

After line 102, add the following code:

```javascript
  // Check if any lead has car_model (valid product intent)
  const hasValidLead = leadsData.some(lead => lead.car_model);

  // If no valid lead data, save messages without lead and return early
  if (!hasValidLead) {
    // Create user message without lead association
    await createMessage({
      conversationId: session.conversation_id,
      role: 'user',
      content: userMessageContent,
      sentBy: 'customer',
    });

    // Create assistant message if not empty
    if (claudeResponse.next_message && claudeResponse.next_message.trim() !== '') {
      await createMessage({
        conversationId: session.conversation_id,
        role: 'assistant',
        content: claudeResponse.next_message,
        sentBy: 'bot',
      });
    }

    // Update conversation timestamp
    await updateConversationOnMessage(session.conversation_id);

    return getSession(waId);
  }
```

**Step 2: Verify no syntax errors**

Run: `node --check lib/session.js`
Expected: No output (success)

**Step 3: Commit**

```bash
git add lib/session.js
git commit -m "feat: processMessage saves messages without lead when no product intent"
```

---

## Task 4: Update SYSTEM_PROMPT for stricter personal_consumer

**Files:**
- Modify: `src/claude.service.js:8-106`

**Step 1: Replace the CUSTOMER INTENT CLASSIFICATION section**

Replace lines 10-31 with:

```javascript
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
```

**Step 2: Update INQUIRY QUALITY LEVELS section**

Replace line 57 from:
```
BAD: Invalid/C-end/Spam
```

To:
```
BAD: Invalid/Spam (C-end with explicit personal signals only)
```

**Step 3: Verify no syntax errors**

Run: `node --check src/claude.service.js`
Expected: No output (success)

**Step 4: Commit**

```bash
git add src/claude.service.js
git commit -m "feat: stricter personal_consumer classification rules"
```

---

## Task 5: Manual integration test

**Step 1: Start dev server**

Run: `npm run dev`

**Step 2: Test greeting message**

Send via WhatsApp or test endpoint: "Hello friend"

Expected:
- Claude responds with greeting
- No lead created in database (check Supabase leads table)
- Messages saved to messages table

**Step 3: Test product inquiry without personal signals**

Send: "I want BYD SEAL 05 dmi 128km"

Expected:
- Claude classifies as `business_inquiry`
- Route: `CONTINUE`
- Lead created with `car_model: "BYD SEAL 05 dmi 128km"`

**Step 4: Test explicit personal consumer**

Send: "I want one BYD Seal for myself"

Expected:
- Claude classifies as `personal_consumer`
- Route: `FAQ_END`
- Lead created (has car_model)

**Step 5: Commit final verification**

```bash
git add -A
git commit -m "test: verified lead creation and routing fixes"
```

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add import | lib/session.js |
| 2 | Modify getSession | lib/session.js |
| 3 | Modify processMessage | lib/session.js |
| 4 | Update SYSTEM_PROMPT | src/claude.service.js |
| 5 | Manual integration test | - |
