ALTER TABLE conversations
ADD COLUMN IF NOT EXISTS meta_ad_id TEXT;

ALTER TABLE leads
ADD COLUMN IF NOT EXISTS meta_ad_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_meta_ad_id
  ON conversations (meta_ad_id)
  WHERE meta_ad_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_meta_ad_id
  ON leads (meta_ad_id)
  WHERE meta_ad_id IS NOT NULL;
