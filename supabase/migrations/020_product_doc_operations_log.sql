-- Operation log for product document lifecycle events
CREATE TABLE product_doc_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES product_documents(id) ON DELETE SET NULL,
  agent_id UUID NOT NULL REFERENCES agents(id),
  operation TEXT NOT NULL CHECK (operation IN ('upload', 'parsed', 'error', 'delete', 'retry')),
  operator TEXT,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_product_doc_ops_agent ON product_doc_operations(agent_id);
CREATE INDEX idx_product_doc_ops_created ON product_doc_operations(created_at DESC);

-- RLS policies for product knowledge tables (allow all for authenticated users)
ALTER TABLE product_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_documents_auth_all" ON product_documents
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

ALTER TABLE product_specs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_specs_auth_all" ON product_specs
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

ALTER TABLE product_embeddings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_embeddings_auth_all" ON product_embeddings
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

ALTER TABLE product_doc_operations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "product_doc_operations_auth_all" ON product_doc_operations
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);

-- Add missing storage DELETE policy for product-docs bucket
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'product-docs auth delete'
  ) THEN
    CREATE POLICY "product-docs auth delete"
      ON storage.objects FOR DELETE
      TO authenticated
      USING (bucket_id = 'product-docs');
  END IF;
END $$;
