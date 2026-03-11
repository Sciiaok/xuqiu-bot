---
name: production-debugger
description: Debug production issues for the lead_engine_next WhatsApp chatbot system. Use this skill whenever the user asks to check live or production logs, SSH to the server, inspect PM2 processes, investigate why a contact or lead was not processed, or verify a suspected production fix by running relevant local tests. This skill should also trigger when the user mentions线上, production, prod, PM2, server logs, queue-cron, lead-sync-cron, webhook failures, or asks to "go online and check logs" even if they do not explicitly ask for a skill.
---

# Production Debugger

Systematic approach to debugging production issues in the lead_engine_next system. The system runs on AWS EC2, uses Supabase as the database, and PM2 for process management.

## Infrastructure

- **SSH alias source**: read from environment variable `SSH_ALIAS`
- **App directory**: `~/lead_engine_next`
- **PM2 processes**:
  - `lead_engine_next` — Next.js app (webhook, dashboard)
  - `queue-cron` — Polls and processes the message queue
  - `lead-sync-cron` — Syncs approved leads

## Required Checks Before SSH

Before any SSH-based step:

1. Resolve the SSH alias in this order:
   - current environment variable `SSH_ALIAS`
   - `.env.local`
   - `.env`
2. Read only the `SSH_ALIAS=` line from env files when falling back
3. If no value is found, stop and tell the user `SSH_ALIAS` is not set in the environment or env files
4. Use the helper script `./.claude/skills/production-debugger/scripts/ssh_prod.sh` instead of hardcoding an alias

The skill must never assume a server alias like `aws-foggy`. It must always resolve `SSH_ALIAS` from the environment or local env files.

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
./.claude/skills/production-debugger/scripts/ssh_prod.sh "pm2 list"

# Search logs for a specific contact
./.claude/skills/production-debugger/scripts/ssh_prod.sh \
  "bash -lc 'pm2 logs lead_engine_next --lines 2000 --nostream 2>&1 | grep -i -- \"<wa_id>\"'"

# Search for error patterns
./.claude/skills/production-debugger/scripts/ssh_prod.sh \
  "bash -lc 'pm2 logs lead_engine_next --lines 2000 --nostream 2>&1 | grep -i -E \"(error|failed|feishu|HUMAN_NOW)\"'"

# Get context around errors
./.claude/skills/production-debugger/scripts/ssh_prod.sh \
  "bash -lc 'pm2 logs lead_engine_next --lines 5000 --nostream 2>&1 | grep -B5 -A5 -- \"<error_pattern>\"'"

# Check queue-cron logs
./.claude/skills/production-debugger/scripts/ssh_prod.sh \
  "bash -lc 'pm2 logs queue-cron --lines 500 --nostream 2>&1 | grep -i -- \"error\"'"

# Count occurrences of an error
./.claude/skills/production-debugger/scripts/ssh_prod.sh \
  "bash -lc 'pm2 logs lead_engine_next --lines 5000 --nostream 2>&1 | grep -c -- \"<pattern>\"'"
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

### Step 4: Run Relevant Tests Locally

After collecting live evidence, run the smallest useful local test set that can confirm or falsify the hypothesis.

Use these defaults:

```bash
# Shared-number routing, inbound image handling, queue metadata
npm run test:webhook-tdd

# Full current unit suite for this repo
node --experimental-loader ./tests/unit/loaders/next-server-loader.mjs \
  --experimental-test-module-mocks \
  --test tests/unit/*.test.js

# Specific inbox media UI regression
npx playwright test tests/e2e/inbox-media-upload.spec.js
```

Selection rules:

- If the issue is webhook, queue, routing, referral, or inbound media related, start with `npm run test:webhook-tdd`
- If the scope is broader or the fix touched several services, run the full unit suite
- If the user is investigating an inbox UI or upload regression, run the specific Playwright spec
- Do not run large unrelated suites just to look busy

### Step 5: Trace the Message Pipeline

Use this mental model to connect live logs to code paths:

```
WhatsApp webhook → message_queue (deduplicated by wa_message_id)
  → queue-processor.js (acquires + locks pending messages)
  → session.js / conversation-context.service.js (loads contact, conversation, lead, messages)
  → agent-routing.service.js / agent-router.service.js (shared-number routing)
  → claude.service.js getResponse() (analyzes intent, extracts leads, can include images)
  → session.js processMessageForConversation() (persists user/assistant messages, replaces leads)
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

## Current Code Paths Worth Checking

- `app/api/webhook/route.js` — ingress, queueing, referral capture, trace logs
- `lib/queue-processor.js` — aggregation, router invocation, Claude call, reply send
- `lib/conversation-context.service.js` — shared-number conversation reuse and phone number tracking
- `src/agent-router.service.js` — Claude tool-use agent selection and clarification
- `src/claude.service.js` — multimodal image attachment to Claude
- `src/routing.service.js` — HUMAN_NOW / FAQ_END execution

## Expected Report Structure

When using this skill, summarize findings in this order:

1. `Live evidence`
   Include exact PM2 process or log signals found
2. `DB or state evidence`
   Include the minimum rows or fields that explain the behavior
3. `Local verification`
   State which tests were run and whether they passed
4. `Conclusion`
   State the most likely root cause or confirm that the issue could not yet be reproduced locally
5. `Next action`
   State the concrete next command or code area to inspect

## Known Gotchas

- **Feishu UUID limit**: The Feishu API `uuid` field has a 50-character maximum. Longer dedup keys cause "field validation failed" and the notification silently fails.
- **Fire-and-forget Feishu sends**: `routeLeadToSales` doesn't await the Feishu call. Errors are caught and logged but routing still reports success.
- **replaceConversationLeads is non-atomic**: Deletes all leads then inserts new ones. If insert fails, leads are lost.
- **handoff_summary not persisted**: `replaceConversationLeads` doesn't include `handoff_summary` in the insert. The field is passed separately to the routing function but is null on the lead record.
- **Missing SSH_ALIAS**: if `SSH_ALIAS` is unset, production log inspection is blocked until the environment variable is exported.
