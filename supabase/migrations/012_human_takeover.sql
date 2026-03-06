-- Human takeover support for conversations
ALTER TABLE conversations
  ADD COLUMN is_human_takeover BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN human_takeover_at TIMESTAMPTZ;

-- CHECK: if takeover is active, timestamp must be set
ALTER TABLE conversations
  ADD CONSTRAINT check_takeover_timestamp
  CHECK (is_human_takeover = false OR human_takeover_at IS NOT NULL);

-- Index for cron timeout scan: find takeover conversations older than 1h
CREATE INDEX idx_conversations_human_takeover
  ON conversations (human_takeover_at)
  WHERE is_human_takeover = true;
