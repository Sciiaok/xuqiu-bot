-- Enable pgvector if not already enabled
CREATE EXTENSION IF NOT EXISTS vector;

-- Fix knowledge base — stores error-fix experiences for RAG retrieval
CREATE TABLE fix_knowledge (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  error_pattern text NOT NULL,          -- the error message/key pattern
  error_context text,                   -- phase, what was happening
  solution text NOT NULL,               -- what fix was applied (human-readable)
  solution_action jsonb,                -- structured action: { tool: 'patch_brief', fields: {...} }
  solution_type text NOT NULL DEFAULT 'auto'
    CHECK (solution_type IN ('auto', 'user_provided', 'web_search')),
  embedding vector(768),                -- Jina embedding for similarity search
  success_count integer NOT NULL DEFAULT 1,
  fail_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- Index for vector similarity search
CREATE INDEX idx_fix_knowledge_embedding ON fix_knowledge
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 10);

-- RPC function for similarity search
CREATE OR REPLACE FUNCTION search_fix_knowledge(
  query_embedding vector(768),
  match_threshold float DEFAULT 0.75,
  match_count int DEFAULT 3
)
RETURNS TABLE (
  id uuid,
  error_pattern text,
  error_context text,
  solution text,
  solution_action jsonb,
  solution_type text,
  success_count integer,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    fk.id,
    fk.error_pattern,
    fk.error_context,
    fk.solution,
    fk.solution_action,
    fk.solution_type,
    fk.success_count,
    1 - (fk.embedding <=> query_embedding) AS similarity
  FROM fix_knowledge fk
  WHERE 1 - (fk.embedding <=> query_embedding) > match_threshold
  ORDER BY fk.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- RLS
ALTER TABLE fix_knowledge ENABLE ROW LEVEL SECURITY;
CREATE POLICY "fix_knowledge_auth_all" ON fix_knowledge
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);
