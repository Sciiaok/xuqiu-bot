-- =====================================================
-- Migration Verification Queries
-- Run these after migrate:v2 script completes
-- =====================================================

-- 1. Backup existing data (run BEFORE migration)
-- CREATE TABLE sessions_backup AS SELECT * FROM sessions;

-- 2. Check counts match after migration
SELECT
  (SELECT COUNT(*) FROM sessions) as sessions_count,
  (SELECT COUNT(*) FROM contacts) as contacts_count,
  (SELECT COUNT(*) FROM conversations) as conversations_count,
  (SELECT COUNT(*) FROM leads) as leads_count;

-- 3. Verify sample records
SELECT
  c.wa_id,
  c.company_name,
  conv.status as conversation_status,
  l.stage,
  l.score,
  l.destination_country,
  l.car_model,
  (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = conv.id) as msg_count
FROM contacts c
JOIN conversations conv ON conv.contact_id = c.id
JOIN leads l ON l.conversation_id = conv.id
LIMIT 10;

-- 4. Check realtime is enabled
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
AND tablename IN ('contacts', 'conversations', 'messages', 'leads');

-- 5. After verification, optionally drop old sessions table
-- WARNING: Only run after confirming migration is successful!
-- DROP TABLE sessions;
-- DROP TABLE sessions_backup; -- if you created a backup
