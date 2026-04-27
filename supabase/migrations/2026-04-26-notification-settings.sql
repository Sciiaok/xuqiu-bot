-- ============================================================================
-- Per-tenant 通知配置（V1 仅飞书自定义机器人 webhook）
--
-- 每个 tenant 在自己飞书群里加自定义机器人 → 复制 webhook URL → 粘到我们设置页。
-- URL 含 secret token，AES-256-GCM 加密落库。
-- ============================================================================

CREATE TABLE notification_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  feishu_webhook_url_encrypted BYTEA,
  feishu_enabled BOOLEAN NOT NULL DEFAULT false,
  feishu_last_test_at TIMESTAMPTZ,
  feishu_last_test_ok BOOLEAN,
  feishu_last_test_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE notification_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_settings_anon_full ON notification_settings
  FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY notification_settings_auth_tenant ON notification_settings
  FOR ALL TO authenticated
  USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
  WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()));
