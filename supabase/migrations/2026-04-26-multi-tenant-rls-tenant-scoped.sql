-- ============================================================================
-- 多租户改造 · RLS 策略（防御纵深）
--
-- 设计：每张业务表挂两条 policy
--   1. <table>_anon_full      → anon 角色全权访问（server-side 用 anon key
--                                 走 service-like 模式，靠 .eq('tenant_id') 显式
--                                 过滤，跟现有 product_lines_auth_all 同模式）
--   2. <table>_auth_tenant    → authenticated 角色只能访问自己 tenant 的行
--                                 （browser 直接查 DB 时的兜底）
--
-- WHY 这么分：当前后端代码全走 anon key，强制 tenant-aware RLS 会让所有 server
-- query 返回空。anon-permissive + authenticated-tenant 是当前架构能实际生效
-- 的最严格 policy 配置。Phase 2 把 server-side 切到 service-role 后，可以把
-- anon 那条 drop 掉收紧成单 authenticated policy。
--
-- 行级子查询 `(SELECT tenant_id FROM users WHERE id = auth.uid())` 在每行匹
-- 配时会跑一次，但 PG 会做 plan-level cache，量级 OK。如果实测有性能问题再
-- 改成 JWT custom claim。
-- ============================================================================

DO $$
DECLARE
  t TEXT;
  business_tables CONSTANT TEXT[] := ARRAY[
    -- 客户 / 会话 / 商机
    'contacts', 'conversations', 'messages', 'leads', 'lead_sync_logs',
    -- 产品线 / Agent
    'product_lines', 'agents',
    -- 旧产品文档
    'product_documents', 'product_specs', 'product_embeddings',
    'product_doc_operations', 'product_assets',
    -- 知识库 v2
    'kb_documents', 'kb_knowledge_points', 'kb_products',
    'kb_shipping_routes', 'kb_pricing_rules', 'kb_assets',
    'kb_product_assets', 'kb_glossary',
    'kb_test_sessions', 'kb_test_messages', 'kb_knowledge_gaps',
    -- AIGC / 报表 / Dashboard
    'aigc_assets', 'ai_reports', 'inquiry_dashboard_summaries',
    -- Campaign 编排 / Autopilot
    'campaign_briefs', 'orchestrator_sessions', 'orchestrator_messages',
    'autopilot_sessions', 'autopilot_messages',
    -- 故障知识
    'fix_knowledge'
  ];
BEGIN
  FOREACH t IN ARRAY business_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN
      RAISE NOTICE 'skipping %: table does not exist', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);

    -- 清掉历史 policy（包括 product_lines_auth_all 这种老命名）
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_auth_all', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_anon_full', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_auth_tenant', t);

    -- anon: server-side 全权放行（靠应用层 .eq('tenant_id') 兜底）
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO anon USING (true) WITH CHECK (true)',
      t || '_anon_full', t
    );

    -- authenticated: 只能访问自己 tenant 的行
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO authenticated
      USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
      WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
    $f$, t || '_auth_tenant', t);
  END LOOP;
END $$;
