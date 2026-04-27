-- ============================================================================
-- KB 表加 product_line_id 列：消除 §8.1 的 slug↔UUID 桥
--
-- 背景：kb_* 表全部按 agent_id (UUID) 索引，但用户视角的产品线 ID 是
-- product_lines.id (slug)。这导致 medici/kb 一路要先 findAgentIdByProductLine
-- 才能查 KB —— 见 medici-design.md §8.1。
--
-- 这次改造的原则（按用户"DB 旧数据不动"的规矩）：
--   * 新加 product_line_id TEXT 列（nullable，过渡期允许）
--   * 一次性 backfill：通过 agents 表 join 反推 product_line slug
--   * trigger 兜底：未来 INSERT/UPDATE 只设 agent_id 也能自动填 product_line_id
--   * 旧 agent_id 列保留不删；现存代码仍可工作
--   * 加 (tenant_id, product_line_id) 索引让新查询路径走得快
--
-- 配套新 RPC overload search_kb_knowledge_en(p_tenant_id, p_product_line_id, …)
-- 见 2026-04-28-search-kb-knowledge-by-product-line.sql。
-- ============================================================================

DO $$
DECLARE
  t TEXT;
  kb_tables CONSTANT TEXT[] := ARRAY[
    'kb_documents',          -- active
    'kb_knowledge_points',   -- active（向量检索）
    'kb_products',           -- active
    'kb_shipping_routes',    -- active
    'kb_assets',             -- active（资产上传）
    'kb_knowledge_gaps',     -- active（盲区回写）
    'kb_pricing_rules',      -- dormant 但有 agent_id 列
    'kb_glossary',           -- dormant
    'kb_test_sessions',      -- 测试库
    'kb_test_messages'       -- 测试库
  ];
BEGIN
  FOREACH t IN ARRAY kb_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'skipping %: table not found', t;
      CONTINUE;
    END IF;
    -- 列没 agent_id 的表跳过（kb_product_assets 是关联表）
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=t AND column_name='agent_id'
    ) THEN
      RAISE NOTICE 'skipping %: no agent_id column', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS product_line_id TEXT', t);

    -- 一次性 backfill（已经有 product_line_id 的行不重写）
    EXECUTE format($f$
      UPDATE %I AS k
         SET product_line_id = a.product_line
        FROM agents a
       WHERE a.id = k.agent_id
         AND k.product_line_id IS NULL
    $f$, t);

    -- 索引：tenant_id + product_line_id 是新查询的主复合键
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_tenant_pl ON %I (tenant_id, product_line_id)',
      t, t
    );
  END LOOP;
END $$;

-- 自动填充 trigger：未来 INSERT/UPDATE 只设 agent_id（不设 product_line_id）时
-- 自动从 agents 表反查填上。这样老代码不需要立刻改也能写新行。
CREATE OR REPLACE FUNCTION kb_autofill_product_line_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.product_line_id IS NULL AND NEW.agent_id IS NOT NULL THEN
    SELECT product_line INTO NEW.product_line_id
      FROM agents WHERE id = NEW.agent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
  kb_tables CONSTANT TEXT[] := ARRAY[
    'kb_documents', 'kb_knowledge_points', 'kb_products',
    'kb_shipping_routes', 'kb_assets', 'kb_knowledge_gaps',
    'kb_pricing_rules', 'kb_glossary',
    'kb_test_sessions', 'kb_test_messages'
  ];
BEGIN
  FOREACH t IN ARRAY kb_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN CONTINUE; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=t AND column_name='product_line_id'
    ) THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_autofill_pl ON %I', t, t);
    EXECUTE format($f$
      CREATE TRIGGER trg_%s_autofill_pl
        BEFORE INSERT OR UPDATE OF agent_id ON %I
        FOR EACH ROW EXECUTE FUNCTION kb_autofill_product_line_id()
    $f$, t, t);
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
