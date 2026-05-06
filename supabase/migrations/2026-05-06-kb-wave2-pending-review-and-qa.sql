-- ============================================================================
-- KB Wave 2 — Pending review queue + QA snippets
--
--   ① kb_pending_review
--      LLM 抽取出的低置信 fact、或者和已有 verified 数据冲突的写入，
--      不直接进活跃表 —— 先进这张队列，等人工裁决。
--
--   ② kb_qa_snippets
--      销售脑里的隐性知识：客户问 X 我们答 Y，无文件、无附件。
--      问题侧向量化，medici 可以直接命中。
-- ============================================================================

-- ── ① Pending review ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kb_pending_review (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  product_line_id TEXT NOT NULL,

  -- 想写入哪张表 + payload（jsonb，按表 schema 解析）
  target_table    TEXT NOT NULL CHECK (target_table IN (
    'kb_products', 'kb_shipping_routes', 'kb_pricing_rules',
    'kb_knowledge_points', 'kb_assets'
  )),
  target_payload  JSONB NOT NULL,

  -- 进队列的原因
  reason          TEXT NOT NULL CHECK (reason IN (
    'conflict',              -- 和现存 verified 行冲突
    'low_confidence',        -- 抽取置信度低
    'expired_replacement',   -- 想替换一条已过期数据
    'asset_missing_tags'     -- 图片缺必填 tag
  )),
  conflict_with   UUID,                        -- 冲突时指向被挑战的现存 row id
  source_doc_id   UUID REFERENCES kb_documents(id),
  extracted_confidence NUMERIC(3,2),           -- 0.00–1.00

  -- 流转状态
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'rejected', 'merged'
  )),
  resolved_by     UUID,
  resolved_at     TIMESTAMPTZ,
  resolved_note   TEXT,
  resolved_target_id UUID,                     -- approved 时写入活跃表后回填的 id

  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_pending_review_tenant_pl
  ON kb_pending_review (tenant_id, product_line_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_pending_review_doc
  ON kb_pending_review (source_doc_id);

-- ── ② QA snippets ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS kb_qa_snippets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id),
  product_line_id     TEXT NOT NULL,

  -- 多种问法用数组（销售可以列 3-5 种客户的真实表述）
  questions           TEXT[] NOT NULL,
  -- 问题侧向量（拼接 questions 数组后取 embedding）
  questions_embedding vector(1536),

  answer              TEXT NOT NULL,
  -- 适用条件：{ region, customer_type, sku, destination_country, ... }
  applicable_when     JSONB DEFAULT '{}',

  priority            INT DEFAULT 5,           -- 1–10，越高越优先
  is_active           BOOLEAN DEFAULT true,

  created_by          UUID,
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_qa_snippets_tenant_pl
  ON kb_qa_snippets (tenant_id, product_line_id, is_active);

-- 向量索引（IVFFlat，和 kb_knowledge_points 风格一致）
CREATE INDEX IF NOT EXISTS idx_kb_qa_snippets_embedding
  ON kb_qa_snippets USING ivfflat (questions_embedding vector_cosine_ops)
  WITH (lists = 50);

-- ── 检索 RPC：按问题语义 + 适用条件搜 QA ──────────────────────────────

CREATE OR REPLACE FUNCTION search_kb_qa_snippets(
  p_tenant_id UUID,
  p_product_line_id TEXT,
  p_embedding vector(1536),
  p_top_k INT DEFAULT 3
)
RETURNS TABLE (
  id UUID,
  questions TEXT[],
  answer TEXT,
  applicable_when JSONB,
  priority INT,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    q.id,
    q.questions,
    q.answer,
    q.applicable_when,
    q.priority,
    1 - (q.questions_embedding <=> p_embedding) AS similarity
  FROM kb_qa_snippets q
  WHERE q.tenant_id = p_tenant_id
    AND q.product_line_id = p_product_line_id
    AND q.is_active = true
    AND q.questions_embedding IS NOT NULL
  ORDER BY q.questions_embedding <=> p_embedding
  LIMIT p_top_k;
END;
$$ LANGUAGE plpgsql STABLE;
