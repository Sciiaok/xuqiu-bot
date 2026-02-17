-- supabase/migrations/006_multi_lead_support.sql
-- Multi-Lead Support: One conversation can have multiple leads

-- =====================================================
-- 1. Add new columns to leads table
-- =====================================================

-- lead_key: Unique identifier for lead within conversation (e.g., "model:byd seal|dest:uae")
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_key TEXT;

-- color_quantity: Array of color-quantity pairs [{color: "white", qty: 6}, ...]
ALTER TABLE leads ADD COLUMN IF NOT EXISTS color_quantity JSONB DEFAULT '[]';

-- =====================================================
-- 2. Add lead_id to messages table
-- =====================================================

-- Messages can be associated with a specific lead
ALTER TABLE messages ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id);

CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id);

-- =====================================================
-- 3. Create unique index for lead_key within conversation
-- =====================================================

-- Only one active lead (route='CONTINUE') per (conversation_id, lead_key) combination
-- When lead ends (route != 'CONTINUE'), user can start new inquiry for same car+destination
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_lead_key
ON leads (conversation_id, lead_key)
WHERE route = 'CONTINUE' AND lead_key IS NOT NULL;

-- =====================================================
-- 4. Migrate existing data
-- =====================================================

-- Set default lead_key for existing leads
UPDATE leads
SET lead_key = 'default'
WHERE lead_key IS NULL;

-- =====================================================
-- 5. Verification queries
-- =====================================================

-- Check new columns exist:
-- SELECT column_name, data_type, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'leads'
-- AND column_name IN ('lead_key', 'color_quantity');

-- Check messages.lead_id exists:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'messages' AND column_name = 'lead_id';

-- Check unique index exists:
-- SELECT indexname FROM pg_indexes
-- WHERE tablename = 'leads' AND indexname = 'idx_unique_lead_key';
