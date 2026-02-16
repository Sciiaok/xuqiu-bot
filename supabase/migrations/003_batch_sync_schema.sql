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
