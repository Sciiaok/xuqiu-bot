-- Orchestrator sessions — one per orchestration run, linked to a brief
CREATE TABLE orchestrator_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brief_id uuid NOT NULL REFERENCES campaign_briefs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'running', 'awaiting_approval', 'completed', 'failed')),
  current_phase text,
  phase_results jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_orchestrator_sessions_brief ON orchestrator_sessions(brief_id);
CREATE INDEX idx_orchestrator_sessions_status ON orchestrator_sessions(status)
  WHERE status IN ('running', 'awaiting_approval');

-- Orchestrator messages — user chat + agent execution traces in one table
CREATE TABLE orchestrator_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES orchestrator_sessions(id) ON DELETE CASCADE,
  phase text,  -- null = user conversation, 'research'/'strategy'/'creative'/'execution' = agent trace
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content text,
  tool_name text,
  tool_use_id text,
  tool_input jsonb,
  tool_result jsonb,
  message_index integer NOT NULL,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_orchestrator_messages_session ON orchestrator_messages(session_id);
CREATE INDEX idx_orchestrator_messages_order ON orchestrator_messages(session_id, message_index);
CREATE INDEX idx_orchestrator_messages_phase ON orchestrator_messages(session_id, phase)
  WHERE phase IS NOT NULL;

-- RLS
ALTER TABLE orchestrator_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "orchestrator_sessions_auth_all" ON orchestrator_sessions
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

ALTER TABLE orchestrator_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "orchestrator_messages_auth_all" ON orchestrator_messages
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

-- Auto-update updated_at
CREATE TRIGGER trg_orchestrator_sessions_updated_at
  BEFORE UPDATE ON orchestrator_sessions
  FOR EACH ROW EXECUTE FUNCTION update_campaign_briefs_updated_at();
