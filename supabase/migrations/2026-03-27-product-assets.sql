-- =====================================================
-- Product Assets (images/media linked to product_specs by model)
-- =====================================================

CREATE TABLE product_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  model TEXT NOT NULL,
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_product_assets_agent ON product_assets(agent_id);
CREATE INDEX idx_product_assets_model ON product_assets(model);
CREATE INDEX idx_product_assets_agent_model ON product_assets(agent_id, model);

-- Storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-assets', 'product-assets', true)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'product-assets auth read'
  ) THEN
    CREATE POLICY "product-assets auth read"
      ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'product-assets');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'product-assets auth upload'
  ) THEN
    CREATE POLICY "product-assets auth upload"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'product-assets');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'product-assets auth delete'
  ) THEN
    CREATE POLICY "product-assets auth delete"
      ON storage.objects FOR DELETE
      TO authenticated
      USING (bucket_id = 'product-assets');
  END IF;
END $$;

-- RLS for product_assets table (match existing pattern: allow all for authenticated + anon)
ALTER TABLE product_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "product_assets_auth_all" ON product_assets
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);
