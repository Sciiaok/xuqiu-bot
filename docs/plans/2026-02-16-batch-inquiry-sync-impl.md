# Batch Inquiry Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add lead approval and external SCM system sync functionality with cron-based automatic syncing.

**Architecture:** Extend existing leads table with approval fields, create sync log table, add API routes for approve/sync/edit operations, cron job for automatic sync, and UI components for user interactions.

**Tech Stack:** Next.js 16 (App Router), Supabase (PostgreSQL), React 18, TailwindCSS

---

## Task 1: Database Migration - Add Fields to Leads Table

**Files:**
- Create: `supabase/migrations/003_batch_sync_schema.sql`

**Step 1: Write the migration SQL file**

```sql
-- supabase/migrations/003_batch_sync_schema.sql
-- Batch Inquiry Sync Feature Migration

-- 1. Add new columns to leads table
ALTER TABLE leads ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS brand TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS approved_by TEXT;

-- 2. Create index for approved leads
CREATE INDEX IF NOT EXISTS idx_leads_approved ON leads(approved) WHERE approved = TRUE;
CREATE INDEX IF NOT EXISTS idx_leads_approved_at ON leads(approved_at);

-- 3. Create lead_sync_logs table
CREATE TABLE IF NOT EXISTS lead_sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  external_id TEXT,
  external_no TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'syncing', 'success', 'failed')),
  request_payload JSONB,
  response_payload JSONB,
  error_message TEXT,
  retry_count INT DEFAULT 0,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Create indexes for sync logs
CREATE INDEX IF NOT EXISTS idx_sync_logs_lead_id ON lead_sync_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_status ON lead_sync_logs(status);
CREATE INDEX IF NOT EXISTS idx_sync_logs_created_at ON lead_sync_logs(created_at);

-- 5. Enable realtime for sync logs
ALTER TABLE lead_sync_logs REPLICA IDENTITY FULL;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE lead_sync_logs;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
```

**Step 2: Apply migration to Supabase**

Run this SQL in Supabase SQL Editor (Dashboard > SQL Editor > New Query).

**Step 3: Verify migration**

Run in SQL Editor:
```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'leads' AND column_name IN ('approved', 'brand', 'approved_at', 'approved_by');

SELECT table_name FROM information_schema.tables WHERE table_name = 'lead_sync_logs';
```

Expected: 4 columns found in leads, lead_sync_logs table exists.

**Step 4: Commit**

```bash
git add supabase/migrations/003_batch_sync_schema.sql
git commit -m "feat(db): add approved fields to leads and create sync_logs table"
```

---

## Task 2: Sync Log Repository

**Files:**
- Create: `lib/repositories/sync-log.repository.js`
- Modify: `lib/repositories/index.js`

**Step 1: Create sync-log repository**

```javascript
// lib/repositories/sync-log.repository.js
import supabase from '../supabase.js';

/**
 * Create a sync log entry
 * @param {Object} logData
 * @returns {Promise<Object>}
 */
export async function createSyncLog(logData) {
  const { data, error } = await supabase
    .from('lead_sync_logs')
    .insert({
      lead_id: logData.leadId,
      status: logData.status || 'pending',
      request_payload: logData.requestPayload || null,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Update sync log
 * @param {string} logId
 * @param {Object} updates
 * @returns {Promise<Object>}
 */
export async function updateSyncLog(logId, updates) {
  const updateData = {
    updated_at: new Date().toISOString(),
  };

  if (updates.status !== undefined) updateData.status = updates.status;
  if (updates.externalId !== undefined) updateData.external_id = updates.externalId;
  if (updates.externalNo !== undefined) updateData.external_no = updates.externalNo;
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

/**
 * Get latest sync log for a lead
 * @param {string} leadId
 * @returns {Promise<Object|null>}
 */
export async function getLatestSyncLog(leadId) {
  const { data, error } = await supabase
    .from('lead_sync_logs')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/**
 * Check if lead has successful sync
 * @param {string} leadId
 * @returns {Promise<boolean>}
 */
export async function hasSuccessfulSync(leadId) {
  const { data, error } = await supabase
    .from('lead_sync_logs')
    .select('id')
    .eq('lead_id', leadId)
    .eq('status', 'success')
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return !!data;
}

/**
 * Get failed logs that need retry (retry_count <= 3)
 * @param {string} leadId
 * @returns {Promise<Object|null>}
 */
export async function getRetryableFailedLog(leadId) {
  const { data, error } = await supabase
    .from('lead_sync_logs')
    .select('*')
    .eq('lead_id', leadId)
    .eq('status', 'failed')
    .lte('retry_count', 3)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/**
 * Increment retry count
 * @param {string} logId
 * @returns {Promise<Object>}
 */
export async function incrementRetryCount(logId) {
  const { data: current } = await supabase
    .from('lead_sync_logs')
    .select('retry_count')
    .eq('id', logId)
    .single();

  return updateSyncLog(logId, {
    retryCount: (current?.retry_count || 0) + 1,
    status: 'syncing',
  });
}
```

**Step 2: Update repository index**

Add to `lib/repositories/index.js`:

```javascript
export * from './sync-log.repository.js';
```

**Step 3: Commit**

```bash
git add lib/repositories/sync-log.repository.js lib/repositories/index.js
git commit -m "feat: add sync log repository"
```

---

## Task 3: Update Lead Repository

**Files:**
- Modify: `lib/repositories/lead.repository.js`

**Step 1: Add approve and brand field support**

Add these functions to `lib/repositories/lead.repository.js`:

```javascript
/**
 * Approve a lead
 * @param {string} leadId
 * @param {string} approvedBy - 'auto' or 'manual'
 * @returns {Promise<Object>}
 */
export async function approveLead(leadId, approvedBy = 'manual') {
  const { data, error } = await supabase
    .from('leads')
    .update({
      approved: true,
      approved_at: new Date().toISOString(),
      approved_by: approvedBy,
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Batch approve leads
 * @param {string[]} leadIds
 * @param {string} approvedBy
 * @returns {Promise<number>} - Count of approved leads
 */
export async function batchApproveleads(leadIds, approvedBy = 'manual') {
  const { data, error } = await supabase
    .from('leads')
    .update({
      approved: true,
      approved_at: new Date().toISOString(),
      approved_by: approvedBy,
      updated_at: new Date().toISOString(),
    })
    .in('id', leadIds)
    .eq('approved', false)
    .select('id');

  if (error) throw error;
  return data?.length || 0;
}

/**
 * Get approved leads that need sync (last 24h, no successful sync)
 * @returns {Promise<Array>}
 */
export async function getLeadsNeedingSync() {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('leads')
    .select(`
      *,
      contact:contacts(wa_id, company_name, name)
    `)
    .eq('approved', true)
    .gte('approved_at', twentyFourHoursAgo)
    .order('approved_at', { ascending: true });

  if (error) throw error;
  return data || [];
}

/**
 * Get lead by ID with contact info
 * @param {string} leadId
 * @returns {Promise<Object|null>}
 */
export async function getLeadById(leadId) {
  const { data, error } = await supabase
    .from('leads')
    .select(`
      *,
      contact:contacts(wa_id, company_name, name)
    `)
    .eq('id', leadId)
    .single();

  if (error && error.code !== 'PGRST116') throw error;
  return data;
}

/**
 * Update lead fields
 * @param {string} leadId
 * @param {Object} fields
 * @returns {Promise<Object>}
 */
export async function updateLeadFields(leadId, fields) {
  const updateData = {
    updated_at: new Date().toISOString(),
  };

  // Map all supported fields
  const fieldMap = {
    brand: 'brand',
    carModel: 'car_model',
    destinationCountry: 'destination_country',
    destinationPort: 'destination_port',
    qtyBucket: 'qty_bucket',
    buyerType: 'buyer_type',
    timeline: 'timeline',
    incoterm: 'incoterm',
    loadingPort: 'loading_port',
    approved: 'approved',
    stage: 'stage',
    score: 'score',
    route: 'route',
    handoffSummary: 'handoff_summary',
  };

  for (const [camelKey, snakeKey] of Object.entries(fieldMap)) {
    if (fields[camelKey] !== undefined) {
      updateData[snakeKey] = fields[camelKey];
    }
    // Also check snake_case keys from API
    if (fields[snakeKey] !== undefined) {
      updateData[snakeKey] = fields[snakeKey];
    }
  }

  // Handle approval timestamp
  if (fields.approved === true) {
    updateData.approved_at = new Date().toISOString();
    updateData.approved_by = 'manual';
  }

  const { data, error } = await supabase
    .from('leads')
    .update(updateData)
    .eq('id', leadId)
    .select()
    .single();

  if (error) throw error;
  return data;
}
```

**Step 2: Update updateLead to support brand**

Modify the existing `updateLead` function to add brand support:

```javascript
// Add to the field mapping in updateLead function
if (updates.brand !== undefined) updateData.brand = updates.brand;
```

**Step 3: Commit**

```bash
git add lib/repositories/lead.repository.js
git commit -m "feat: add approve and sync-related functions to lead repository"
```

---

## Task 4: External Sync Service

**Files:**
- Create: `lib/services/external-sync.js`

**Step 1: Create external sync service**

```javascript
// lib/services/external-sync.js

const REVO_SCM_API = 'https://www.revoscm.cn/api/external/inquiries/batch';

/**
 * Convert qty_bucket to numeric quantity
 * @param {string} bucket
 * @returns {number}
 */
function convertQtyBucket(bucket) {
  switch (bucket) {
    case '1-5': return 3;
    case '6-20': return 10;
    case '20+': return 25;
    default: return 1;
  }
}

/**
 * Transform lead to external API format
 * @param {Object} lead
 * @returns {Object}
 */
export function transformLeadForSync(lead) {
  return {
    external_id: lead.id,
    customer: {
      name: lead.contact?.company_name || lead.contact?.name || 'Unknown',
      country: lead.destination_country || 'Unknown',
    },
    inquiry: {
      brand: lead.brand || 'Unknown',
      model: lead.car_model || 'Unknown',
      quantity: convertQtyBucket(lead.qty_bucket),
      port_of_loading: lead.loading_port || undefined,
      port_of_discharge: lead.destination_port || undefined,
      notes: lead.extra_data?.notes || undefined,
    },
  };
}

/**
 * Sync leads to external system
 * @param {Array} leads - Array of lead objects
 * @param {string} apiKey - API key for authentication
 * @returns {Promise<Object>} - API response
 */
export async function syncLeadsToExternal(leads, apiKey) {
  if (!apiKey) {
    throw new Error('REVO_SCM_API_KEY is not configured');
  }

  if (!leads || leads.length === 0) {
    return { success: true, summary: { total: 0 }, results: [] };
  }

  const items = leads.map(transformLeadForSync);

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

/**
 * Process sync results and return individual lead results
 * @param {Array} leads - Original leads
 * @param {Object} apiResponse - API response
 * @returns {Array} - Array of { leadId, status, externalId, externalNo, error }
 */
export function processSyncResults(leads, apiResponse) {
  const results = [];

  for (const lead of leads) {
    const resultItem = apiResponse.results?.find(
      r => r.external_id === lead.id
    );

    if (resultItem) {
      results.push({
        leadId: lead.id,
        status: resultItem.status === 'error' ? 'failed' : 'success',
        externalId: resultItem.inquiry_id,
        externalNo: resultItem.inquiry_no,
        error: resultItem.error || null,
      });
    } else {
      results.push({
        leadId: lead.id,
        status: 'failed',
        externalId: null,
        externalNo: null,
        error: 'No result returned from API',
      });
    }
  }

  return results;
}
```

**Step 2: Commit**

```bash
git add lib/services/external-sync.js
git commit -m "feat: add external sync service for revoscm API"
```

---

## Task 5: Edit Lead API

**Files:**
- Create: `app/api/leads/[id]/route.js`

**Step 1: Create the API route**

```javascript
// app/api/leads/[id]/route.js
import { NextResponse } from 'next/server';
import { createServerClient } from '@/lib/supabase-server';
import { getLeadById, updateLeadFields } from '@/lib/repositories/lead.repository';

export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const lead = await getLeadById(id);

    if (!lead) {
      return NextResponse.json(
        { success: false, error: 'Lead not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, lead });
  } catch (error) {
    console.error('Error fetching lead:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

export async function PATCH(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();

    const lead = await updateLeadFields(id, body);

    return NextResponse.json({ success: true, lead });
  } catch (error) {
    console.error('Error updating lead:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
```

**Step 2: Commit**

```bash
git add app/api/leads/[id]/route.js
git commit -m "feat: add edit lead API endpoint"
```

---

## Task 6: Approve API

**Files:**
- Create: `app/api/leads/approve/route.js`

**Step 1: Create the approve API**

```javascript
// app/api/leads/approve/route.js
import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { batchApproveleads } from '@/lib/repositories/lead.repository';

export async function POST(request) {
  try {
    const body = await request.json();
    const { leadIds, approveAll, filters } = body;

    let idsToApprove = leadIds || [];

    // If approveAll, query leads matching filters
    if (approveAll) {
      let query = supabase
        .from('leads')
        .select('id')
        .eq('approved', false);

      if (filters?.stage) {
        query = query.eq('stage', filters.stage);
      }
      if (filters?.scoreMin !== undefined) {
        query = query.gte('score', filters.scoreMin);
      }
      if (filters?.scoreMax !== undefined) {
        query = query.lte('score', filters.scoreMax);
      }

      const { data, error } = await query;
      if (error) throw error;

      idsToApprove = data?.map(l => l.id) || [];
    }

    if (idsToApprove.length === 0) {
      return NextResponse.json({
        success: true,
        approved: 0,
        message: 'No leads to approve',
      });
    }

    const approvedCount = await batchApproveleads(idsToApprove, 'manual');

    return NextResponse.json({
      success: true,
      approved: approvedCount,
      message: `${approvedCount} lead${approvedCount !== 1 ? 's' : ''} approved`,
    });
  } catch (error) {
    console.error('Error approving leads:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
```

**Step 2: Commit**

```bash
git add app/api/leads/approve/route.js
git commit -m "feat: add batch approve API endpoint"
```

---

## Task 7: Sync API

**Files:**
- Create: `app/api/leads/sync/route.js`

**Step 1: Create the sync API**

```javascript
// app/api/leads/sync/route.js
import { NextResponse } from 'next/server';
import supabase from '@/lib/supabase';
import { getLeadsNeedingSync, getLeadById } from '@/lib/repositories/lead.repository';
import { createSyncLog, updateSyncLog, hasSuccessfulSync } from '@/lib/repositories/sync-log.repository';
import { syncLeadsToExternal, processSyncResults, transformLeadForSync } from '@/lib/services/external-sync';

export async function POST(request) {
  try {
    const body = await request.json();
    const { leadIds, syncAll, syncFiltered, filters } = body;

    let leadsToSync = [];

    if (syncAll) {
      // Sync all approved unsynced leads from last 24h
      const allLeads = await getLeadsNeedingSync();

      // Filter out already synced
      for (const lead of allLeads) {
        const synced = await hasSuccessfulSync(lead.id);
        if (!synced) {
          leadsToSync.push(lead);
        }
      }
    } else if (syncFiltered && filters) {
      // Sync based on filters (ignoring approved status)
      let query = supabase
        .from('leads')
        .select(`*, contact:contacts(wa_id, company_name, name)`);

      if (filters.stage && filters.stage !== 'all') {
        query = query.eq('stage', filters.stage);
      }
      if (filters.scoreMin !== undefined) {
        query = query.gte('score', filters.scoreMin);
      }

      const { data, error } = await query;
      if (error) throw error;
      leadsToSync = data || [];
    } else if (leadIds && leadIds.length > 0) {
      // Sync specific leads
      for (const id of leadIds) {
        const lead = await getLeadById(id);
        if (lead) {
          leadsToSync.push(lead);
        }
      }
    }

    if (leadsToSync.length === 0) {
      return NextResponse.json({
        success: true,
        queued: 0,
        message: 'No leads to sync',
      });
    }

    // Create sync logs for each lead
    const syncLogs = [];
    for (const lead of leadsToSync) {
      const log = await createSyncLog({
        leadId: lead.id,
        status: 'syncing',
        requestPayload: transformLeadForSync(lead),
      });
      syncLogs.push({ lead, log });
    }

    // Call external API
    const apiKey = process.env.REVO_SCM_API_KEY;
    const apiResponse = await syncLeadsToExternal(leadsToSync, apiKey);
    const results = processSyncResults(leadsToSync, apiResponse);

    // Update sync logs with results
    let successCount = 0;
    let failedCount = 0;

    for (const result of results) {
      const syncLog = syncLogs.find(sl => sl.lead.id === result.leadId);
      if (syncLog) {
        await updateSyncLog(syncLog.log.id, {
          status: result.status,
          externalId: result.externalId,
          externalNo: result.externalNo,
          responsePayload: apiResponse,
          errorMessage: result.error,
          syncedAt: result.status === 'success' ? new Date().toISOString() : null,
        });

        if (result.status === 'success') {
          successCount++;
        } else {
          failedCount++;
        }
      }
    }

    return NextResponse.json({
      success: true,
      queued: leadsToSync.length,
      synced: successCount,
      failed: failedCount,
      message: `${successCount} synced, ${failedCount} failed`,
    });
  } catch (error) {
    console.error('Error syncing leads:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
```

**Step 2: Commit**

```bash
git add app/api/leads/sync/route.js
git commit -m "feat: add sync leads API endpoint"
```

---

## Task 8: Cron Sync API

**Files:**
- Create: `app/api/cron/sync-leads/route.js`

**Step 1: Create the cron API**

```javascript
// app/api/cron/sync-leads/route.js
import { NextResponse } from 'next/server';
import { getLeadsNeedingSync } from '@/lib/repositories/lead.repository';
import {
  createSyncLog,
  updateSyncLog,
  hasSuccessfulSync,
  getRetryableFailedLog,
  incrementRetryCount,
} from '@/lib/repositories/sync-log.repository';
import { syncLeadsToExternal, processSyncResults, transformLeadForSync } from '@/lib/services/external-sync';

export async function POST(request) {
  try {
    // Verify cron secret
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Get all approved leads from last 24h
    const allLeads = await getLeadsNeedingSync();

    // Filter to those needing sync
    const leadsToSync = [];
    const logsToUpdate = [];

    for (const lead of allLeads) {
      const hasSync = await hasSuccessfulSync(lead.id);
      if (hasSync) continue;

      // Check for retryable failed log
      const failedLog = await getRetryableFailedLog(lead.id);
      if (failedLog) {
        const updatedLog = await incrementRetryCount(failedLog.id);
        logsToUpdate.push({ lead, log: updatedLog, isRetry: true });
        leadsToSync.push(lead);
      } else if (!failedLog) {
        // Create new sync log
        const newLog = await createSyncLog({
          leadId: lead.id,
          status: 'syncing',
          requestPayload: transformLeadForSync(lead),
        });
        logsToUpdate.push({ lead, log: newLog, isRetry: false });
        leadsToSync.push(lead);
      }
    }

    if (leadsToSync.length === 0) {
      return NextResponse.json({
        success: true,
        processed: 0,
        results: { created: 0, skipped: 0, failed: 0 },
        message: 'No leads to sync',
      });
    }

    // Batch sync (max 100 per batch)
    const batchSize = 100;
    let totalCreated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;

    for (let i = 0; i < leadsToSync.length; i += batchSize) {
      const batch = leadsToSync.slice(i, i + batchSize);
      const batchLogs = logsToUpdate.slice(i, i + batchSize);

      try {
        const apiKey = process.env.REVO_SCM_API_KEY;
        const apiResponse = await syncLeadsToExternal(batch, apiKey);
        const results = processSyncResults(batch, apiResponse);

        // Update logs
        for (const result of results) {
          const logEntry = batchLogs.find(bl => bl.lead.id === result.leadId);
          if (logEntry) {
            await updateSyncLog(logEntry.log.id, {
              status: result.status,
              externalId: result.externalId,
              externalNo: result.externalNo,
              responsePayload: apiResponse,
              errorMessage: result.error,
              syncedAt: result.status === 'success' ? new Date().toISOString() : null,
            });
          }

          if (result.status === 'success') {
            // Check if it was created or skipped based on API response
            const apiResult = apiResponse.results?.find(r => r.external_id === result.leadId);
            if (apiResult?.status === 'created') {
              totalCreated++;
            } else {
              totalSkipped++;
            }
          } else {
            totalFailed++;
          }
        }
      } catch (batchError) {
        console.error('Batch sync error:', batchError);
        // Mark all in batch as failed
        for (const logEntry of batchLogs) {
          await updateSyncLog(logEntry.log.id, {
            status: 'failed',
            errorMessage: batchError.message,
          });
        }
        totalFailed += batch.length;
      }
    }

    return NextResponse.json({
      success: true,
      processed: leadsToSync.length,
      results: {
        created: totalCreated,
        skipped: totalSkipped,
        failed: totalFailed,
      },
    });
  } catch (error) {
    console.error('Cron sync error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// Also support GET for manual testing
export async function GET(request) {
  return POST(request);
}
```

**Step 2: Commit**

```bash
git add app/api/cron/sync-leads/route.js
git commit -m "feat: add cron sync API endpoint"
```

---

## Task 9: Auto-Approve on PROOF Stage

**Files:**
- Modify: `lib/repositories/lead.repository.js`

**Step 1: Update updateLeadFromClaude to auto-approve**

Find the `updateLeadFromClaude` function and modify it:

```javascript
/**
 * Update lead from Claude response
 * @param {string} leadId - Lead UUID
 * @param {Object} claudeResponse - Claude API response
 * @param {number} newScore - New total score
 * @param {string} newStage - New stage (optional)
 * @returns {Promise<Object>} - Updated lead
 */
export async function updateLeadFromClaude(leadId, claudeResponse, newScore, newStage) {
  const extracted = claudeResponse.extracted_fields || {};

  const updates = {
    score: newScore,
    route: claudeResponse.route,
  };

  // Map extracted fields
  if (extracted.destination_country) updates.destinationCountry = extracted.destination_country;
  if (extracted.destination_port) updates.destinationPort = extracted.destination_port;
  if (extracted.car_model) updates.carModel = extracted.car_model;
  if (extracted.qty_bucket) updates.qtyBucket = extracted.qty_bucket;
  if (extracted.buyer_type) updates.buyerType = extracted.buyer_type;
  if (extracted.timeline) updates.timeline = extracted.timeline;
  if (extracted.international_commercial_term) updates.incoterm = extracted.international_commercial_term;
  if (extracted.loading_port) updates.loadingPort = extracted.loading_port;
  if (extracted.brand) updates.brand = extracted.brand;
  if (claudeResponse.handoff_summary) updates.handoffSummary = claudeResponse.handoff_summary;

  // Update stage if provided
  if (newStage) {
    updates.stage = newStage;

    // Auto-approve when reaching PROOF stage
    if (newStage === 'PROOF') {
      const updateData = {
        updated_at: new Date().toISOString(),
        stage: newStage,
        approved: true,
        approved_at: new Date().toISOString(),
        approved_by: 'auto',
      };

      // Also apply other updates
      if (updates.score !== undefined) updateData.score = updates.score;
      if (updates.route !== undefined) updateData.route = updates.route;
      if (updates.destinationCountry) updateData.destination_country = updates.destinationCountry;
      if (updates.destinationPort) updateData.destination_port = updates.destinationPort;
      if (updates.carModel) updateData.car_model = updates.carModel;
      if (updates.qtyBucket) updateData.qty_bucket = updates.qtyBucket;
      if (updates.buyerType) updateData.buyer_type = updates.buyerType;
      if (updates.timeline) updateData.timeline = updates.timeline;
      if (updates.incoterm) updateData.incoterm = updates.incoterm;
      if (updates.loadingPort) updateData.loading_port = updates.loadingPort;
      if (updates.brand) updateData.brand = updates.brand;
      if (updates.handoffSummary) updateData.handoff_summary = updates.handoffSummary;

      const { data, error } = await supabase
        .from('leads')
        .update(updateData)
        .eq('id', leadId)
        .select()
        .single();

      if (error) throw error;
      console.log(`Lead ${leadId} auto-approved on reaching PROOF stage`);
      return data;
    }
  }

  return updateLead(leadId, updates);
}
```

**Step 2: Commit**

```bash
git add lib/repositories/lead.repository.js
git commit -m "feat: auto-approve leads when reaching PROOF stage"
```

---

## Task 10: EditModal Component

**Files:**
- Create: `app/dashboard/components/EditModal.js`

**Step 1: Create the EditModal component**

```javascript
// app/dashboard/components/EditModal.js
'use client';

import { useState, useEffect } from 'react';

const QTY_OPTIONS = ['1-5', '6-20', '20+'];
const BUYER_TYPE_OPTIONS = ['dealer', 'store_owner', 'trading_org'];
const INCOTERM_OPTIONS = ['FOB', 'CIF', 'EXW', 'DDP'];

export default function EditModal({ lead, isOpen, onClose, onSave }) {
  const [formData, setFormData] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (lead) {
      setFormData({
        brand: lead.brand || '',
        car_model: lead.car_model || '',
        destination_country: lead.destination_country || '',
        destination_port: lead.destination_port || '',
        qty_bucket: lead.qty_bucket || '',
        buyer_type: lead.buyer_type || '',
        timeline: lead.timeline || '',
        loading_port: lead.loading_port || '',
        incoterm: lead.incoterm || '',
        approved: lead.approved || false,
      });
    }
  }, [lead]);

  if (!isOpen) return null;

  const handleChange = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const response = await fetch(`/api/leads/${lead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || 'Failed to save');
      }

      onSave?.(result.lead);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-surface border border-border rounded-lg w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text-primary">Edit Lead</h2>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-4">
          {error && (
            <div className="p-3 bg-accent-red/10 border border-accent-red/30 rounded text-accent-red text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Brand</label>
            <input
              type="text"
              value={formData.brand}
              onChange={(e) => handleChange('brand', e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
              placeholder="e.g. Toyota"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Model</label>
            <input
              type="text"
              value={formData.car_model}
              onChange={(e) => handleChange('car_model', e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
              placeholder="e.g. Land Cruiser 300"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Country</label>
              <input
                type="text"
                value={formData.destination_country}
                onChange={(e) => handleChange('destination_country', e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Port</label>
              <input
                type="text"
                value={formData.destination_port}
                onChange={(e) => handleChange('destination_port', e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Quantity</label>
              <select
                value={formData.qty_bucket}
                onChange={(e) => handleChange('qty_bucket', e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
              >
                <option value="">Select...</option>
                {QTY_OPTIONS.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Buyer Type</label>
              <select
                value={formData.buyer_type}
                onChange={(e) => handleChange('buyer_type', e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
              >
                <option value="">Select...</option>
                {BUYER_TYPE_OPTIONS.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Timeline</label>
              <input
                type="text"
                value={formData.timeline}
                onChange={(e) => handleChange('timeline', e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
                placeholder="e.g. 1 month"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">Incoterm</label>
              <select
                value={formData.incoterm}
                onChange={(e) => handleChange('incoterm', e.target.value)}
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
              >
                <option value="">Select...</option>
                {INCOTERM_OPTIONS.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">Loading Port</label>
            <input
              type="text"
              value={formData.loading_port}
              onChange={(e) => handleChange('loading_port', e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-text-primary focus:outline-none focus:ring-1 focus:ring-accent-blue"
            />
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="approved"
              checked={formData.approved}
              onChange={(e) => handleChange('approved', e.target.checked)}
              className="w-4 h-4 rounded border-border text-accent-blue focus:ring-accent-blue"
            />
            <label htmlFor="approved" className="text-sm text-text-primary">Approved</label>
          </div>

          <div className="flex gap-3 pt-4 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 btn btn-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-1 btn btn-primary disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add app/dashboard/components/EditModal.js
git commit -m "feat: add EditModal component for lead editing"
```

---

## Task 11: Update LeadCard with Actions

**Files:**
- Modify: `app/dashboard/components/LeadCard.js`

**Step 1: Add badges and action buttons**

Replace the entire `LeadCard.js` content:

```javascript
// app/dashboard/components/LeadCard.js
'use client';

import Link from 'next/link';

function getScoreBadgeStyle(score) {
  if (score >= 75) return 'bg-accent-green/20 text-accent-green border-accent-green/30';
  if (score >= 50) return 'bg-accent-amber/20 text-accent-amber border-accent-amber/30';
  return 'bg-accent-red/20 text-accent-red border-accent-red/30';
}

function getStageBadgeStyle(stage) {
  switch (stage?.toUpperCase()) {
    case 'GREET': return 'badge-blue';
    case 'QUALIFY': return 'badge-purple';
    case 'PROOF': return 'badge-green';
    default: return 'bg-text-muted/20 text-text-muted';
  }
}

function getRelativeTime(timestamp) {
  if (!timestamp) return 'Unknown';
  const now = new Date();
  const date = new Date(timestamp);
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

export default function LeadCard({ lead, onEdit, onApprove, syncStatus }) {
  const {
    id,
    wa_id,
    lead_data = {},
    score = 0,
    stage = 'GREET',
    updated_at,
    risk_flags = [],
    approved = false,
    brand,
  } = lead;

  const {
    company_name,
    buyer_type,
    destination_country,
    destination_port,
    qty_bucket,
    car_model,
  } = lead_data;

  const destination = destination_port
    ? `${destination_country || ''}/${destination_port}`.replace(/^\//, '')
    : destination_country || '-';

  const handleApprove = async (e) => {
    e.stopPropagation();
    onApprove?.(id);
  };

  const handleEdit = (e) => {
    e.stopPropagation();
    onEdit?.(lead);
  };

  return (
    <div className="p-4 hover:bg-surface-hover transition-colors duration-150">
      <div className="flex items-start gap-4">
        {/* Score Badge */}
        <div className={`flex-shrink-0 w-14 h-14 flex flex-col items-center justify-center border rounded-lg ${getScoreBadgeStyle(score)}`}>
          <span className="text-lg font-bold">{score}</span>
          <div className="w-8 h-1.5 bg-current rounded-full opacity-30 mt-0.5">
            <div className="h-full bg-current rounded-full" style={{ width: `${Math.min(score, 100)}%` }} />
          </div>
        </div>

        {/* Lead Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-text-primary truncate">{wa_id}</span>
            <span className="text-text-muted">·</span>
            <span className="text-text-secondary truncate">{company_name || '(No company)'}</span>
          </div>

          <div className="text-sm text-text-tertiary mb-2">
            <span>{destination}</span>
            <span className="mx-1">·</span>
            <span>{qty_bucket || '-'} units</span>
            <span className="mx-1">·</span>
            <span>{brand ? `${brand} ` : ''}{car_model || '(No model)'}</span>
          </div>

          <div className="flex items-center gap-2 text-sm flex-wrap">
            <span className={`badge ${getStageBadgeStyle(stage)}`}>{stage?.toUpperCase() || 'GREET'}</span>

            {approved && (
              <span className="badge bg-accent-green/20 text-accent-green border border-accent-green/30">
                Approved
              </span>
            )}

            {syncStatus === 'success' && (
              <span className="badge bg-accent-blue/20 text-accent-blue border border-accent-blue/30">
                Synced
              </span>
            )}

            {syncStatus === 'failed' && (
              <span className="badge bg-accent-red/20 text-accent-red border border-accent-red/30">
                Sync Failed
              </span>
            )}

            <span className="text-text-muted">·</span>
            <span className="text-text-tertiary">{buyer_type || '(unknown)'}</span>
            <span className="text-text-muted">·</span>
            <span className="text-text-muted">{getRelativeTime(updated_at)}</span>

            {risk_flags && risk_flags.length > 0 && (
              <>
                <span className="text-text-muted">·</span>
                <span className="badge-red badge">risk</span>
              </>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex-shrink-0 flex items-center gap-2">
          <button
            onClick={handleEdit}
            className="btn btn-secondary text-sm px-3 py-1.5"
            title="Edit lead"
          >
            Edit
          </button>

          {!approved && (
            <button
              onClick={handleApprove}
              className="btn btn-secondary text-sm px-3 py-1.5 text-accent-green border-accent-green/30 hover:bg-accent-green/10"
              title="Approve lead"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </button>
          )}

          <Link
            href={`/dashboard/inbox?wa_id=${encodeURIComponent(wa_id)}`}
            className="btn btn-secondary text-sm px-3 py-1.5"
            onClick={(e) => e.stopPropagation()}
          >
            <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            Chat
          </Link>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add app/dashboard/components/LeadCard.js
git commit -m "feat: add Edit/Approve buttons and badges to LeadCard"
```

---

## Task 12: Update LeadsPage with Full Functionality

**Files:**
- Modify: `app/dashboard/leads/page.js`

**Step 1: Update LeadsPage with all features**

Replace the entire `page.js` content:

```javascript
// app/dashboard/leads/page.js
'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import LeadCard from '../components/LeadCard';
import FilterBar from '../components/FilterBar';
import EditModal from '../components/EditModal';

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [filteredLeads, setFilteredLeads] = useState([]);
  const [syncStatuses, setSyncStatuses] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filters, setFilters] = useState({
    stage: 'all',
    scoreRange: 'all',
    customer: '',
    model: 'all',
  });
  const [carModels, setCarModels] = useState([]);

  // Modal state
  const [editingLead, setEditingLead] = useState(null);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);

  // Action states
  const [actionLoading, setActionLoading] = useState(null);

  const supabase = createClient();

  useEffect(() => {
    fetchLeads();
    fetchSyncStatuses();
  }, []);

  useEffect(() => {
    applyFilters();
  }, [leads, filters]);

  async function fetchLeads() {
    try {
      setLoading(true);
      setError(null);

      const { data, error: fetchError } = await supabase
        .from('leads')
        .select(`
          *,
          contact:contacts(wa_id, company_name, name),
          conversation:conversations(status, last_message_at, message_count)
        `)
        .order('updated_at', { ascending: false });

      if (fetchError) throw fetchError;

      const transformedLeads = (data || []).map(lead => ({
        id: lead.id,
        wa_id: lead.contact?.wa_id,
        stage: lead.stage,
        score: lead.score,
        route: lead.route,
        updated_at: lead.updated_at,
        approved: lead.approved,
        approved_at: lead.approved_at,
        brand: lead.brand,
        car_model: lead.car_model,
        destination_country: lead.destination_country,
        destination_port: lead.destination_port,
        qty_bucket: lead.qty_bucket,
        buyer_type: lead.buyer_type,
        timeline: lead.timeline,
        incoterm: lead.incoterm,
        loading_port: lead.loading_port,
        lead_data: {
          destination_country: lead.destination_country,
          destination_port: lead.destination_port,
          qty_bucket: lead.qty_bucket,
          car_model: lead.car_model,
          company_name: lead.contact?.company_name,
          buyer_type: lead.buyer_type,
          timeline: lead.timeline,
        },
        risk_flags: [],
        conversation_status: lead.conversation?.status,
        message_count: lead.conversation?.message_count,
      }));

      setLeads(transformedLeads);

      const models = [...new Set(data?.map(l => l.car_model).filter(Boolean))];
      setCarModels(models);
    } catch (err) {
      console.error('Error fetching leads:', err);
      setError(err.message || 'Failed to fetch leads');
    } finally {
      setLoading(false);
    }
  }

  async function fetchSyncStatuses() {
    try {
      const { data } = await supabase
        .from('lead_sync_logs')
        .select('lead_id, status')
        .order('created_at', { ascending: false });

      // Get latest status for each lead
      const statusMap = {};
      for (const log of (data || [])) {
        if (!statusMap[log.lead_id]) {
          statusMap[log.lead_id] = log.status;
        }
      }
      setSyncStatuses(statusMap);
    } catch (err) {
      console.error('Error fetching sync statuses:', err);
    }
  }

  function applyFilters() {
    let result = [...leads];

    if (filters.stage !== 'all') {
      result = result.filter(
        (lead) => lead.stage?.toUpperCase() === filters.stage.toUpperCase()
      );
    }

    if (filters.scoreRange !== 'all') {
      result = result.filter((lead) => {
        const score = lead.score || 0;
        switch (filters.scoreRange) {
          case 'high': return score >= 75;
          case 'medium': return score >= 50 && score < 75;
          case 'low': return score < 50;
          default: return true;
        }
      });
    }

    if (filters.customer.trim()) {
      const search = filters.customer.toLowerCase();
      result = result.filter((lead) =>
        lead.lead_data?.company_name?.toLowerCase().includes(search)
      );
    }

    if (filters.model !== 'all') {
      result = result.filter((lead) => lead.lead_data?.car_model === filters.model);
    }

    setFilteredLeads(result);
  }

  function handleFilterChange(newFilters) {
    setFilters(prev => ({ ...prev, ...newFilters }));
  }

  async function handleApprove(leadId) {
    try {
      setActionLoading('approve');
      const response = await fetch('/api/leads/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadIds: [leadId] }),
      });
      const result = await response.json();
      if (result.success) {
        fetchLeads();
      } else {
        alert(result.error || 'Failed to approve');
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleApproveAll() {
    try {
      setActionLoading('approveAll');
      const ids = filteredLeads.filter(l => !l.approved).map(l => l.id);
      if (ids.length === 0) {
        alert('No leads to approve');
        return;
      }
      const response = await fetch('/api/leads/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadIds: ids }),
      });
      const result = await response.json();
      if (result.success) {
        alert(result.message);
        fetchLeads();
      } else {
        alert(result.error || 'Failed to approve');
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleSync24h() {
    try {
      setActionLoading('sync24h');
      const response = await fetch('/api/leads/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncAll: true }),
      });
      const result = await response.json();
      if (result.success) {
        alert(result.message);
        fetchSyncStatuses();
      } else {
        alert(result.error || 'Failed to sync');
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleSyncFiltered() {
    try {
      setActionLoading('syncFiltered');
      const ids = filteredLeads.map(l => l.id);
      if (ids.length === 0) {
        alert('No leads to sync');
        return;
      }
      const response = await fetch('/api/leads/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leadIds: ids }),
      });
      const result = await response.json();
      if (result.success) {
        alert(result.message);
        fetchSyncStatuses();
      } else {
        alert(result.error || 'Failed to sync');
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  }

  function handleEdit(lead) {
    setEditingLead(lead);
    setIsEditModalOpen(true);
  }

  function handleEditSave(updatedLead) {
    fetchLeads();
  }

  const approvedCount = filteredLeads.filter(l => l.approved).length;
  const syncedCount = filteredLeads.filter(l => syncStatuses[l.id] === 'success').length;

  if (loading) {
    return (
      <div className="p-6">
        <div className="card p-8">
          <div className="flex items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-blue"></div>
            <span className="ml-3 text-text-secondary">Loading leads...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="card border-accent-red/30 bg-accent-red/10 p-8">
          <div className="flex items-center justify-center text-accent-red">
            <svg className="w-6 h-6 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Error: {error}</span>
          </div>
          <div className="mt-4 text-center">
            <button onClick={fetchLeads} className="btn btn-primary">Try Again</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-text-primary">Leads</h1>
      </div>

      <FilterBar
        leads={leads}
        carModels={carModels}
        onFilterChange={handleFilterChange}
        initialStage={filters.stage}
        initialScoreRange={filters.scoreRange}
      />

      {/* Action Buttons */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleApproveAll}
            disabled={actionLoading === 'approveAll'}
            className="btn btn-secondary text-sm disabled:opacity-50"
          >
            {actionLoading === 'approveAll' ? 'Approving...' : 'Approve All Filtered'}
          </button>

          <button
            onClick={handleSync24h}
            disabled={actionLoading === 'sync24h'}
            className="btn btn-secondary text-sm disabled:opacity-50"
          >
            {actionLoading === 'sync24h' ? 'Syncing...' : 'Sync 24h Approved'}
          </button>

          <button
            onClick={handleSyncFiltered}
            disabled={actionLoading === 'syncFiltered'}
            className="btn btn-secondary text-sm disabled:opacity-50"
          >
            {actionLoading === 'syncFiltered' ? 'Syncing...' : 'Sync Filtered'}
          </button>

          <div className="flex-1" />

          <span className="text-sm text-text-secondary">
            <span className="font-semibold text-text-primary">{filteredLeads.length}</span> leads
            <span className="mx-1">·</span>
            <span className="text-accent-green">{approvedCount} approved</span>
            <span className="mx-1">·</span>
            <span className="text-accent-blue">{syncedCount} synced</span>
          </span>
        </div>
      </div>

      {leads.length === 0 ? (
        <div className="card p-8">
          <div className="text-center text-text-secondary">
            <svg className="w-12 h-12 mx-auto mb-4 text-text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <p className="text-lg font-medium text-text-primary">No leads yet</p>
            <p className="mt-1">Leads will appear here when customers start conversations.</p>
          </div>
        </div>
      ) : (
        <div className="card divide-y divide-border">
          {filteredLeads.length > 0 ? (
            filteredLeads.map((lead) => (
              <LeadCard
                key={lead.id}
                lead={lead}
                onEdit={handleEdit}
                onApprove={handleApprove}
                syncStatus={syncStatuses[lead.id]}
              />
            ))
          ) : (
            <div className="p-8 text-center text-text-secondary">
              <p>No leads match the current filters.</p>
              <button
                onClick={() => setFilters({ stage: 'all', scoreRange: 'all', customer: '', model: 'all' })}
                className="mt-2 text-accent-blue hover:text-accent-blue/80 underline"
              >
                Clear filters
              </button>
            </div>
          )}
        </div>
      )}

      <EditModal
        lead={editingLead}
        isOpen={isEditModalOpen}
        onClose={() => {
          setIsEditModalOpen(false);
          setEditingLead(null);
        }}
        onSave={handleEditSave}
      />
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add app/dashboard/leads/page.js
git commit -m "feat: add approve/sync/edit functionality to LeadsPage"
```

---

## Task 13: Add Environment Variables

**Files:**
- Modify: `.env.local` (manual step - do not commit this file)

**Step 1: Add required env vars**

Add to `.env.local`:

```
REVO_SCM_API_KEY=kEXMhOTYbNGDkVo2+8k0bEnL1bNcn3IwVplN8yLQGVM=
CRON_SECRET=your-generated-secret-here
```

Generate CRON_SECRET with:
```bash
openssl rand -hex 32
```

**Step 2: Verify .gitignore**

Ensure `.env.local` is in `.gitignore` (should already be there).

---

## Task 14: Create Vercel Cron Config (Optional)

**Files:**
- Create: `vercel.json`

**Step 1: Create vercel.json**

```json
{
  "crons": [
    {
      "path": "/api/cron/sync-leads",
      "schedule": "* * * * *"
    }
  ]
}
```

Note: Vercel Cron minimum is 1 minute. For 30-second intervals, consider using an external cron service.

**Step 2: Commit**

```bash
git add vercel.json
git commit -m "chore: add Vercel cron configuration"
```

---

## Task 15: Final Integration Test

**Step 1: Start dev server**

```bash
npm run dev
```

**Step 2: Test database migration**

Run migration SQL in Supabase SQL Editor.

**Step 3: Test API endpoints**

```bash
# Test edit API
curl -X PATCH http://localhost:3002/api/leads/[lead-id] \
  -H "Content-Type: application/json" \
  -d '{"brand": "Toyota"}'

# Test approve API
curl -X POST http://localhost:3002/api/leads/approve \
  -H "Content-Type: application/json" \
  -d '{"leadIds": ["[lead-id]"]}'

# Test sync API
curl -X POST http://localhost:3002/api/leads/sync \
  -H "Content-Type: application/json" \
  -d '{"leadIds": ["[lead-id]"]}'

# Test cron API
curl -X POST http://localhost:3002/api/cron/sync-leads
```

**Step 4: Test UI**

1. Navigate to `/dashboard/leads`
2. Click "Edit" on a lead - verify modal opens and saves
3. Click approve button - verify lead gets approved badge
4. Click "Sync Filtered" - verify sync runs
5. Verify "Synced" badge appears after successful sync

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete batch inquiry sync feature implementation"
```

---

## Summary of Files

### New Files (9)
1. `supabase/migrations/003_batch_sync_schema.sql`
2. `lib/repositories/sync-log.repository.js`
3. `lib/services/external-sync.js`
4. `app/api/leads/[id]/route.js`
5. `app/api/leads/approve/route.js`
6. `app/api/leads/sync/route.js`
7. `app/api/cron/sync-leads/route.js`
8. `app/dashboard/components/EditModal.js`
9. `vercel.json`

### Modified Files (4)
1. `lib/repositories/lead.repository.js`
2. `lib/repositories/index.js`
3. `app/dashboard/leads/page.js`
4. `app/dashboard/components/LeadCard.js`

### Manual Steps
1. Run database migration in Supabase SQL Editor
2. Add env vars to `.env.local`
