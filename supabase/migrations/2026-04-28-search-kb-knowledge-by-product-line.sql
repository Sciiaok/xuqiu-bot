-- ============================================================================
-- search_kb_knowledge_en —— 改用 product_line_id 的新 overload
--
-- 配 2026-04-28-kb-tables-add-product-line-id.sql 一起跑。
-- product_lines.id (slug) 是用户视角的产品线 ID，跨租户可能重名，所以
-- WHERE 必须 (tenant_id, product_line_id) 双过滤。
--
-- 旧的两个 overload 一律保留不动，过渡期可以同时用：
--   search_kb_knowledge_en(p_agent_id, p_embedding, p_layers, p_top_k)
--   search_kb_knowledge_en(p_tenant_id, p_agent_id, p_embedding, p_layers, p_top_k)
-- 加上新的：
--   search_kb_knowledge_en(p_tenant_id, p_product_line_id, p_embedding, p_layers, p_top_k)
-- PostgreSQL 用参数列表区分 overload，三个版本同时存在不冲突。
-- ============================================================================

CREATE OR REPLACE FUNCTION search_kb_knowledge_en(
  p_tenant_id        uuid,
  p_product_line_id  text,
  p_embedding        vector(1536),
  p_layers           text[] DEFAULT NULL,
  p_top_k            int    DEFAULT 5
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
  WHERE kp.tenant_id       = p_tenant_id
    AND kp.product_line_id = p_product_line_id
    AND kp.status          = 'active'
    AND (kp.expires_at IS NULL OR kp.expires_at > CURRENT_DATE)
    AND kp.embedding_en IS NOT NULL
    AND (p_layers IS NULL OR kp.layer = ANY(p_layers))
  ORDER BY kp.embedding_en <=> p_embedding
  LIMIT p_top_k;
$$;

NOTIFY pgrst, 'reload schema';
