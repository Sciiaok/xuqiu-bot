-- ============================================================================
-- llm_usage_logs: 大模型调用 token 成本明细
--
-- 每次 LLM 调用一行；服务端 fire-and-forget 写入。
-- 维度：tenant_id × call_site × model × created_at
-- 用于 founder 后台「大模型成本」页做聚合统计。
-- ============================================================================

CREATE TABLE llm_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  call_site TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  finish_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_llm_usage_tenant_created ON llm_usage_logs(tenant_id, created_at DESC);
CREATE INDEX idx_llm_usage_callsite_created ON llm_usage_logs(call_site, created_at DESC);
CREATE INDEX idx_llm_usage_created ON llm_usage_logs(created_at DESC);

-- RLS：跟 audit_log 同模式 —— anon 全权（server-side 用 service-role 写/读）
-- + authenticated 只看自己 tenant 的（普通租户暂时不暴露页面，只是兜底）
ALTER TABLE llm_usage_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY llm_usage_logs_anon_full ON llm_usage_logs FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY llm_usage_logs_auth_tenant ON llm_usage_logs FOR ALL TO authenticated
  USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
  WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));
