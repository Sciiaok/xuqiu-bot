-- ============================================================================
-- Phase 2 · Meta 接入表：per-tenant Meta BM 连接 + 同步过来的号码 / 广告账户
-- 详见 docs/multi-tenant-refactor.md §3.1 §4
--
-- 设计要点：
--   - meta_connections: 1 个 active 连接 / tenant（partial unique 索引）；
--     system_user_token_encrypted 用 AES-256-GCM 加密后的 bytea 存储。
--   - meta_phone_numbers: 同步快照；phoneNumberId 是 Meta 全局唯一所以做 PK；
--     disconnect 时硬删避免软删 + PK 冲撞。
--   - meta_ad_accounts: 同 phones，但 ad_account_id 是 PK。
-- ============================================================================

BEGIN;

-- 1. meta_connections ----------------------------------------------------

CREATE TABLE meta_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bm_id TEXT NOT NULL,
  business_name TEXT,
  system_user_token_encrypted BYTEA NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disconnected', 'revoked')),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  connected_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  last_health_check_at TIMESTAMPTZ,
  health_check_failed_count INT NOT NULL DEFAULT 0,
  disconnected_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_meta_conn_tenant ON meta_connections(tenant_id, status);
-- 一个 tenant 同一时刻最多一个 active 连接
CREATE UNIQUE INDEX idx_meta_conn_active_per_tenant
  ON meta_connections(tenant_id) WHERE status = 'active';

-- 2. meta_phone_numbers --------------------------------------------------

CREATE TABLE meta_phone_numbers (
  phone_number_id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  meta_connection_id UUID NOT NULL REFERENCES meta_connections(id) ON DELETE CASCADE,
  waba_id TEXT NOT NULL,
  display_number TEXT NOT NULL,
  verified_name TEXT,
  quality_rating TEXT,
  code_verification_status TEXT,
  is_registered BOOLEAN NOT NULL DEFAULT false,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'removed'))
);
CREATE INDEX idx_phone_tenant ON meta_phone_numbers(tenant_id);
CREATE INDEX idx_phone_waba ON meta_phone_numbers(waba_id);

-- 3. meta_ad_accounts ----------------------------------------------------

CREATE TABLE meta_ad_accounts (
  ad_account_id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  meta_connection_id UUID NOT NULL REFERENCES meta_connections(id) ON DELETE CASCADE,
  name TEXT,
  currency TEXT,
  timezone TEXT,
  account_status INT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'removed'))
);
CREATE INDEX idx_ad_tenant ON meta_ad_accounts(tenant_id);

-- 4. RLS：跟 phase 1 同模式（anon 全权 + authenticated tenant-scoped）-------

DO $$
DECLARE
  t TEXT;
  tables CONSTANT TEXT[] := ARRAY['meta_connections', 'meta_phone_numbers', 'meta_ad_accounts'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO anon USING (true) WITH CHECK (true)',
      t || '_anon_full', t
    );
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO authenticated
      USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
      WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
    $f$, t || '_auth_tenant', t);
  END LOOP;
END $$;

COMMIT;
