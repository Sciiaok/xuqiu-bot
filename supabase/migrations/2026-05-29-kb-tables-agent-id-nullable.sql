-- ============================================================================
-- KB 表松绑 agent_id：从 NOT NULL 改 NULL，配合应用层全面切到 product_line_id。
--
-- 背景：2026-04-28-kb-tables-add-product-line-id.sql 已经把 product_line_id
-- 列 + autofill trigger + (tenant_id, product_line_id) 索引都加好了。但旧
-- agent_id 列仍 NOT NULL，导致新建产品线时（agents 表里没对应行）首次 KB
-- insert 直接撞 NOT NULL violation。
--
-- 本迁移只做"松约束"，不删任何列、不改任何旧行：
--   * kb_* 表 agent_id：DROP NOT NULL
--   * uniq_kb_documents_agent_content → uniq_kb_documents_pl_content
--     键基从 (agent_id, content_sha256) 换 (tenant_id, product_line_id,
--     content_sha256)。旧 unique 删除前先建新的，避免上传管道窗口。
--
-- 保留不动：
--   * agent_id 列本身（历史数据仍可读）
--   * autofill trigger（kb_autofill_product_line_id，给老代码兜底）
--   * idx_*_agent 索引（不影响正确性，只是没人查了）
--   * agents 表 / agents_product_line_key 索引
-- ============================================================================

DO $$
DECLARE
  t TEXT;
  kb_tables CONSTANT TEXT[] := ARRAY[
    'kb_documents',
    'kb_knowledge_points',
    'kb_products',
    'kb_shipping_routes',
    'kb_assets',
    'kb_pricing_rules',
    'kb_glossary',
    'kb_test_sessions'
  ];
BEGIN
  FOREACH t IN ARRAY kb_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'skipping %: table not found', t;
      CONTINUE;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=t
         AND column_name='agent_id' AND is_nullable='NO'
    ) THEN
      RAISE NOTICE 'skipping %: agent_id already nullable or column missing', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN agent_id DROP NOT NULL', t);
  END LOOP;
END $$;

-- 新 unique 约束：tenant + product_line + sha 三元组，product_line_id 是
-- text slug，所以多 tenant 复用同名 slug 不会冲突。
CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_documents_pl_content
  ON kb_documents (tenant_id, product_line_id, content_sha256)
  WHERE content_sha256 IS NOT NULL;

-- 旧 unique 约束删除（先建新的，再删旧的）。
DROP INDEX IF EXISTS uniq_kb_documents_agent_content;

NOTIFY pgrst, 'reload schema';
