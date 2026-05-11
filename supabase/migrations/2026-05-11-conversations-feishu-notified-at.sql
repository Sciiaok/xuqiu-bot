-- Track the moment we sent a Feishu handoff notification for a conversation,
-- so Medici can't spam the channel by re-emitting HUMAN_NOW on every inbound
-- message inside the same takeover cycle. Cleared whenever takeover ends, so
-- the next HUMAN_NOW re-arms a single fresh notification.

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS feishu_notified_at TIMESTAMPTZ;
