-- Add 'interrupted' to orchestrator_sessions status for zombie recovery
ALTER TABLE orchestrator_sessions
  DROP CONSTRAINT IF EXISTS orchestrator_sessions_status_check;

ALTER TABLE orchestrator_sessions
  ADD CONSTRAINT orchestrator_sessions_status_check
  CHECK (status IN ('draft', 'running', 'awaiting_approval', 'awaiting_feedback', 'interrupted', 'completed', 'failed'));
