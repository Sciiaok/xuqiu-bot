ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS wa_phone_number_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_wa_phone_number_id
  ON conversations (wa_phone_number_id)
  WHERE wa_phone_number_id IS NOT NULL;
