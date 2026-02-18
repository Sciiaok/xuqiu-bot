# Remove message.lead_id Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove redundant `message.lead_id` column and related code to simplify the data model.

**Architecture:** Remove lead_id references from message repository and session.js, then drop the database column. Code changes first, then database migration.

**Tech Stack:** Next.js, Supabase, PostgreSQL

---

## Task 1: Remove lead_id from message.repository.js

**Files:**
- Modify: `lib/repositories/message.repository.js`

**Step 1: Remove lead_id from createMessage function**

Change lines 11-21 from:
```javascript
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: messageData.conversationId,
      role: messageData.role,
      content: messageData.content,
      score_delta: messageData.scoreDelta || 0,
      risk_flags: messageData.riskFlags || [],
      sent_at: messageData.sentAt || new Date().toISOString(),
      sent_by: messageData.sentBy,
      lead_id: messageData.leadId || null,  // Multi-lead support
      metadata: messageData.metadata || {},
    })
```

To:
```javascript
  const { data, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: messageData.conversationId,
      role: messageData.role,
      content: messageData.content,
      score_delta: messageData.scoreDelta || 0,
      risk_flags: messageData.riskFlags || [],
      sent_at: messageData.sentAt || new Date().toISOString(),
      sent_by: messageData.sentBy,
      metadata: messageData.metadata || {},
    })
```

**Step 2: Remove leadId from updateMessage function**

Remove these lines (46-47) from updateMessage:
```javascript
  if (updates.leadId !== undefined) updateData.lead_id = updates.leadId;
  if (updates.lead_id !== undefined) updateData.lead_id = updates.lead_id;
```

**Step 3: Delete getTotalScoreForLead function**

Delete lines 118-134 (the entire `getTotalScoreForLead` function).

**Step 4: Verify no syntax errors**

Run: `node --check lib/repositories/message.repository.js`
Expected: No output (success)

**Step 5: Commit**

```bash
git add lib/repositories/message.repository.js
git commit -m "refactor: remove lead_id from message repository

- Remove lead_id parameter from createMessage
- Remove leadId handling from updateMessage
- Delete unused getTotalScoreForLead function

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Remove lead_id references from session.js

**Files:**
- Modify: `lib/session.js`

**Step 1: Remove getTotalScoreForLead import**

Change line 21 from:
```javascript
  getTotalScoreForLead,
```

Remove this line entirely (it's no longer exported).

**Step 2: Remove updateMessage call for leadId (lines 169-174)**

Delete these lines:
```javascript
  // 4. Associate user message with first lead
  if (processedLeads.length > 0) {
    await updateMessage(userMessage.id, {
      leadId: processedLeads[0].id,
    });
  }
```

**Step 3: Remove leadId from assistant message creation (lines 177-186)**

Change from:
```javascript
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
```

To:
```javascript
  // 5. Create assistant message (skip if empty)
  if (claudeResponse.next_message && claudeResponse.next_message.trim() !== '') {
    await createMessage({
      conversationId: session.conversation_id,
      role: 'assistant',
      content: claudeResponse.next_message,
      sentBy: 'bot',
    });
    await updateConversationOnMessage(session.conversation_id);
  }
```

**Step 4: Remove updateMessage import if no longer needed**

Check if `updateMessage` is used elsewhere in the file. If not, remove it from the import statement (line 17).

**Step 5: Verify no syntax errors**

Run: `node --check lib/session.js`
Expected: No output (success)

**Step 6: Commit**

```bash
git add lib/session.js
git commit -m "refactor: remove lead_id references from session.js

- Remove getTotalScoreForLead import
- Remove updateMessage call for leadId association
- Remove leadId from assistant message creation

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Create database migration to drop lead_id column

**Files:**
- Create: `supabase/migrations/007_remove_message_lead_id.sql`

**Step 1: Create migration file**

```sql
-- supabase/migrations/007_remove_message_lead_id.sql
-- Remove redundant lead_id from messages table
-- Lead association is handled via conversation_id

-- Drop the index first
DROP INDEX IF EXISTS idx_messages_lead_id;

-- Remove the column
ALTER TABLE messages DROP COLUMN IF EXISTS lead_id;

-- Verification query:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'messages' AND column_name = 'lead_id';
-- Should return 0 rows
```

**Step 2: Commit migration**

```bash
git add supabase/migrations/007_remove_message_lead_id.sql
git commit -m "chore: add migration to remove messages.lead_id

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>"
```

**Note:** Run this migration on the database AFTER deploying the code changes.

---

## Task 4: Deploy and verify

**Step 1: Deploy code changes**

```bash
sh scripts/deploy.sh
```

**Step 2: Run database migration**

Run the SQL migration in Supabase SQL Editor or via CLI.

**Step 3: Verify system works**

- Send a test message via WhatsApp
- Check server logs for errors
- Verify messages are created without lead_id errors

---

## Summary

| Task | Description | Files |
|------|-------------|-------|
| 1 | Remove lead_id from message.repository.js | lib/repositories/message.repository.js |
| 2 | Remove lead_id references from session.js | lib/session.js |
| 3 | Create database migration | supabase/migrations/007_remove_message_lead_id.sql |
| 4 | Deploy and verify | - |
