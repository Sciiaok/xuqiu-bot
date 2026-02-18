-- supabase/migrations/007_remove_message_lead_id.sql
-- Remove redundant lead_id from messages table
-- Lead association is handled via conversation_id

-- Drop the index first
DROP INDEX IF EXISTS idx_messages_lead_id;

-- Remove the column
ALTER TABLE messages DROP COLUMN IF EXISTS lead_id;

-- Verification query:
-- SELECT column_name FROM information_schema.columns
-- WHERE table_name = 'messages' AND column_name = 'lead_id';
-- Should return 0 rows
