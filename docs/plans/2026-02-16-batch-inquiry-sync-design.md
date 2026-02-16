# Batch Inquiry Sync Feature Design

## Overview

This document describes the design for adding lead approval and external system sync features to the Lead Engine.

### Features

1. **Lead Approve**: Add `approved` field to leads, auto-approve when reaching PROOF stage, support manual approve
2. **Batch Sync**: Sync approved leads to external SCM system (revoscm.cn)
3. **Cron Task**: Every 30 seconds, check and sync unsynced approved leads from last 24 hours
4. **Sync Logs**: Track sync status with 30-day retention
5. **UI Enhancements**: Edit modal, Approve/Sync buttons

---

## Part 1: Database Changes

### 1.1 leads table - new fields

```sql
ALTER TABLE leads ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS brand TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS approved_by TEXT;  -- 'auto' or 'manual'

CREATE INDEX IF NOT EXISTS idx_leads_approved ON leads(approved) WHERE approved = TRUE;
```

### 1.2 New lead_sync_logs table

```sql
CREATE TABLE IF NOT EXISTS lead_sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  external_id TEXT,                -- External system's inquiry_id
  external_no TEXT,                -- External system's inquiry_no
  status TEXT NOT NULL CHECK (status IN ('pending', 'syncing', 'success', 'failed')),
  request_payload JSONB,           -- Request body sent
  response_payload JSONB,          -- External system's response
  error_message TEXT,              -- Error message on failure
  retry_count INT DEFAULT 0,       -- Retry count
  synced_at TIMESTAMPTZ,           -- Successful sync timestamp
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_lead_id ON lead_sync_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_status ON lead_sync_logs(status);
CREATE INDEX IF NOT EXISTS idx_sync_logs_created_at ON lead_sync_logs(created_at);
```

### 1.3 Field Mapping

| Lead Field | External API Field | Notes |
|------------|-------------------|-------|
| `id` | `external_id` | UUID directly |
| `contact.company_name` | `customer.name` | Customer name |
| `destination_country` | `customer.country` | Country |
| `brand` (new) | `inquiry.brand` | Brand |
| `car_model` | `inquiry.model` | Model |
| `qty_bucket` | `inquiry.quantity` | Convert: '1-5'->3, '6-20'->10, '20+'->25 |
| `loading_port` | `inquiry.port_of_loading` | Loading port |
| `destination_port` | `inquiry.port_of_discharge` | Discharge port |
| `extra_data.notes` | `inquiry.notes` | Optional notes |

Other API fields (year, colors, configuration, expected_delivery_date, budget_min, budget_max) will be omitted.

---

## Part 2: API Design

### 2.1 Approve API

**POST `/api/leads/approve`**

```javascript
// Request
{
  "leadIds": ["uuid1", "uuid2"],  // Lead IDs to approve
  "approveAll": false,            // If true, ignore leadIds, approve all matching filters
  "filters": {                    // Used when approveAll=true
    "stage": "PROOF",
    "scoreMin": 75
  }
}

// Response
{
  "success": true,
  "approved": 5,
  "message": "5 leads approved"
}
```

### 2.2 Sync API

**POST `/api/leads/sync`**

```javascript
// Request
{
  "leadIds": ["uuid1", "uuid2"],  // Manually sync specific leads
  "syncAll": false,               // If true, sync all approved unsynced leads from 24h
  "syncFiltered": false           // If true, sync current filtered results (ignore approved)
}

// Response
{
  "success": true,
  "queued": 10,
  "message": "10 leads queued for sync"
}
```

### 2.3 Cron Sync API

**POST `/api/cron/sync-leads`**

- Called by Vercel Cron or external cron service every 30 seconds
- Requires `CRON_SECRET` header validation
- Finds approved leads from last 24h without successful sync
- Batch calls external API (max 100 per batch)
- Records sync logs

```javascript
// Response
{
  "success": true,
  "processed": 15,
  "results": {
    "created": 10,
    "skipped": 3,
    "failed": 2
  }
}
```

### 2.4 Edit Lead API

**PATCH `/api/leads/[id]`**

```javascript
// Request - supports updating all lead fields
{
  "brand": "Toyota",
  "car_model": "Land Cruiser 300",
  "destination_country": "UAE",
  "destination_port": "Jebel Ali",
  "qty_bucket": "6-20",
  "buyer_type": "dealer",
  "timeline": "1 month",
  "approved": true
}

// Response
{
  "success": true,
  "lead": { ... }
}
```

---

## Part 3: UI Design

### 3.1 LeadsPage Changes

Add action bar below FilterBar:

```
+-------------------------------------------------------------+
| Filters: [All Stages v] [All Scores v] [Customer...] ...    |
|                                                             |
| [Approve All]  [Sync 24h Approved]  [Sync Filtered]         |
|                                                             |
| 25 leads (15 approved, 10 synced)                           |
+-------------------------------------------------------------+
```

### 3.2 LeadCard Changes

Each LeadCard adds:
- **Approved badge**: Green "Approved" mark next to stage badge
- **Synced badge**: "Synced" mark if synced
- **Action buttons**: Edit, Approve (if not approved)

```
+-------------------------------------------------------------+
|  +----+                                                     |
|  | 85 |  wa_id - Company Name                    [Edit] [v] |
|  +----+  UAE/Jebel Ali - 6-20 units - Land Cruiser          |
|          [PROOF] [Approved] [Synced] - dealer - 2h ago      |
+-------------------------------------------------------------+
```

### 3.3 EditModal Component

Modal form with all editable lead fields:
- Brand (dropdown or text)
- Model (text)
- Country (text)
- Port (text)
- Quantity (dropdown: 1-5, 6-20, 20+)
- Buyer Type (dropdown: dealer, store_owner, trading_org)
- Timeline (text)
- Loading Port (text)
- Approved (checkbox)

### 3.4 Auto-Approve Logic

In state machine or lead repository:
- When lead stage changes to PROOF, automatically set:
  - `approved = true`
  - `approved_at = NOW()`
  - `approved_by = 'auto'`

---

## Part 4: Sync Logic & Error Handling

### 4.1 Sync Flow

```
                    +----------------------------------+
                    |   Lead approved = true           |
                    |   (manual or auto at PROOF)      |
                    +----------------+-----------------+
                                     |
                    +----------------v-----------------+
                    |   Cron task (every 30s)          |
                    |   Query: approved=true           |
                    |          AND last 24h            |
                    |          AND no success sync     |
                    +----------------+-----------------+
                                     |
                    +----------------v-----------------+
                    |   Create sync_log (syncing)      |
                    +----------------+-----------------+
                                     |
                    +----------------v-----------------+
                    |   Call external API (batch)      |
                    |   Max 100 items per batch        |
                    +----------------+-----------------+
                                     |
              +----------------------+----------------------+
              |                      |                      |
     +--------v--------+    +--------v--------+    +--------v--------+
     |   Success       |    |   Skipped       |    |   Failed        |
     |   created       |    |   (exists)      |    |   retry_count++ |
     |   Update log    |    |   Update log    |    |   <=3: retry    |
     |   status=success|    |   status=success|    |   >3: failed    |
     +-----------------+    +-----------------+    +-----------------+
```

### 4.2 Retry Strategy

- **Max retries**: 3
- **Retry interval**: Determined by cron cycle (~30 seconds)
- **After failure**:
  - `retry_count <= 3`: Will retry on next cron run
  - `retry_count > 3`: Marked as `status=failed`, no auto-retry
  - Admin can manually trigger re-sync in UI

### 4.3 Query Unsynced Leads SQL

```sql
SELECT l.*
FROM leads l
WHERE l.approved = TRUE
  AND l.approved_at >= NOW() - INTERVAL '24 hours'
  AND NOT EXISTS (
    SELECT 1 FROM lead_sync_logs s
    WHERE s.lead_id = l.id
    AND s.status = 'success'
  )
  AND NOT EXISTS (
    SELECT 1 FROM lead_sync_logs s
    WHERE s.lead_id = l.id
    AND s.status = 'failed'
    AND s.retry_count > 3
  );
```

### 4.4 External API Call

```javascript
// lib/services/external-sync.js

const REVO_SCM_API = 'https://www.revoscm.cn/api/external/inquiries/batch';
const API_KEY = process.env.REVO_SCM_API_KEY;

async function syncLeadsToExternal(leads) {
  const items = leads.map(lead => ({
    external_id: lead.id,
    customer: {
      name: lead.contact?.company_name || 'Unknown',
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
  }));

  const response = await fetch(REVO_SCM_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: JSON.stringify({ mode: 'skip', items }),
  });

  return response.json();
}

function convertQtyBucket(bucket) {
  switch (bucket) {
    case '1-5': return 3;
    case '6-20': return 10;
    case '20+': return 25;
    default: return 1;
  }
}
```

---

## File Structure (New/Modified Files)

### New Files
- `supabase/migrations/003_batch_sync_schema.sql` - Database migration
- `app/api/leads/approve/route.js` - Approve API
- `app/api/leads/sync/route.js` - Sync API
- `app/api/leads/[id]/route.js` - Edit Lead API
- `app/api/cron/sync-leads/route.js` - Cron sync API
- `app/dashboard/components/EditModal.js` - Edit modal component
- `lib/services/external-sync.js` - External API sync service
- `lib/repositories/sync-log.repository.js` - Sync log repository

### Modified Files
- `lib/repositories/lead.repository.js` - Add brand field, auto-approve logic
- `app/dashboard/leads/page.js` - Add action buttons, approve/sync state
- `app/dashboard/components/LeadCard.js` - Add badges, action buttons
- `app/dashboard/components/FilterBar.js` - Add action buttons
- `src/state-machine.js` - Auto-approve on PROOF stage

---

## Environment Variables

Add to `.env.local`:

```
REVO_SCM_API_KEY=kEXMhOTYbNGDkVo2+8k0bEnL1bNcn3IwVplN8yLQGVM=
CRON_SECRET=<generate-a-secret>
```

---

## Vercel Cron Configuration

Add to `vercel.json`:

```json
{
  "crons": [
    {
      "path": "/api/cron/sync-leads",
      "schedule": "*/1 * * * *"
    }
  ]
}
```

Note: Vercel Cron minimum interval is 1 minute. For 30-second intervals, use an external cron service or implement two staggered cron jobs.
