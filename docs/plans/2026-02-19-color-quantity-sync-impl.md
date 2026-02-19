# Color Quantity Expansion Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expand color_quantity array when syncing leads to external system, generating one inquiry per color.

**Architecture:** Modify `external-sync.js` to expand leads by color before API call. Each color becomes a separate inquiry with `external_id: {lead_id}_{color}`. Results are merged back per lead for sync log tracking.

**Tech Stack:** Node.js ES modules, Supabase, External REST API

---

## Task 1: Add expandLeadForSync Function

**Files:**
- Modify: `lib/services/external-sync.js:1-52`

**Step 1: Add buildBaseInquiry helper function**

Add after line 17 (after `convertQtyBucket`):

```javascript
/**
 * Build base inquiry object without color-specific fields
 * @param {Object} lead
 * @returns {Object}
 */
function buildBaseInquiry(lead) {
  return {
    lead_key: lead.lead_key || undefined,
    customer: {
      name: lead.contact?.company_name || lead.contact?.name || 'Unknown',
      country: lead.destination_country || 'Unknown',
    },
    inquiry: {
      brand: lead.brand || 'Unknown',
      model: lead.car_model || 'Unknown',
      port_of_loading: lead.loading_port || undefined,
      port_of_discharge: lead.destination_port || undefined,
      incoterm: lead.incoterm || undefined,
      timeline: lead.timeline || undefined,
    },
  };
}
```

**Step 2: Add expandLeadForSync function**

Add after `buildBaseInquiry`:

```javascript
/**
 * Expand lead into multiple inquiry items by color_quantity
 * @param {Object} lead
 * @returns {Array} - Array of inquiry items for external API
 */
export function expandLeadForSync(lead) {
  const colorQuantity = lead.color_quantity || [];
  const base = buildBaseInquiry(lead);
  const qtyBucketNote = lead.qty_bucket ? `qty_bucket: ${lead.qty_bucket}` : '';

  // No color_quantity: single inquiry with warning note
  if (colorQuantity.length === 0) {
    const notes = lead.extra_data?.notes
      ? `${lead.extra_data.notes}; 颜色信息待确认; ${qtyBucketNote}`
      : `颜色信息待确认; ${qtyBucketNote}`;

    return [{
      external_id: lead.id,
      lead_key: base.lead_key,
      customer: base.customer,
      inquiry: {
        ...base.inquiry,
        quantity: convertQtyBucket(lead.qty_bucket),
        notes: notes.trim().replace(/; $/, ''),
      },
    }];
  }

  // Expand each color into separate inquiry
  return colorQuantity.map(cq => {
    const colorNote = `Color: ${cq.color}`;
    const notes = lead.extra_data?.notes
      ? `${lead.extra_data.notes}; ${colorNote}; ${qtyBucketNote}`
      : `${colorNote}; ${qtyBucketNote}`;

    return {
      external_id: `${lead.id}_${cq.color}`,
      lead_key: base.lead_key,
      customer: base.customer,
      inquiry: {
        ...base.inquiry,
        quantity: cq.qty || 1,
        notes: notes.trim().replace(/; $/, ''),
      },
    };
  });
}
```

**Step 3: Verify syntax**

Run: `node --check lib/services/external-sync.js`
Expected: No output (syntax OK)

**Step 4: Commit**

```bash
git add lib/services/external-sync.js
git commit -m "feat(sync): add expandLeadForSync function for color expansion"
```

---

## Task 2: Update syncLeadsToExternal to Use Expansion

**Files:**
- Modify: `lib/services/external-sync.js:60-86`

**Step 1: Modify syncLeadsToExternal function**

Replace lines 69 with flatMap expansion:

```javascript
export async function syncLeadsToExternal(leads, apiKey) {
  if (!apiKey) {
    throw new Error('REVO_SCM_API_KEY is not configured');
  }

  if (!leads || leads.length === 0) {
    return { success: true, summary: { total: 0 }, results: [] };
  }

  // Expand leads by color_quantity (one lead may become multiple items)
  const items = leads.flatMap(expandLeadForSync);

  const response = await fetch(REVO_SCM_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({ mode: 'skip', items }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`External API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}
```

**Step 2: Verify syntax**

Run: `node --check lib/services/external-sync.js`
Expected: No output (syntax OK)

**Step 3: Commit**

```bash
git add lib/services/external-sync.js
git commit -m "feat(sync): update syncLeadsToExternal to expand by color"
```

---

## Task 3: Update processSyncResults for Merged Results

**Files:**
- Modify: `lib/services/external-sync.js:88-122`

**Step 1: Rewrite processSyncResults to merge expanded results**

Replace the entire function:

```javascript
/**
 * Process sync results and merge expanded inquiry results back to lead level
 * @param {Array} leads - Original leads
 * @param {Object} apiResponse - API response
 * @returns {Array} - Array of { leadId, status, externalIds, externalNos, expandedCount, error }
 */
export function processSyncResults(leads, apiResponse) {
  const results = [];

  for (const lead of leads) {
    // Find all results for this lead (exact match or prefixed with lead.id_)
    const relatedResults = (apiResponse.results || []).filter(
      r => r.external_id === lead.id || r.external_id.startsWith(`${lead.id}_`)
    );

    if (relatedResults.length === 0) {
      results.push({
        leadId: lead.id,
        status: 'failed',
        externalIds: [],
        externalNos: [],
        expandedCount: 0,
        error: 'No result returned from API',
      });
      continue;
    }

    // Check if all expanded inquiries succeeded
    const hasError = relatedResults.some(r => r.status === 'error');
    const externalIds = relatedResults
      .map(r => r.inquiry_id)
      .filter(Boolean);
    const externalNos = relatedResults
      .map(r => r.inquiry_no)
      .filter(Boolean);
    const firstError = relatedResults.find(r => r.error)?.error || null;

    results.push({
      leadId: lead.id,
      status: hasError ? 'failed' : 'success',
      externalIds,
      externalNos,
      expandedCount: relatedResults.length,
      error: firstError,
    });
  }

  return results;
}
```

**Step 2: Verify syntax**

Run: `node --check lib/services/external-sync.js`
Expected: No output (syntax OK)

**Step 3: Commit**

```bash
git add lib/services/external-sync.js
git commit -m "feat(sync): update processSyncResults to merge expanded results"
```

---

## Task 4: Update sync-log.repository for Array Fields

**Files:**
- Modify: `lib/repositories/sync-log.repository.js:30-52`

**Step 1: Update updateSyncLog to handle arrays**

Modify the externalId and externalNo handling in updateSyncLog:

```javascript
export async function updateSyncLog(logId, updates) {
  const updateData = {
    updated_at: new Date().toISOString(),
  };

  if (updates.status !== undefined) updateData.status = updates.status;
  // Handle array or single value for externalId
  if (updates.externalId !== undefined) {
    updateData.external_id = Array.isArray(updates.externalId)
      ? updates.externalId.join(',')
      : updates.externalId;
  }
  // Handle array or single value for externalNo
  if (updates.externalNo !== undefined) {
    updateData.external_no = Array.isArray(updates.externalNo)
      ? updates.externalNo.join(',')
      : updates.externalNo;
  }
  if (updates.responsePayload !== undefined) updateData.response_payload = updates.responsePayload;
  if (updates.errorMessage !== undefined) updateData.error_message = updates.errorMessage;
  if (updates.retryCount !== undefined) updateData.retry_count = updates.retryCount;
  if (updates.syncedAt !== undefined) updateData.synced_at = updates.syncedAt;

  const { data, error } = await supabase
    .from('lead_sync_logs')
    .update(updateData)
    .eq('id', logId)
    .select()
    .single();

  if (error) throw error;
  return data;
}
```

**Step 2: Verify syntax**

Run: `node --check lib/repositories/sync-log.repository.js`
Expected: No output (syntax OK)

**Step 3: Commit**

```bash
git add lib/repositories/sync-log.repository.js
git commit -m "feat(sync): support array externalId/externalNo in sync log"
```

---

## Task 5: Update Cron Route for New Result Format

**Files:**
- Modify: `app/api/cron/sync-leads/route.js:79-104`

**Step 1: Update log update logic for new result format**

Replace the results loop (lines 80-103):

```javascript
        // Update logs
        for (const result of results) {
          const logEntry = batchLogs.find(bl => bl.lead.id === result.leadId);
          if (logEntry) {
            await updateSyncLog(logEntry.log.id, {
              status: result.status,
              externalId: result.externalIds,  // Now an array
              externalNo: result.externalNos,  // Now an array
              responsePayload: apiResponse,
              errorMessage: result.error,
              syncedAt: result.status === 'success' ? new Date().toISOString() : null,
            });
          }

          if (result.status === 'success') {
            // Count based on expanded inquiries
            const createdCount = (apiResponse.results || []).filter(
              r => (r.external_id === result.leadId || r.external_id.startsWith(`${result.leadId}_`))
                && r.status === 'created'
            ).length;
            const skippedCount = result.expandedCount - createdCount;
            totalCreated += createdCount;
            totalSkipped += skippedCount;
          } else {
            totalFailed++;
          }
        }
```

**Step 2: Verify syntax**

Run: `node --check app/api/cron/sync-leads/route.js`
Expected: No output (syntax OK)

**Step 3: Commit**

```bash
git add app/api/cron/sync-leads/route.js
git commit -m "feat(sync): update cron route for expanded result format"
```

---

## Task 6: Update createSyncLog Request Payload

**Files:**
- Modify: `app/api/cron/sync-leads/route.js:45-49`

**Step 1: Update request payload to use expandLeadForSync**

Update the import and createSyncLog call:

At line 11, add `expandLeadForSync` to import:
```javascript
import { syncLeadsToExternal, processSyncResults, expandLeadForSync } from '@/lib/services/external-sync';
```

At line 48, change `transformLeadForSync` to `expandLeadForSync`:
```javascript
        const newLog = await createSyncLog({
          leadId: lead.id,
          status: 'syncing',
          requestPayload: expandLeadForSync(lead),  // Now returns array
        });
```

**Step 2: Verify syntax**

Run: `node --check app/api/cron/sync-leads/route.js`
Expected: No output (syntax OK)

**Step 3: Commit**

```bash
git add app/api/cron/sync-leads/route.js
git commit -m "feat(sync): use expandLeadForSync for request payload logging"
```

---

## Task 7: Remove Unused transformLeadForSync

**Files:**
- Modify: `lib/services/external-sync.js`

**Step 1: Remove transformLeadForSync function**

Delete the entire `transformLeadForSync` function (lines 19-52 in original file, now shifted due to additions).

**Step 2: Verify syntax**

Run: `node --check lib/services/external-sync.js`
Expected: No output (syntax OK)

**Step 3: Commit**

```bash
git add lib/services/external-sync.js
git commit -m "refactor(sync): remove unused transformLeadForSync"
```

---

## Task 8: Manual Integration Test

**Step 1: Start dev server**

Run: `npm run dev`

**Step 2: Create test lead with color_quantity**

Use Supabase dashboard or SQL to insert a test lead:
```sql
UPDATE leads
SET color_quantity = '[{"color": "black", "qty": 10}, {"color": "white", "qty": 5}]'::jsonb,
    approved = true,
    approved_at = NOW()
WHERE id = '<test-lead-id>';
```

**Step 3: Trigger sync manually**

```bash
curl -X POST http://localhost:3002/api/cron/sync-leads \
  -H "Authorization: Bearer $CRON_SECRET"
```

**Step 4: Verify results**

Check:
1. External API received 2 items (one per color)
2. `lead_sync_logs` has comma-separated external_ids
3. Response shows correct created/skipped counts

**Step 5: Final commit if needed**

```bash
git add -A
git commit -m "test: verify color_quantity expansion sync"
```
