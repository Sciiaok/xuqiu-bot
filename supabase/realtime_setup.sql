-- =====================================================
-- Supabase Realtime Setup for `sessions` table
-- Run these commands in Supabase SQL Editor
-- =====================================================

-- =====================================================
-- 1. CHECK CURRENT STATUS
-- =====================================================

-- Check if table exists
SELECT table_name, table_schema
FROM information_schema.tables
WHERE table_name = 'sessions';

-- Check current REPLICA IDENTITY setting
-- 'd' = default, 'f' = full (we need 'f')
SELECT relname, relreplident
FROM pg_class
WHERE relname = 'sessions' AND relkind = 'r';

-- Check if RLS is enabled
-- 't' = enabled, 'f' = disabled
SELECT relname, relrowsecurity
FROM pg_class
WHERE relname = 'sessions' AND relkind = 'r';

-- Check existing RLS policies
SELECT * FROM pg_policies WHERE tablename = 'sessions';

-- Check if table is in realtime publication
SELECT * FROM pg_publication_tables
WHERE pubname = 'supabase_realtime';

-- =====================================================
-- 2. ENABLE REALTIME (Run these ALTER statements)
-- =====================================================

-- Set REPLICA IDENTITY to FULL (required for realtime to send row data)
ALTER TABLE public.sessions REPLICA IDENTITY FULL;

-- Disable Row Level Security (simplest approach)
-- If you need RLS, add a policy instead (see section 3)
ALTER TABLE public.sessions DISABLE ROW LEVEL SECURITY;

-- Add table to realtime publication
-- First check if publication exists, if not create it
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- Add sessions table to the publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions;

-- =====================================================
-- 3. ALTERNATIVE: Keep RLS enabled with read policy
-- (Use this instead of DISABLE ROW LEVEL SECURITY)
-- =====================================================

-- Enable RLS
-- ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;

-- Allow all authenticated users to read
-- CREATE POLICY "Allow authenticated read"
--   ON public.sessions
--   FOR SELECT
--   TO authenticated
--   USING (true);

-- Allow all authenticated users to insert/update
-- CREATE POLICY "Allow authenticated write"
--   ON public.sessions
--   FOR ALL
--   TO authenticated
--   USING (true)
--   WITH CHECK (true);

-- =====================================================
-- 4. VERIFY SETUP
-- =====================================================

-- Verify REPLICA IDENTITY is 'f' (full)
SELECT relname,
       CASE relreplident
         WHEN 'd' THEN 'default'
         WHEN 'f' THEN 'full (OK)'
         WHEN 'n' THEN 'nothing'
         WHEN 'i' THEN 'index'
       END as replica_identity
FROM pg_class
WHERE relname = 'sessions' AND relkind = 'r';

-- Verify RLS is disabled (or has appropriate policies)
SELECT relname,
       CASE relrowsecurity
         WHEN true THEN 'enabled'
         WHEN false THEN 'disabled (OK)'
       END as rls_status
FROM pg_class
WHERE relname = 'sessions' AND relkind = 'r';

-- Verify table is in publication
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime' AND tablename = 'sessions';

-- =====================================================
-- 5. TEST REALTIME (Optional)
-- =====================================================

-- Trigger an update to test realtime
-- UPDATE public.sessions
-- SET updated_at = NOW()
-- WHERE wa_id = 'your_test_wa_id';

-- =====================================================
-- QUICK SETUP (Run all at once)
-- =====================================================

-- Uncomment and run this block for quick setup:
/*
ALTER TABLE public.sessions REPLICA IDENTITY FULL;
ALTER TABLE public.sessions DISABLE ROW LEVEL SECURITY;
ALTER PUBLICATION supabase_realtime ADD TABLE public.sessions;
*/
