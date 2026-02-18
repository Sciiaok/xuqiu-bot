# Remove message.lead_id Design

## Problem Statement

The `messages.lead_id` column was added in migration 006 to support per-lead message tracking and scoring. However, this design is redundant:

1. **Lead already has conversation_id** - All messages can be queried via `lead.conversation_id`
2. **Score is stored on lead directly** - `lead.score` is updated directly, not aggregated from messages
3. **`getTotalScoreForLead()` is unused** - The function exists but is never called in the main flow

This adds unnecessary complexity to the data model and code.

## Solution

Remove `message.lead_id` and related code to simplify the data model.

## Changes Required

### Database
- Remove `messages.lead_id` column
- Remove `idx_messages_lead_id` index

### Code Changes

**lib/repositories/message.repository.js:**
- `createMessage`: Remove `lead_id` parameter
- `updateMessage`: Remove `leadId` handling
- Delete `getTotalScoreForLead` function

**lib/session.js:**
- `processMessage`: Remove all `leadId` references (~4 locations)

## Impact Assessment

| Feature | Impact |
|---------|--------|
| Message creation/query | None - still linked via conversation_id |
| Lead management | None - score stored on lead table |
| Dashboard display | None - messages fetched via conversation |
| Multi-lead support | None - leads still work independently |

## Migration Strategy

1. Deploy code changes first (make lead_id optional/ignored)
2. Run database migration to drop column
3. No data migration needed (lead_id values are discarded)
