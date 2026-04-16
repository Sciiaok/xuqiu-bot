-- ═══════════════════════════════════════════════════════════════════════
-- Autopilot (自动获客) — WhatsApp Click-to-Chat campaign builder
--
-- 1 conversation = 1 ad plan (ChatGPT-style). A single-agent loop drafts a
-- Click-to-WhatsApp Meta Ads plan from a chat conversation, and later stages
-- + activates the campaigns via Meta Graph API.
--
-- Coexists with the old orchestrator_sessions/campaign_briefs tables — those
-- are frozen (no new writes) but retained as archive. This is a clean split.
-- ═══════════════════════════════════════════════════════════════════════

-- ── Sessions ────────────────────────────────────────────────────────────
-- One row per conversation. Holds the latest drafted plan and launch state.
CREATE TABLE autopilot_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title         text,                          -- derived from first user msg
  status        text NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'staging', 'launched', 'failed', 'archived')),
  plan_json     jsonb,                         -- latest ad plan (null until drafted)
  meta_campaign_ids text[] DEFAULT '{}',       -- populated after stage_campaigns
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX idx_autopilot_sessions_user     ON autopilot_sessions(user_id, created_at DESC);
CREATE INDEX idx_autopilot_sessions_status   ON autopilot_sessions(status) WHERE status != 'archived';

-- ── Messages ────────────────────────────────────────────────────────────
-- Mirrors OpenAI message shape: user / assistant / tool. Tool rows carry the
-- tool_call_id so we can replay the Claude conversation exactly.
CREATE TABLE autopilot_messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES autopilot_sessions(id) ON DELETE CASCADE,
  message_index  integer NOT NULL,
  role           text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content        text,
  tool_name      text,
  tool_use_id    text,
  tool_input     jsonb,
  tool_result    jsonb,
  attachments    jsonb,
  created_at     timestamptz DEFAULT now()
);

CREATE INDEX idx_autopilot_messages_order ON autopilot_messages(session_id, message_index);

-- ── RLS ─────────────────────────────────────────────────────────────────
-- Matches the pattern used by orchestrator_sessions/messages. Single-tenant
-- for now; when we go multi-tenant, switch to user_id-scoped policies.
ALTER TABLE autopilot_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "autopilot_sessions_auth_all" ON autopilot_sessions
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

ALTER TABLE autopilot_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "autopilot_messages_auth_all" ON autopilot_messages
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

-- ── Auto updated_at ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_autopilot_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_autopilot_sessions_updated_at
  BEFORE UPDATE ON autopilot_sessions
  FOR EACH ROW EXECUTE FUNCTION update_autopilot_sessions_updated_at();
