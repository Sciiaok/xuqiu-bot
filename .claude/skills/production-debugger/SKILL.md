---
name: production-debugger
description: Debug production issues for the lead_engine_next WhatsApp chatbot system. Use this skill when investigating why a contact didn't receive a Feishu notification, why a message wasn't processed, why routing failed, or any production anomaly involving contacts, leads, conversations, or the message queue. Trigger whenever the user mentions debugging production, checking logs, investigating a contact/lead issue, or asks "why didn't X happen" about the live system.
---

# Production Debugger

Systematic approach to debugging production issues in the lead_engine_next system. The system runs on AWS EC2, uses Supabase as the database, and PM2 for process management.

## Infrastructure

- **Server**: `aws-foggy` (SSH alias)
- **App directory**: `~/lead_engine_next`
- **PM2 processes**:
  - `lead_engine_next` — Next.js app (webhook, dashboard)
  - `queue-cron` — Polls and processes the message queue
  - `lead-sync-cron` — Syncs approved leads

## Debugging Workflow

Follow these steps in order. Each step narrows the scope — skip ahead only if you already know where the problem is.

### Step 1: Identify the Entity

Determine what you're investigating. The user will typically provide one of:
- A WhatsApp ID (wa_id) — e.g., `9647830790075`
- A contact name or company
- A conversation ID or lead ID
- A symptom — e.g., "Feishu notification wasn't sent"

### Step 2: Query Database State

Run the analyze script to get a full picture of the contact's data:

```bash
node scripts/analyze-contact.js <wa_id>
```

This shows: contact info, conversations, leads (with route/quality/intent), and message history.

For deeper investigation, write inline Node.js queries against Supabase:

```bash
node -e "
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
);

async function debug() {
  // Query what you need — leads, message_queue, etc.
  const { data } = await supabase
    .from('leads')
    .select('*, contact:contacts(wa_id, name, company_name)')
    .eq('conversation_id', '<conv_id>');
  console.log(JSON.stringify(data, null, 2));
}

debug().catch(console.error);
"
```

**Key tables and what to check:**

| Table | Key fields to inspect |
|-------|----------------------|
| `contacts` | `wa_id`, `name`, `company_name` |
| `conversations` | `status`, `message_count`, `last_message_at` |
| `leads` | `route`, `inquiry_quality`, `business_value`, `car_model`, `handoff_summary`, `created_at`, `updated_at` |
| `messages` | `role`, `content`, `sent_by`, `sent_at` |
| `message_queue` | `status`, `content`, `process_after`, `error_message` |

**Common DB-level red flags:**
- Lead has `route: HUMAN_NOW` but `handoff_summary: null` — `replaceConversationLeads` doesn't persist `handoff_summary`
- Lead has no `car_model` — `processMessage` skips `replaceConversationLeads` when no valid leads exist
- Message queue entries with `status: failed` — check `error_message`
- Conversation `message_count` near 60 — may have hit global max turns limit (30 turns), forcing `FAQ_END`

### Step 3: Check Server Logs

SSH into the server and search PM2 logs for relevant patterns:

```bash
# Check PM2 process status
ssh aws-foggy "pm2 list"

# Search logs for a specific contact
ssh aws-foggy "pm2 logs lead_engine_next --lines 2000 --nostream" 2>&1 | grep -i "<wa_id>"

# Search for error patterns
ssh aws-foggy "pm2 logs lead_engine_next --lines 2000 --nostream" 2>&1 | grep -i -E "(error|failed|feishu|HUMAN_NOW)"

# Get context around errors
ssh aws-foggy "pm2 logs lead_engine_next --lines 5000 --nostream" 2>&1 | grep -B5 -A5 "<error_pattern>"

# Check queue-cron logs
ssh aws-foggy "pm2 logs queue-cron --lines 500 --nostream" 2>&1 | grep -i "error"

# Count occurrences of an error
ssh aws-foggy "pm2 logs lead_engine_next --lines 5000 --nostream" 2>&1 | grep -c "<pattern>"
```

**Key log patterns:**

| Pattern | Meaning |
|---------|---------|
| `"✅ Lead xxx routed to sales (HUMAN_NOW)"` | Routing was attempted |
| `"Feishu notification failed:"` | Feishu API call failed (fire-and-forget, error swallowed) |
| `"No leads to route"` | `getLeadsByConversation` returned empty |
| `"Routing completed: N lead(s) routed"` | Routing finished successfully |
| `"Global max turns"` | Conversation forced to FAQ_END |
| `"Error processing queue for"` | Queue processing failed entirely |

### Step 4: Trace the Message Pipeline

```
WhatsApp webhook → message_queue (deduplicated by wa_message_id)
  → queue-processor.js (acquires + locks pending messages)
  → session.js getSession() (loads contact, conversation, lead, messages)
  → claude.service.js getResponse() (analyzes intent, extracts leads)
  → session.js processMessage() (validates car_model, replaceConversationLeads)
  → queue-processor.js (checks global max turns, determines finalRoute)
  → routing.service.js executeConversationRouting()
      → HUMAN_NOW: routeLeadToSales() → sendFeishuMessage() (fire-and-forget)
      → FAQ_END: sendFAQResources()
      → CONTINUE: no action
```

**Key decision points where things break:**

1. **Message not queued** — Check `message_queue` table for the wa_id
2. **Queue stuck** — Message status is `processing` but never completed
3. **Claude returned wrong route** — Lead has unexpected `route` value
4. **No valid leads** — `processMessage` requires at least one lead with `car_model`
5. **Routing skipped** — `finalRoute === 'CONTINUE'` skips routing entirely
6. **Feishu send failed silently** — fire-and-forget `.catch()` only logs. Check for `"Feishu notification failed:"`

## Known Gotchas

- **Feishu UUID limit**: The Feishu API `uuid` field has a 50-character maximum. Longer dedup keys cause "field validation failed" and the notification silently fails.
- **Fire-and-forget Feishu sends**: `routeLeadToSales` doesn't await the Feishu call. Errors are caught and logged but routing still reports success.
- **replaceConversationLeads is non-atomic**: Deletes all leads then inserts new ones. If insert fails, leads are lost.
- **handoff_summary not persisted**: `replaceConversationLeads` doesn't include `handoff_summary` in the insert. The field is passed separately to the routing function but is null on the lead record.
