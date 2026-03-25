ALTER TABLE aigc_assets ADD COLUMN IF NOT EXISTS conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE aigc_assets ADD COLUMN IF NOT EXISTS user_id uuid;

CREATE INDEX IF NOT EXISTS idx_aigc_assets_conversation ON aigc_assets(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aigc_assets_user ON aigc_assets(user_id) WHERE user_id IS NOT NULL;
