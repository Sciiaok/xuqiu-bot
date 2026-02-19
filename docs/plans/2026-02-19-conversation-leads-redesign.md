# Conversation & Leads Redesign

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix lead duplication issues, simplify lead management with batch replace strategy, and restructure inbox UI by contact.

**Architecture:** Replace incremental lead updates with batch replacement per Claude response. Remove HUMAN_NOW conversation closure. Restructure inbox to group by contact instead of conversation.

**Tech Stack:** Next.js, Supabase, Anthropic Claude API

---

## Section 1: Lead Management Redesign

### Problem
- Same conversation creates multiple duplicate leads (6 leads for 1 product)
- `findOrCreateLeadByKey` fails to find existing leads after route changes to HUMAN_NOW
- `mergeColorQuantity` creates invalid entries with empty color strings

### Solution: Batch Replace Strategy

Every time Claude returns leads, **delete all existing leads** for that conversation and **insert the new leads**.

### Code Changes

**New function in `lead.repository.js`:**

```javascript
/**
 * Replace all leads for a conversation with new leads from Claude
 *
 * ⚠️ TODO: 潜在事务问题
 * 当前实现先删除后插入，非原子操作。如果插入失败，会导致数据丢失。
 * 后续可考虑：
 * 1. 使用软删除 (replaced_at 字段) 实现回滚
 * 2. 使用 Supabase RPC 事务函数
 * 3. 使用 Postgres 存储过程
 *
 * @param {string} conversationId - Conversation UUID
 * @param {string} contactId - Contact UUID
 * @param {Array} newLeads - Array of lead objects from Claude
 */
export async function replaceConversationLeads(conversationId, contactId, newLeads) {
  // Step 1: 删除该会话所有现有 leads
  // ⚠️ 注意：此处与下方插入不在同一事务中
  const { error: deleteError } = await supabase
    .from('leads')
    .delete()
    .eq('conversation_id', conversationId);

  if (deleteError) throw deleteError;

  // Step 2: 批量插入新 leads
  if (newLeads.length === 0) return [];

  const leadsToInsert = newLeads.map(lead => ({
    conversation_id: conversationId,
    contact_id: contactId,
    car_model: lead.car_model,
    destination_country: lead.destination_country,
    destination_port: lead.destination_port,
    color_quantity: lead.color_quantity || [],
    inquiry_quality: lead.inquiry_quality,
    business_value: lead.business_value,
    conversation_intent: lead.conversation_intent,
    conversation_intent_summary: lead.conversation_intent_summary,
    route: lead.route,
    brand: lead.brand,
    incoterm: lead.international_commercial_term,
    timeline: lead.timeline,
    company_name: lead.company_name,
  }));

  const { data, error: insertError } = await supabase
    .from('leads')
    .insert(leadsToInsert)
    .select();

  if (insertError) throw insertError;

  return data;
}
```

**Update `session.js` processMessage():**

Replace the lead creation loop with:
```javascript
// Replace all leads for this conversation
await replaceConversationLeads(
  session.conversation_id,
  session.contact_id,
  claudeResponse.leads.map(lead => ({
    ...lead,
    inquiry_quality: claudeResponse.inquiry_quality,
    business_value: claudeResponse.business_value,
    conversation_intent: Array.isArray(claudeResponse.conversation_intent)
      ? claudeResponse.conversation_intent.join(',')
      : claudeResponse.conversation_intent,
    conversation_intent_summary: claudeResponse.conversation_intent_summary,
    route: claudeResponse.route,
  }))
);
```

### Code to Remove

- `findOrCreateLeadByKey()` - no longer needed
- `findOrCreateLead()` - no longer needed
- `mergeColorQuantity()` - no longer needed
- `leadKeyHasDestination()` - no longer needed
- `extractCarModelKey()` - no longer needed

---

## Section 2: Conversation Logic Changes

### Problem
- HUMAN_NOW route closes conversation immediately
- Next message creates new conversation
- Same contact has many short conversations

### Solution

HUMAN_NOW only marks lead status, **does not close conversation**. Conversations only close on **3-day timeout**.

### Code Changes

**Remove from `session.js`:**

```javascript
// DELETE this code block:
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
```

### Conversation Status Simplification

| Old Status | New Status |
|------------|------------|
| active | active |
| closed (route_human) | **removed** |
| closed (route_faq) | **removed** |
| closed (timeout) | closed |

`closed_reason` only keeps:
- `timeout` - 3 days no messages
- `manual` - manual close (future feature)

---

## Section 3: Inbox UI Redesign

### Problem
- Inbox shows conversations, not contacts
- Same contact's messages split across multiple conversations
- Hard to see full customer history

### Solution

Restructure inbox to group by **contact** instead of **conversation**.

### New Structure

```
Inbox
├── ContactList (grouped by contact, shows latest message preview)
├── ChatLog (all messages from all conversations for selected contact)
└── LeadsList (all leads from all conversations for selected contact)
```

### Data Query Changes

**Contact list query:**
```javascript
const { data: contacts } = await supabase
  .from('contacts')
  .select(`
    *,
    conversations!inner (
      id,
      last_message_at,
      messages (content, sent_at, role)
    )
  `)
  .gte('conversations.last_message_at', thirtyDaysAgo)
  .order('conversations.last_message_at', { ascending: false });
```

**Messages query (after selecting contact):**
```javascript
const { data: messages } = await supabase
  .from('messages')
  .select('*, conversation:conversations!inner(contact_id)')
  .eq('conversation.contact_id', contactId)
  .order('sent_at', { ascending: true });
```

**Leads query:**
```javascript
const { data: leads } = await supabase
  .from('leads')
  .select('*, conversation:conversations!inner(contact_id)')
  .eq('conversation.contact_id', contactId)
  .order('created_at', { ascending: true });
```

### Component Changes

| Component | Change |
|-----------|--------|
| `ConversationList.js` | Rename to `ContactList.js`, group by contact |
| `ChatLog.js` | No change, but data source is all messages for contact |
| `LeadsList.js` | No change, but data source is all leads for contact |

### Conversation Separator in Chat

Show separators between different conversations:
```
[2026-02-19 01:32] ─── 会话开始 ───
User: Tai 7 Price?
Assistant: Hi friend! For BYD Tang...
...
[2026-02-19 04:13] ─── 会话开始 ───
User: CIF
Assistant: Got it, friend! CIF term...
```

---

## Section 4: Claude Prompt Optimization

### Change 1: car_model Normalization

Remove strict matching, allow Claude to normalize:

```diff
- IMPORTANT - car_model consistency:
- - Use EXACTLY the same car_model string across all messages
- - Do NOT auto-correct or normalize the model name

+ IMPORTANT - car_model handling:
+ - Normalize car_model to standard format (e.g., "Leopard 7", "Seal 05 DM-i")
+ - Correct obvious typos and variations (e.g., "leopard7" → "Leopard 7")
+ - Include key specs when mentioned (e.g., "7-seater", "128km")
```

### Change 2: Lead Output Rules

Only output leads when information is sufficient:

```
═══ LEAD OUTPUT RULES ═══

Only output a lead in the leads array when:
1. car_model is clearly identified (not just "car" or "vehicle")
2. Customer has shown purchase intent (not just browsing)

Do NOT output leads for:
- Greetings without product mention
- General questions about the company
- Requests for catalog/brochure without specific model
```

### Change 3: color_quantity Format

Explicit instruction for color_quantity:

```
color_quantity description: 'Array of color-quantity pairs. Only include when BOTH color AND qty are known. Never include empty color string.'
```

### Change 4: Full Conversation Summary

Output leads based on entire conversation, not just latest message:

```
═══ LEAD OUTPUT STRATEGY ═══

IMPORTANT: Output leads based on ENTIRE conversation, not just latest message.

On each response, review ALL messages in the conversation and output:
- All valid leads mentioned throughout the conversation
- Updated with the latest information (corrections, additions)
- Merged where appropriate (same car_model to same destination = 1 lead)

Example conversation:
[User]: I want Seal to Dubai
[Assistant]: How many units?
[User]: 10 units, also need Atto 3 to Saudi
[Assistant]: Colors for both?
[User]: Seal all black, Atto 3 red and white

→ leads output should contain BOTH leads with all collected info:
[
  { car_model: "Seal", destination_country: "UAE", destination_port: "Dubai",
    color_quantity: [{ color: "black", qty: 10 }] },
  { car_model: "Atto 3", destination_country: "Saudi Arabia",
    color_quantity: [{ color: "red", qty: ? }, { color: "white", qty: ? }] }
]

NOT just the latest mentioned info.
```

---

## Summary of Changes

| Area | Change |
|------|--------|
| Lead creation | Batch replace instead of incremental update |
| Conversation closure | Remove HUMAN_NOW/FAQ_END closure, keep 3-day timeout only |
| Inbox UI | Group by contact instead of conversation |
| Claude prompt | Normalize car_model, full conversation summary, strict color_quantity |

## Files to Modify

1. `lib/repositories/lead.repository.js` - Add replaceConversationLeads, remove old functions
2. `lib/session.js` - Use replaceConversationLeads, remove conversation closure
3. `app/dashboard/inbox/page.js` - Restructure for contact-based view
4. `app/dashboard/components/ConversationList.js` - Rename to ContactList.js
5. `src/claude.service.js` - Update prompt with new instructions
