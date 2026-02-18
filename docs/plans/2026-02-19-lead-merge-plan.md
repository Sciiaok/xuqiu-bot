# Lead Merge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge leads when destination is added to an existing lead with same car_model but no destination.

**Architecture:** Add merge logic to `findOrCreateLeadByKey` - check for partial match before creating new lead.

**Tech Stack:** Next.js, Supabase, PostgreSQL

---

## Task 1: Add helper functions for lead key parsing

**Files:**
- Modify: `lib/repositories/lead.repository.js`

**Step 1: Add helper functions after mergeColorQuantity function (around line 35)**

```javascript
/**
 * Check if lead_key contains destination
 * @param {string} leadKey - Lead key string
 * @returns {boolean}
 */
function leadKeyHasDestination(leadKey) {
  return leadKey && leadKey.includes('dest:');
}

/**
 * Extract car_model part only from lead_key
 * "model:seal|dest:uae" → "model:seal"
 * @param {string} leadKey - Lead key string
 * @returns {string|null}
 */
function extractCarModelKey(leadKey) {
  if (!leadKey) return null;
  const parts = leadKey.split('|');
  const modelPart = parts.find(p => p.startsWith('model:'));
  return modelPart || null;
}
```

**Step 2: Verify no syntax errors**

Run: `node --check lib/repositories/lead.repository.js`
Expected: No output (success)

**Step 3: Commit**

```bash
git add lib/repositories/lead.repository.js
git commit -m "refactor: add lead key helper functions

- leadKeyHasDestination: check if key has destination
- extractCarModelKey: extract model part from key

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Modify findOrCreateLeadByKey with merge logic

**Files:**
- Modify: `lib/repositories/lead.repository.js:441-497`

**Step 1: Replace findOrCreateLeadByKey function**

Change the function to include merge logic:

```javascript
/**
 * Find or create lead by lead_key within a conversation
 * Uses lead_key for multi-lead support within same conversation
 * Supports merging: if new lead has destination and existing lead has same car_model but no destination, merge them
 * @param {string} conversationId - Conversation UUID
 * @param {string} contactId - Contact UUID
 * @param {string|null} leadKey - Lead identifier key (e.g., "model:byd seal|dest:uae")
 * @returns {Promise<Object>} - Lead object
 */
export async function findOrCreateLeadByKey(conversationId, contactId, leadKey) {
  // If no leadKey, use the default lead (backward compatibility)
  if (!leadKey) {
    return findOrCreateLead(conversationId, contactId);
  }

  // 1. Try to find existing active lead with exact key match
  const { data: exactMatch, error: findError } = await supabase
    .from('leads')
    .select('*')
    .eq('conversation_id', conversationId)
    .eq('lead_key', leadKey)
    .eq('route', 'CONTINUE')
    .maybeSingle();

  if (findError) {
    throw findError;
  }

  if (exactMatch) {
    return exactMatch;
  }

  // 2. Try merge: if new lead has destination, find lead with same car_model but no destination
  if (leadKeyHasDestination(leadKey)) {
    const carModelKey = extractCarModelKey(leadKey);
    if (carModelKey) {
      const { data: mergeable, error: mergeError } = await supabase
        .from('leads')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('lead_key', carModelKey)
        .eq('route', 'CONTINUE')
        .maybeSingle();

      if (mergeError) {
        throw mergeError;
      }

      if (mergeable) {
        // Update the existing lead's key to include destination
        console.log(`Merging lead ${mergeable.id}: ${carModelKey} → ${leadKey}`);
        await updateLead(mergeable.id, { leadKey: leadKey });
        return { ...mergeable, lead_key: leadKey };
      }
    }
  }

  // 3. Create new lead with lead_key
  const { data, error } = await supabase
    .from('leads')
    .insert({
      conversation_id: conversationId,
      contact_id: contactId,
      lead_key: leadKey,
      stage: 'GREET',
      score: 0,
      route: 'CONTINUE',
      inquiry_quality: 'GOOD',
      business_value: 'LOW',
    })
    .select()
    .single();

  if (error) {
    // Handle race condition: another request may have created the lead
    if (error.code === '23505') { // unique_violation
      const { data: existing2 } = await supabase
        .from('leads')
        .select('*')
        .eq('conversation_id', conversationId)
        .eq('lead_key', leadKey)
        .eq('route', 'CONTINUE')
        .single();
      if (existing2) return existing2;
    }
    throw error;
  }

  console.log(`Created new lead ${data.id} with key: ${leadKey}`);
  return data;
}
```

**Step 2: Verify no syntax errors**

Run: `node --check lib/repositories/lead.repository.js`
Expected: No output (success)

**Step 3: Commit**

```bash
git add lib/repositories/lead.repository.js
git commit -m "feat: add lead merge logic for progressive inquiries

When new lead has destination and existing lead has same car_model
but no destination, merge them instead of creating duplicate.

Example:
- Message 1: 'I want BYD Seal' → creates lead with key 'model:seal'
- Message 2: 'to Dubai' → updates existing lead key to 'model:seal|dest:uae'

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Deploy and verify

**Step 1: Deploy**

```bash
sh scripts/deploy.sh
```

**Step 2: Test scenario**

Send via WhatsApp:
1. "I want BYD Seal 05" → Should create lead with key `model:seal 05`
2. "to Dubai" → Should update same lead, key becomes `model:seal 05|dest:dubai`

**Step 3: Verify in database**

Check that only ONE lead exists for the conversation, not two.

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Add helper functions | lib/repositories/lead.repository.js |
| 2 | Add merge logic to findOrCreateLeadByKey | lib/repositories/lead.repository.js |
| 3 | Deploy and verify | - |
