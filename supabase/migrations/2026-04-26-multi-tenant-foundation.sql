-- ============================================================================
-- 多租户改造 · 第一刀：账号系统骨架 + 业务表加 tenant_id
-- 详见 docs/multi-tenant-refactor.md §3, §6
--
-- 本迁移完成后：
--   1. tenants / users / invitations / onboarding_progress 4 张新表就位
--   2. 所有业务表挂上 tenant_id NOT NULL，全部归到 founder tenant
--   3. 系统行为不变（数据全在 founder 名下，老代码继续跑）
--
-- 不在本迁移内：
--   - RLS 策略（下一刀，启用前先把 server-side 查询全部带上 tenant_id）
--   - Auth 接入 / 邀请页 / 注册页
--   - meta_connections / meta_phone_numbers（Phase 2）
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. 新增 4 张表
-- ---------------------------------------------------------------------------

CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'owner'
    CHECK (role IN ('owner', 'admin', 'member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_tenant ON users(tenant_id);

CREATE TABLE invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  accepted_at TIMESTAMPTZ,
  accepted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_invitations_token ON invitations(token);
CREATE INDEX idx_invitations_email ON invitations(LOWER(email));

CREATE TABLE onboarding_progress (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  account_created_at TIMESTAMPTZ,
  meta_connected_at TIMESTAMPTZ,
  first_product_line_at TIMESTAMPTZ,
  first_kb_uploaded_at TIMESTAMPTZ,
  first_message_received_at TIMESTAMPTZ,
  first_ai_reply_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- 2. Founder tenant：所有现有数据的归属
-- ---------------------------------------------------------------------------

INSERT INTO tenants (id, name, slug, status)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Founder',
  'founder',
  'active'
);

INSERT INTO onboarding_progress (tenant_id, completed_at)
VALUES ('00000000-0000-0000-0000-000000000001', now());

-- ---------------------------------------------------------------------------
-- 3. 业务表批量加 tenant_id
--
-- 三步走：
--   (1) ADD COLUMN ... DEFAULT founder_id  → PG 11+ metadata-only，瞬间完成
--   (2) ALTER ... SET NOT NULL             → 校验确实没有 NULL
--   (3) ALTER ... DROP DEFAULT             → 防止后续业务代码漏写 tenant_id
--                                            时静默落到 founder 名下
-- ---------------------------------------------------------------------------

-- 注意：仓库里的 migration 文件和实际 DB 不完全一致（部分迁移未应用）。
-- 这里用 to_regclass 跳过不存在的表，并 RAISE NOTICE 提示，便于事后 diff。
DO $$
DECLARE
  t TEXT;
  founder_id CONSTANT UUID := '00000000-0000-0000-0000-000000000001';
  business_tables CONSTANT TEXT[] := ARRAY[
    -- 客户 / 会话 / 商机
    'contacts', 'conversations', 'messages', 'leads', 'lead_sync_logs',
    -- 产品线 / Agent
    'product_lines', 'agents',
    -- 旧产品文档（逐步弃用，仍在用）
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
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN tenant_id UUID DEFAULT %L REFERENCES tenants(id)',
      t, founder_id
    );
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET NOT NULL', t);
    EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id DROP DEFAULT', t);
    EXECUTE format(
      'CREATE INDEX %I ON %I(tenant_id)',
      'idx_' || t || '_tenant', t
    );
  END LOOP;
END $$;

COMMIT;
