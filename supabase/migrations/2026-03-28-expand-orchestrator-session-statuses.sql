-- Align orchestrator_sessions.status constraint with the unified intake/orchestrator state machine
ALTER TABLE orchestrator_sessions
  DROP CONSTRAINT IF EXISTS orchestrator_sessions_status_check;

ALTER TABLE orchestrator_sessions
  ADD CONSTRAINT orchestrator_sessions_status_check
  CHECK (
    status IN (
      'draft',
      'intake',
      'brief_completed',
      'running',
      'awaiting_approval',
      'awaiting_feedback',
      'interrupted',
      'completed',
      'failed'
    )
  );
