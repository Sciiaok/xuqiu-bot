-- ============================================================================
-- Phase 3 · audit_log: 关键管理操作的审计日志
--
-- 记录：邀请创建/接受/撤销、Meta 连接/断开、Tenant 暂停等。Phase 1 没做，
-- 现在补上 —— 出问题排查时知道"什么时候谁干了什么"。
-- ============================================================================

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_log(action, created_at DESC);

-- RLS：跟其它管理表一致 —— anon 全权（server-side 写）+ authenticated 只看自己 tenant
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_log_anon_full ON audit_log FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY audit_log_auth_tenant ON audit_log FOR ALL TO authenticated
  USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
  WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));
