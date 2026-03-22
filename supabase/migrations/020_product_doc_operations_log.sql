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
