-- ============================================================================
-- 多租户改造 · 紧急补丁：临时恢复 tenant_id 的 DEFAULT
--
-- 上一个 migration（2026-04-26-multi-tenant-foundation.sql）把 tenant_id 的
-- DEFAULT 直接 DROP 掉了，理由是"防止业务代码漏写时静默落到 founder"。
-- 但是：webhook 流程里 contacts / conversations / messages / leads 等表的
-- INSERT 调用方根本还没改造，没有显式传 tenant_id。结果就是任何入站 WhatsApp
-- 消息都会因 NOT NULL 违反而炸掉。
--
-- 妥协方案：重新挂上 DEFAULT = founder tenant。这样老代码继续跑，新代码可以
-- 显式传 tenant_id 覆盖默认值。等所有 writer 都改造完，再做一次 DROP DEFAULT
-- 把这层网拆掉。
-- ============================================================================

DO $$
DECLARE
  t TEXT;
  founder_id CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
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
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT %L',
      t, founder_id
    );
  END LOOP;
END $$;
