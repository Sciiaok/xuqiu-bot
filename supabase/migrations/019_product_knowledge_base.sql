-- =====================================================
-- Product Knowledge Base
-- pgvector + product_documents + product_specs + product_embeddings
-- =====================================================

-- 1. Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Product documents (PDF metadata)
CREATE TABLE product_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  filename TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  doc_type TEXT NOT NULL DEFAULT 'general'
    CHECK (doc_type IN ('spec_sheet', 'manual', 'brochure', 'general')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'ready', 'error')),
  error_message TEXT,
  page_count INT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_product_documents_agent ON product_documents(agent_id);
CREATE INDEX idx_product_documents_status ON product_documents(status);

-- 3. Product specs (structured parameters, JSONB)
CREATE TABLE product_specs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES product_documents(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  model TEXT NOT NULL,
  brand TEXT,
  product_line TEXT NOT NULL,
  specs JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_product_specs_agent ON product_specs(agent_id);
CREATE INDEX idx_product_specs_model ON product_specs(model);
CREATE INDEX idx_product_specs_product_line ON product_specs(product_line);
CREATE INDEX idx_product_specs_specs ON product_specs USING GIN(specs);

-- 4. Product embeddings (vector search)
CREATE TABLE product_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES product_documents(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id),
  chunk_text TEXT NOT NULL,
  chunk_index INT NOT NULL,
  embedding vector(1536) NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_product_embeddings_agent ON product_embeddings(agent_id);
CREATE INDEX idx_product_embeddings_embedding
  ON product_embeddings USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 5. Storage bucket for PDF originals
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-docs', 'product-docs', false)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'product-docs auth read'
  ) THEN
    CREATE POLICY "product-docs auth read"
      ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'product-docs');
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'product-docs auth upload'
  ) THEN
    CREATE POLICY "product-docs auth upload"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'product-docs');
  END IF;
END $$;

-- 6. RPC: get spec fields for an agent (dynamic tool description)
CREATE OR REPLACE FUNCTION get_spec_fields(p_agent_id UUID)
RETURNS TEXT[]
LANGUAGE sql
STABLE
AS $$
  SELECT array_agg(DISTINCT key ORDER BY key)
  FROM product_specs, jsonb_object_keys(specs) AS key
  WHERE agent_id = p_agent_id;
$$;

-- 7. RPC: query product specs with dynamic WHERE clause
CREATE OR REPLACE FUNCTION query_product_specs(
  p_agent_id UUID,
  p_where_clause TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result JSONB;
BEGIN
  -- Safety: reject dangerous keywords
  IF p_where_clause ~* '(drop|delete|update|insert|alter|truncate|;|--|/\*)' THEN
    RAISE EXCEPTION 'Invalid query';
  END IF;

  EXECUTE format(
    'SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT model, brand, product_line, specs
      FROM product_specs
      WHERE agent_id = %L AND (%s)
      LIMIT 10
    ) t',
    p_agent_id,
    p_where_clause
  ) INTO result;

  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;

-- 8. RPC: semantic search via embedding similarity
CREATE OR REPLACE FUNCTION search_product_embeddings(
  p_agent_id UUID,
  p_embedding vector(1536),
  p_top_k INT DEFAULT 3
)
RETURNS TABLE(
  chunk_text TEXT,
  metadata JSONB,
  similarity FLOAT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    pe.chunk_text,
    pe.metadata,
    1 - (pe.embedding <=> p_embedding) AS similarity
  FROM product_embeddings pe
  WHERE pe.agent_id = p_agent_id
  ORDER BY pe.embedding <=> p_embedding
  LIMIT p_top_k;
$$;
