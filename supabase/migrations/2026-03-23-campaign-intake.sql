CREATE TABLE campaign_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'collecting', 'completed', 'expired')),
  brief jsonb NOT NULL DEFAULT '{}',
  completion jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_campaign_briefs_status ON campaign_briefs(status)
  WHERE status IN ('draft', 'collecting');

ALTER TABLE campaign_briefs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "campaign_briefs_auth_all" ON campaign_briefs
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION update_campaign_briefs_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_campaign_briefs_updated_at
  BEFORE UPDATE ON campaign_briefs
  FOR EACH ROW EXECUTE FUNCTION update_campaign_briefs_updated_at();
