ALTER TABLE orchestrator_messages DROP CONSTRAINT orchestrator_messages_role_check;
ALTER TABLE orchestrator_messages ADD CONSTRAINT orchestrator_messages_role_check
  CHECK (role IN ('user', 'assistant', 'tool', 'event'));
