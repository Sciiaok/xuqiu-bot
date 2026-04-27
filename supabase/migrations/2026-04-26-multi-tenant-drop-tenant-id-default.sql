-- ============================================================================
-- 多租户改造 · 收口：drop tenant_id DEFAULT 兜底
--
-- 之前为兼容渐进式 writer 改造，给所有业务表 tenant_id 列挂了
-- DEFAULT '00000000-0000-0000-0000-000000000001'（founder）。
-- 现在所有 INSERT 路径都已经显式传 tenant_id，drop 这个 DEFAULT，让任何
-- 漏写 tenant_id 的 INSERT 直接 NOT NULL 报错而不是静默挂到 founder 名下。
-- ============================================================================

DO $$
DECLARE
  t TEXT;
  business_tables CONSTANT TEXT[] := ARRAY[
    'contacts', 'conversations', 'messages', 'leads', 'lead_sync_logs',
    'product_lines', 'agents',
    'product_documents', 'product_specs', 'product_embeddings',
    'product_doc_operations', 'product_assets',
    'kb_documents', 'kb_knowledge_points', 'kb_products',
    'kb_shipping_routes', 'kb_pricing_rules', 'kb_assets',
    'kb_product_assets', 'kb_glossary',
    'kb_test_sessions', 'kb_test_messages', 'kb_knowledge_gaps',
    'aigc_assets', 'ai_reports', 'inquiry_dashboard_summaries',
    'campaign_briefs', 'orchestrator_sessions', 'orchestrator_messages',
    'autopilot_sessions', 'autopilot_messages',
    'fix_knowledge'
  ];
BEGIN
  FOREACH t IN ARRAY business_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id DROP DEFAULT', t);
  END LOOP;
END $$;
