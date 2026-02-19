# Color Quantity Expansion for External Sync

## Overview

Expand `color_quantity` array when syncing leads to external system. Each color generates a separate inquiry record.

## Requirements

- One lead with multiple colors → multiple inquiries to external API
- External ID format: `{lead_id}_{color_name}` (e.g., `abc123_black`)
- Quantity: use actual qty from color_quantity, keep qty_bucket in notes
- Sync log: one log per lead, merge results from expanded inquiries
- No color_quantity: sync as single inquiry with "颜色信息待确认" in notes

## Design

### Data Transformation

New function `expandLeadForSync(lead)` in `lib/services/external-sync.js`:

```javascript
export function expandLeadForSync(lead) {
  const colorQuantity = lead.color_quantity || [];

  if (colorQuantity.length === 0) {
    return [{
      external_id: lead.id,
      // ... base fields
      inquiry: {
        quantity: convertQtyBucket(lead.qty_bucket),
        notes: "颜色信息待确认; qty_bucket: " + lead.qty_bucket,
      },
    }];
  }

  return colorQuantity.map(cq => ({
    external_id: `${lead.id}_${cq.color}`,
    // ... base fields
    inquiry: {
      quantity: cq.qty || 1,
      notes: `Color: ${cq.color}; qty_bucket: ${lead.qty_bucket}`,
    },
  }));
}
```

### Sync Flow

1. `syncLeadsToExternal` calls `expandLeadForSync` for each lead
2. Flattens expanded items into single batch request
3. External API receives multiple items (more than original lead count)

### Result Processing

`processSyncResults` merges results by lead:

- Match results by `external_id` prefix (exact match or starts with `{lead_id}_`)
- Status: `success` if all expanded inquiries succeed, `failed` if any fails
- Store comma-separated external IDs/Nos in sync log

### Edge Cases

| Scenario | Handling |
|----------|----------|
| `color_quantity: []` | Single inquiry, notes: "颜色信息待确认" |
| `qty: null` | Default to 1 |
| Special chars in color | Preserved in external_id |
| Partial success | Lead marked failed, error logged |
| Retry with partial success | External API `mode: 'skip'` handles duplicates |

## Files to Modify

1. `lib/services/external-sync.js` — add `expandLeadForSync`, modify `transformLeadForSync`, `syncLeadsToExternal`, `processSyncResults`
2. `lib/repositories/sync-log.repository.js` — support array externalId/externalNo in `updateSyncLog`
3. `app/api/cron/sync-leads/route.js` — adapt to new `processSyncResults` return format
