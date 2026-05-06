-- ============================================================================
-- KB Wave 1 — Validity / Confidence / Asset tagging
--
-- 让 medici 在调 KB 时拿到的不是"差不多的片段"，而是"带置信度+有效期+来源"
-- 的确定性结果。这一波只增列、不改老数据：
--
--   ① fact 类表（kb_products / kb_shipping_routes / kb_pricing_rules）
--      统一加 effective_date / expiry_date / confidence / source_doc_id。
--      老行没有这些值，默认 confidence=verified（视为已审核）、无 expiry。
--
--   ② kb_assets 加结构化标签（view / color / scenario / language / expiry_date）
--      + caption_embedding 用于语义兜底搜索。
--
--   ③ kb_knowledge_points 加 confidence（用于把低置信抽取从活跃池里筛掉）。
--
-- 全程 ADD COLUMN IF NOT EXISTS，老查询不受影响。
-- ============================================================================

-- ── ① Fact tables: validity + confidence ──────────────────────────────

-- kb_pricing_rules 已经有 effective_from/effective_until + requires_approval，
-- 这一波只补 kb_products / kb_shipping_routes 的 effective_date/expiry_date/
-- confidence/source_doc_id 即可。
DO $$
DECLARE
  t TEXT;
  fact_tables CONSTANT TEXT[] := ARRAY[
    'kb_products',
    'kb_shipping_routes'
  ];
BEGIN
  FOREACH t IN ARRAY fact_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'skipping %: table not found', t;
      CONTINUE;
    END IF;

    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS effective_date DATE NOT NULL DEFAULT CURRENT_DATE',
      t
    );
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS expiry_date DATE', t);
    EXECUTE format(
      $f$ALTER TABLE %I ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT 'verified'$f$,
      t
    );
    -- 加 CHECK 约束（先 DROP 再 ADD 防重复）
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', t, t || '_confidence_check');
    EXECUTE format(
      $f$ALTER TABLE %I ADD CONSTRAINT %I CHECK (confidence IN ('verified','extracted_high','extracted_low'))$f$,
      t, t || '_confidence_check'
    );
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS source_doc_id UUID REFERENCES kb_documents(id)',
      t
    );

    -- 索引：按 (tenant_id, product_line_id, expiry_date) 过期过滤是高频路径
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_expiry ON %I (tenant_id, product_line_id, expiry_date)',
      t, t
    );
  END LOOP;
END $$;

-- ── ② Asset tagging ─────────────────────────────────────────────────

ALTER TABLE kb_assets ADD COLUMN IF NOT EXISTS view TEXT;
ALTER TABLE kb_assets ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE kb_assets ADD COLUMN IF NOT EXISTS scenario TEXT;
ALTER TABLE kb_assets ADD COLUMN IF NOT EXISTS language TEXT;
ALTER TABLE kb_assets ADD COLUMN IF NOT EXISTS expiry_date DATE;
ALTER TABLE kb_assets ADD COLUMN IF NOT EXISTS caption_embedding vector(1536);

CREATE INDEX IF NOT EXISTS idx_kb_assets_view ON kb_assets (tenant_id, product_line_id, view);
CREATE INDEX IF NOT EXISTS idx_kb_assets_scenario ON kb_assets (tenant_id, product_line_id, scenario);

-- ── ③ Knowledge points confidence ───────────────────────────────────

ALTER TABLE kb_knowledge_points
  ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT 'extracted_high';

ALTER TABLE kb_knowledge_points DROP CONSTRAINT IF EXISTS kb_knowledge_points_confidence_check;
ALTER TABLE kb_knowledge_points ADD CONSTRAINT kb_knowledge_points_confidence_check
  CHECK (confidence IN ('verified','extracted_high','extracted_low'));
