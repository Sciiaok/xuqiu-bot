# Lead Reprocess Script Design

## Overview

Create scripts to merge historical conversations and reprocess leads for regression testing. This enables validating prompt changes against historical data.

## Requirements

1. **Merge historical conversations** - Combine all conversations for each contact into one (keep newest)
2. **Reprocess leads** - Re-extract leads using current Claude prompt
3. **Regression testing** - Compare new vs old leads, show diffs before overwriting
4. **Flexible execution** - Support `--contact-id`, `--limit`, `--all` parameters
5. **Safety controls** - Concurrency limits + `--dry-run` mode

## File Structure

```
scripts/
├── merge-conversations.js      # One-time migration script
└── reprocess-leads.js          # Regression testing script (reusable)

lib/
└── lead-extractor.js           # Core extraction logic module
```

| File | Responsibility | Lifecycle |
|------|----------------|-----------|
| `merge-conversations.js` | Merge multiple conversations per contact into one | One-time, archive after use |
| `reprocess-leads.js` | Read messages → extract → compare → optionally overwrite | Long-term reuse |
| `lead-extractor.js` | Encapsulate Claude API calls and lead parsing | Core module, used by multiple scripts |

## Script 1: merge-conversations.js

### Execution Flow

```
1. Query all contacts with multiple conversations
2. For each contact:
   ├── Find newest conversation (by last_message_at)
   ├── Migrate messages from other conversations to newest
   ├── Update newest conversation's message_count and time range
   ├── Delete leads associated with old conversations
   └── Delete empty old conversations
3. Output migration report
```

### Key SQL Operations

```sql
-- Migrate messages
UPDATE messages SET conversation_id = :newest_id
WHERE conversation_id IN (:old_conversation_ids)

-- Delete old leads
DELETE FROM leads WHERE conversation_id IN (:old_conversation_ids)

-- Delete old conversations
DELETE FROM conversations WHERE id IN (:old_conversation_ids)
```

### Safety Measures

- Default dry-run mode, outputs planned operations
- Requires `--execute` flag to actually run
- Shows affected contact count before execution

## Script 2: reprocess-leads.js

### CLI Interface

```bash
# Process single contact
node scripts/reprocess-leads.js --contact-id=xxx

# Process first N contacts
node scripts/reprocess-leads.js --limit=10

# Process all
node scripts/reprocess-leads.js --all

# Dry-run: compare only, no Claude API calls
node scripts/reprocess-leads.js --limit=10 --dry-run

# Auto-apply after comparison (no confirmation)
node scripts/reprocess-leads.js --limit=10 --apply
```

### Execution Flow

```
1. Parse arguments, determine contacts to process
2. For each contact (concurrency controlled, default 3):
   ├── Get all messages from their single conversation
   ├── Call lead-extractor for new leads (skip if dry-run)
   ├── Get existing leads from database
   ├── Compare old vs new leads, generate diff
   └── Collect results
3. Output comparison report (table format)
4. If --apply flag, execute overwrite
   Otherwise prompt user for confirmation
```

### Comparison Report Example

```
Contact: +86138xxxx (张三)
┌─────────────┬──────────────────┬──────────────────┐
│ Field       │ Old              │ New              │
├─────────────┼──────────────────┼──────────────────┤
│ car_model   │ Model Y          │ Model Y          │
│ destination │ Dubai            │ Abu Dhabi        │  ← changed
│ qty_bucket  │ 1-5              │ 6-20             │  ← changed
│ score       │ 45               │ 62               │  ← changed
└─────────────┴──────────────────┴──────────────────┘
```

## Module: lib/lead-extractor.js

### Interface

```javascript
/**
 * Extract leads from messages array
 * @param {Array} messages - Sorted messages [{role, content, sent_at}]
 * @param {Object} contextInfo - Optional context {contactName, companyName}
 * @returns {Object} { leads: [...], inquiry_quality, business_value, conversation_intent }
 */
export async function extractLeadsFromMessages(messages, contextInfo = {})

/**
 * Compare two sets of leads, generate diff report
 * @param {Array} oldLeads - Existing leads from database
 * @param {Array} newLeads - Newly extracted leads
 * @returns {Object} { changed: boolean, diffs: [...] }
 */
export function compareLeads(oldLeads, newLeads)

/**
 * Batch extraction with concurrency control
 * @param {Array} contacts - [{contactId, messages, contextInfo}]
 * @param {Object} options - {concurrency: 3, onProgress: fn}
 * @returns {Array} Extraction results array
 */
export async function batchExtractLeads(contacts, options = {})
```

### Implementation Notes

- `extractLeadsFromMessages` reuses `getResponse` from `claude.service.js`
- `compareLeads` matches leads by `car_model + destination_country`, compares field by field
- `batchExtractLeads` uses `p-limit` for concurrency control

## Error Handling

| Scenario | Handling |
|----------|----------|
| Claude API call fails | Log error, skip contact, continue to next |
| Rate limit | Exponential backoff retry (max 3 attempts) |
| Contact has no messages | Skip, output warning |
| Database operation fails | Rollback current contact changes, log error, continue |

## Edge Cases

| Scenario | Handling |
|----------|----------|
| New leads count differs from old | Mark as `+added` or `-removed` in diff |
| Contact has only 1 conversation | Merge script skips, no action needed |
| Messages array is empty | Skip extraction, preserve existing leads |

## Logging & Output

- Progress bar: `Processing: [=====>    ] 15/100 contacts`
- Error summary: List all failed contacts at script end
- Result file: Optional `--output=report.json` for detailed results
