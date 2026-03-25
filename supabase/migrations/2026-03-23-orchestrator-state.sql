ALTER TABLE orchestrator_sessions
  ADD COLUMN IF NOT EXISTS orchestrator_state jsonb DEFAULT NULL;

-- Add 'awaiting_feedback' to the status check constraint
ALTER TABLE orchestrator_sessions
  DROP CONSTRAINT IF EXISTS orchestrator_sessions_status_check;
ALTER TABLE orchestrator_sessions
  ADD CONSTRAINT orchestrator_sessions_status_check
  CHECK (status IN ('draft', 'running', 'awaiting_approval', 'awaiting_feedback', 'completed', 'failed'));
