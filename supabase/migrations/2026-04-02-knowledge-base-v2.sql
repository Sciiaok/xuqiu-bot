-- =====================================================
-- Knowledge Base V2
-- Six-layer knowledge architecture with multilingual support,
-- structured data, pricing rules, and asset management.
-- =====================================================

-- 1. Knowledge Documents (uploaded files / external sources)
CREATE TABLE kb_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  filename TEXT NOT NULL,
  storage_path TEXT,
  layer TEXT NOT NULL CHECK (layer IN ('company', 'product', 'logistics', 'compliance', 'sales', 'competitive')),
  source_type TEXT NOT NULL DEFAULT 'file' CHECK (source_type IN ('file', 'feishu_doc', 'feishu_sheet', 'feishu_wiki', 'chat_extract', 'manual')),
  external_id TEXT,                          -- feishu doc_token etc.
  sync_enabled BOOLEAN DEFAULT false,
  last_synced_at TIMESTAMPTZ,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'ready', 'error')),
  error_message TEXT,
  knowledge_points_count INT DEFAULT 0,
  authority_level INT DEFAULT 3 CHECK (authority_level BETWEEN 1 AND 5),
  is_authoritative BOOLEAN DEFAULT false,
  is_outdated BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_kb_documents_agent ON kb_documents(agent_id);
CREATE INDEX idx_kb_documents_layer ON kb_documents(layer);
CREATE INDEX idx_kb_documents_status ON kb_documents(status);

-- 2. Knowledge Points (chunks with bilingual content + embeddings)
CREATE TABLE kb_knowledge_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id UUID REFERENCES kb_documents(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  layer TEXT NOT NULL CHECK (layer IN ('company', 'product', 'logistics', 'compliance', 'sales', 'competitive')),
  content_original TEXT NOT NULL,
  content_en TEXT,
  source_lang TEXT DEFAULT 'zh',
  metadata_json JSONB DEFAULT '{}',
  source_location TEXT,                      -- e.g. "Row 23" or "Page 5"
  -- Priority & lifecycle
  authority_level INT DEFAULT 3 CHECK (authority_level BETWEEN 1 AND 5),
  effective_date DATE DEFAULT CURRENT_DATE,
  expires_at DATE,
  superseded_by UUID REFERENCES kb_knowledge_points(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'superseded', 'draft')),
  -- Embeddings (stored inline with pgvector)
  embedding_original vector(1536),
  embedding_en vector(1536),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_kb_kp_agent ON kb_knowledge_points(agent_id);
CREATE INDEX idx_kb_kp_layer ON kb_knowledge_points(layer);
CREATE INDEX idx_kb_kp_status ON kb_knowledge_points(status);
CREATE INDEX idx_kb_kp_doc ON kb_knowledge_points(doc_id);
CREATE INDEX idx_kb_kp_embedding_en
  ON kb_knowledge_points USING ivfflat (embedding_en vector_cosine_ops)
  WITH (lists = 50);
CREATE INDEX idx_kb_kp_embedding_original
  ON kb_knowledge_points USING ivfflat (embedding_original vector_cosine_ops)
  WITH (lists = 50);

-- 3. Structured Products (parsed from Excel/CSV)
CREATE TABLE kb_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id UUID REFERENCES kb_documents(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  sku TEXT,
  product_name TEXT,
  product_name_en TEXT,
  model TEXT,
  category TEXT,
  specs JSONB DEFAULT '{}',
  fob_price_usd NUMERIC(10,2),
  moq INT,
  lead_time_days TEXT,
  source_row INT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_kb_products_agent ON kb_products(agent_id);
CREATE INDEX idx_kb_products_sku ON kb_products(sku);
CREATE INDEX idx_kb_products_category ON kb_products(category);
CREATE INDEX idx_kb_products_specs ON kb_products USING GIN(specs);

-- 4. Structured Shipping Routes (parsed from logistics Excel)
CREATE TABLE kb_shipping_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id UUID REFERENCES kb_documents(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  origin_port TEXT,
  destination_port TEXT,
  destination_country TEXT,
  shipping_method TEXT,
  cost_per_unit_usd NUMERIC(10,2),
  transit_days TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_kb_shipping_agent ON kb_shipping_routes(agent_id);
CREATE INDEX idx_kb_shipping_country ON kb_shipping_routes(destination_country);

-- 5. Pricing Rules (executable by calculate-price endpoint)
CREATE TABLE kb_pricing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  doc_id UUID REFERENCES kb_documents(id),
  rule_name TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('quantity_discount', 'shipping_markup', 'payment_term', 'special_offer')),
  priority INT DEFAULT 0,
  conditions JSONB DEFAULT '{}',
  calculation JSONB NOT NULL,
  requires_approval BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  effective_from DATE,
  effective_until DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_kb_pricing_agent ON kb_pricing_rules(agent_id);
CREATE INDEX idx_kb_pricing_type ON kb_pricing_rules(rule_type);

-- 6. Assets (images, PDFs, templates linked to products/knowledge)
CREATE TABLE kb_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('product_image', 'spec_sheet', 'quotation_template', 'certificate', 'brochure', 'other')),
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT,
  file_size_bytes INT,
  description TEXT,
  description_en TEXT,
  layer TEXT,
  linked_skus TEXT[],
  tags TEXT[],
  is_sendable BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_kb_assets_agent ON kb_assets(agent_id);
CREATE INDEX idx_kb_assets_type ON kb_assets(asset_type);
CREATE INDEX idx_kb_assets_skus ON kb_assets USING GIN(linked_skus);

-- 7. Product-Asset many-to-many
CREATE TABLE kb_product_assets (
  product_id UUID REFERENCES kb_products(id) ON DELETE CASCADE,
  asset_id UUID REFERENCES kb_assets(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT false,
  sort_order INT DEFAULT 0,
  PRIMARY KEY (product_id, asset_id)
);

-- 8. Glossary (bilingual term mapping for translation quality)
CREATE TABLE kb_glossary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  term_zh TEXT NOT NULL,
  term_en TEXT NOT NULL,
  context TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_kb_glossary_agent ON kb_glossary(agent_id);

-- 9. Storage bucket for knowledge base assets
INSERT INTO storage.buckets (id, name, public)
VALUES ('kb-assets', 'kb-assets', false)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'kb-assets auth read'
  ) THEN
    CREATE POLICY "kb-assets auth read"
      ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'kb-assets');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'kb-assets auth upload'
  ) THEN
    CREATE POLICY "kb-assets auth upload"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'kb-assets');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'kb-assets auth delete'
  ) THEN
    CREATE POLICY "kb-assets auth delete"
      ON storage.objects FOR DELETE
      TO authenticated
      USING (bucket_id = 'kb-assets');
  END IF;
END $$;

-- 10. RPC: semantic search on knowledge points (English embeddings)
CREATE OR REPLACE FUNCTION search_kb_knowledge_en(
  p_agent_id UUID,
  p_embedding vector(1536),
  p_layers TEXT[] DEFAULT NULL,
  p_top_k INT DEFAULT 5
)
RETURNS TABLE(
  id UUID,
  content_original TEXT,
  content_en TEXT,
  layer TEXT,
  metadata_json JSONB,
  source_location TEXT,
  authority_level INT,
  effective_date DATE,
  doc_id UUID,
  similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    kp.id,
    kp.content_original,
    kp.content_en,
    kp.layer,
    kp.metadata_json,
    kp.source_location,
    kp.authority_level,
    kp.effective_date,
    kp.doc_id,
    1 - (kp.embedding_en <=> p_embedding) AS similarity
  FROM kb_knowledge_points kp
  WHERE kp.agent_id = p_agent_id
    AND kp.status = 'active'
    AND (kp.expires_at IS NULL OR kp.expires_at > CURRENT_DATE)
    AND kp.embedding_en IS NOT NULL
    AND (p_layers IS NULL OR kp.layer = ANY(p_layers))
  ORDER BY kp.embedding_en <=> p_embedding
  LIMIT p_top_k;
$$;

-- 11. RPC: semantic search on knowledge points (original language embeddings)
CREATE OR REPLACE FUNCTION search_kb_knowledge_original(
  p_agent_id UUID,
  p_embedding vector(1536),
  p_layers TEXT[] DEFAULT NULL,
  p_top_k INT DEFAULT 5
)
RETURNS TABLE(
  id UUID,
  content_original TEXT,
  content_en TEXT,
  layer TEXT,
  metadata_json JSONB,
  source_location TEXT,
  authority_level INT,
  effective_date DATE,
  doc_id UUID,
  similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    kp.id,
    kp.content_original,
    kp.content_en,
    kp.layer,
    kp.metadata_json,
    kp.source_location,
    kp.authority_level,
    kp.effective_date,
    kp.doc_id,
    1 - (kp.embedding_original <=> p_embedding) AS similarity
  FROM kb_knowledge_points kp
  WHERE kp.agent_id = p_agent_id
    AND kp.status = 'active'
    AND (kp.expires_at IS NULL OR kp.expires_at > CURRENT_DATE)
    AND kp.embedding_original IS NOT NULL
    AND (p_layers IS NULL OR kp.layer = ANY(p_layers))
  ORDER BY kp.embedding_original <=> p_embedding
  LIMIT p_top_k;
$$;
