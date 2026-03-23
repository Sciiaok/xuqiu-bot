ALTER TABLE orchestrator_sessions
  ADD COLUMN IF NOT EXISTS orchestrator_state jsonb DEFAULT NULL;
