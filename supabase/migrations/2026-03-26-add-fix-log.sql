-- Add fix_log column to track auto-fix attempts during orchestration
ALTER TABLE orchestrator_sessions
  ADD COLUMN IF NOT EXISTS fix_log jsonb NOT NULL DEFAULT '[]';
