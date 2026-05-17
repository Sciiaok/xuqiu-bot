-- ============================================================================
-- Deprecate the lead-sync / lead-approval feature
--
-- Background: the `cron sync-leads` PM2 worker pushed approved leads to an
-- external SCM endpoint (REVO, http://47.111.1.165). Forensic audit on
-- 2026-05-17 showed:
--   * Only 9 leads were ever approved in the entire production history
--     (last on 2026-03-15; nothing since)
--   * No UI ever surfaced an "approve" action — approval only happened via
--     direct curl during early integration testing
--   * The external endpoint has been unreachable for ~2 months
--     ("Empty reply from server" after 5s)
--   * lead_sync_logs accumulated 4609 failed rows vs. 4 success rows
--     (success rate 0.087%); only 1 of those successes returned real
--     external IDs from REVO
-- Conclusion: the feature was never adopted and is now dead. The cron, the
-- API routes (/api/cron/sync-leads, /api/leads/sync, /api/leads/approve),
-- the service, the repository, and the PM2 entry are removed in the same
-- changeset.
--
-- Per CLAUDE.md "Forward compatibility":
--   > preserve existing data: never delete or rewrite old rows
-- This migration deliberately does NOT drop the table or columns. It only
-- annotates them so:
--   1. supabase dashboard / pg_dump readers immediately see deprecation status
--   2. future contributors don't accidentally start using them
--   3. the 4613 lead_sync_logs rows and the leads.approved* trio remain
--      available for forensic queries via /dev-tools/sql
--
-- Snapshot at deprecation time (2026-05-17):
--   lead_sync_logs           4 613 rows (4 success / 4609 failed)
--   leads with approved=true     9 rows (all from 2026-02-20…2026-03-15)
-- ============================================================================

COMMENT ON TABLE lead_sync_logs IS
  'DEPRECATED 2026-05-17: external SCM (REVO) push tracking. Endpoint dead ~2026-03; only ever reached 4 success / 4609 failed across 9 approved leads. Feature removed (cron sync-leads, /api/cron/sync-leads, /api/leads/sync, /api/leads/approve, src/external-sync.service.js, sync-log.repository.js all deleted). 4613 rows preserved for forensic inspection.';

COMMENT ON COLUMN leads.approved IS
  'DEPRECATED 2026-05-17: shelved with the lead_sync_logs removal. No UI ever wrote this; only 9 rows true in entire history. Column kept for historical data preservation.';
COMMENT ON COLUMN leads.approved_at IS
  'DEPRECATED 2026-05-17: see leads.approved comment.';
COMMENT ON COLUMN leads.approved_by IS
  'DEPRECATED 2026-05-17: see leads.approved comment.';
