-- ═══════════════════════════════════════════════════════════════════════
-- Autopilot — soft-delete for sessions
--
-- Replaces the hard-delete behaviour of DELETE /api/ogilvy/conversations/[id]
-- with a soft-delete (deleted_at timestamp). The old code path executed
-- DELETE FROM autopilot_sessions which cascaded into autopilot_messages —
-- meaning a single buggy or malicious call could wipe a user's whole chat
-- history with no recovery. (See incident on 2026-05-11 where an automation
-- script bulk-deleted all sessions for one user during dev-tool testing;
-- cascade also dropped every message in the table.)
--
-- After this migration:
--   • DELETE writes deleted_at = now() instead of removing the row.
--   • All reads in lib/repositories/ogilvy.repository.js filter
--     deleted_at IS NULL, so soft-deleted sessions disappear from the API
--     while the underlying data — including messages, plan_json, and
--     meta_campaign_ids — is preserved indefinitely.
--   • No data loss from cascade either way: messages are kept because their
--     parent session row still exists (just flagged).
--
-- Restoring a soft-deleted session is a single UPDATE setting deleted_at
-- back to NULL — no application change needed beyond an admin tool.
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE autopilot_sessions
  ADD COLUMN deleted_at timestamptz;

-- Partial index for the hot "list active sessions for this user" query in
-- lib/repositories/ogilvy.repository.js#listSessions. Tiny table today, but
-- keeps the planner honest as it grows and makes the filter intent explicit.
CREATE INDEX idx_autopilot_sessions_active
  ON autopilot_sessions (tenant_id, user_id, updated_at DESC)
  WHERE deleted_at IS NULL;
