-- ============================================================================
-- search_kb_knowledge_en —— 加 tenant 维度的新 overload
--
-- 老版 search_kb_knowledge_en(p_agent_id, p_embedding, p_layers, p_top_k)
-- 仅按 agent_id 过滤。kb_knowledge_points 多租户改造后已经有 tenant_id 列，
-- 这里加一个 5 参 overload，让调用方显式带 tenant_id 进来做 defense-in-depth。
--
-- ⚠️ 老函数刻意保留不删 —— PostgreSQL 用参数列表区分 overload，新老共存，
-- 不影响历史 SQL 直接调用旧版的场景。
-- ============================================================================

CREATE OR REPLACE FUNCTION search_kb_knowledge_en(
  p_tenant_id  uuid,
  p_agent_id   uuid,
  p_embedding  vector(1536),
  p_layers     text[] DEFAULT NULL,
  p_top_k      int    DEFAULT 5
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
  WHERE kp.tenant_id = p_tenant_id
    AND kp.agent_id  = p_agent_id
    AND kp.status    = 'active'
    AND (kp.expires_at IS NULL OR kp.expires_at > CURRENT_DATE)
    AND kp.embedding_en IS NOT NULL
    AND (p_layers IS NULL OR kp.layer = ANY(p_layers))
  ORDER BY kp.embedding_en <=> p_embedding
  LIMIT p_top_k;
$$;

NOTIFY pgrst, 'reload schema';
