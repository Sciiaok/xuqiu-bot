-- AIGC generated assets table
CREATE TABLE IF NOT EXISTS aigc_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  user_id uuid,
  prompt text NOT NULL,
  model text NOT NULL,
  source_filename text,
  product_info jsonb,
  storage_path text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE aigc_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "aigc_assets_auth_all" ON aigc_assets
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

CREATE INDEX idx_aigc_assets_created ON aigc_assets(created_at DESC);
CREATE INDEX idx_aigc_assets_conversation ON aigc_assets(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX idx_aigc_assets_user ON aigc_assets(user_id) WHERE user_id IS NOT NULL;

-- Storage bucket for generated assets
INSERT INTO storage.buckets (id, name, public)
VALUES ('aigc-assets', 'aigc-assets', true)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated users to upload/read/delete
CREATE POLICY "Authenticated users can upload aigc assets"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'aigc-assets');

CREATE POLICY "Anyone can read aigc assets"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'aigc-assets');

CREATE POLICY "Authenticated users can delete aigc assets"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'aigc-assets');
