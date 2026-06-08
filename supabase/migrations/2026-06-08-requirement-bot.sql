BEGIN;

CREATE TABLE IF NOT EXISTS requirement_bot_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  feishu_app_id TEXT,
  feishu_app_secret_encrypted BYTEA,
  feishu_encrypt_key_encrypted BYTEA,
  feishu_verification_token_encrypted BYTEA,
  default_chat_id TEXT,
  default_pm_feishu_user_id TEXT,
  default_developer_feishu_user_id TEXT,
  default_tester_feishu_user_id TEXT,
  default_acceptor_feishu_user_id TEXT,
  bitable_app_token TEXT,
  bitable_table_id TEXT,
  reminder_hour INTEGER NOT NULL DEFAULT 10 CHECK (reminder_hour BETWEEN 0 AND 23),
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requirement_feishu_users (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  feishu_user_id TEXT NOT NULL,
  name TEXT,
  email TEXT,
  avatar_url TEXT,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feishu_user_id)
);

CREATE TABLE IF NOT EXISTS requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  req_no TEXT NOT NULL,
  title TEXT NOT NULL,
  raw_description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'needs_pm'
    CHECK (status IN (
      'needs_pm',
      'needs_info',
      'ready_for_dev',
      'in_dev',
      'ready_for_test',
      'in_test',
      'ready_for_acceptance',
      'closed',
      'rejected'
    )),
  requirement_type TEXT NOT NULL DEFAULT 'other'
    CHECK (requirement_type IN ('incident', 'improvement', 'feature', 'data_report', 'other')),
  prd_template_type TEXT NOT NULL DEFAULT 'light'
    CHECK (prd_template_type IN ('light', 'standard')),
  priority TEXT NOT NULL DEFAULT 'P2'
    CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  priority_reason TEXT,
  submitter_feishu_user_id TEXT NOT NULL,
  pm_owner_feishu_user_id TEXT,
  developer_feishu_user_id TEXT,
  tester_feishu_user_id TEXT,
  acceptor_feishu_user_id TEXT,
  current_owner_feishu_user_id TEXT,
  feishu_chat_id TEXT,
  feishu_root_message_id TEXT,
  feishu_card_message_id TEXT,
  feishu_message_url TEXT,
  feishu_card_url TEXT,
  bitable_record_id TEXT,
  bitable_sync_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (bitable_sync_status IN ('pending', 'synced', 'failed', 'skipped')),
  bitable_last_error TEXT,
  ai_confidence NUMERIC(4,3)
    CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)),
  ai_raw_output JSONB NOT NULL DEFAULT '{}'::jsonb,
  prd JSONB NOT NULL DEFAULT '{}'::jsonb,
  pm_due_at TIMESTAMPTZ,
  dev_due_at TIMESTAMPTZ,
  test_due_at TIMESTAMPTZ,
  acceptance_due_at TIMESTAMPTZ,
  planned_release_at TIMESTAMPTZ,
  actual_release_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  blocked_reason TEXT,
  latest_rejection_reason TEXT,
  last_status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reminded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, req_no)
);

CREATE TABLE IF NOT EXISTS requirement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requirement_id UUID NOT NULL,
  actor_feishu_user_id TEXT,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, requirement_id, id),
  FOREIGN KEY (tenant_id, requirement_id)
    REFERENCES requirements(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS requirement_attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requirement_id UUID NOT NULL,
  event_id UUID,
  kind TEXT NOT NULL,
  feishu_file_key TEXT,
  url TEXT,
  title TEXT,
  created_by_feishu_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, requirement_id)
    REFERENCES requirements(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, requirement_id, event_id)
    REFERENCES requirement_events(tenant_id, requirement_id, id)
    ON DELETE SET NULL (event_id)
);

CREATE TABLE IF NOT EXISTS requirement_reminder_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requirement_id UUID NOT NULL,
  reminder_type TEXT NOT NULL,
  target_feishu_user_id TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (tenant_id, requirement_id)
    REFERENCES requirements(tenant_id, id) ON DELETE CASCADE
);

CREATE SEQUENCE IF NOT EXISTS requirement_req_no_seq;

CREATE OR REPLACE FUNCTION next_requirement_req_no()
RETURNS BIGINT
LANGUAGE SQL
AS $$
  SELECT nextval('requirement_req_no_seq');
$$;

CREATE INDEX IF NOT EXISTS idx_requirement_feishu_users_tenant_admin
  ON requirement_feishu_users (tenant_id, is_admin);
CREATE INDEX IF NOT EXISTS idx_requirements_tenant_status
  ON requirements (tenant_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_requirements_tenant_priority
  ON requirements (tenant_id, priority, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_requirements_tenant_type
  ON requirements (tenant_id, requirement_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_requirements_current_owner
  ON requirements (tenant_id, current_owner_feishu_user_id, status);
CREATE INDEX IF NOT EXISTS idx_requirements_due
  ON requirements (tenant_id, status, pm_due_at, dev_due_at, test_due_at, acceptance_due_at);
CREATE INDEX IF NOT EXISTS idx_requirements_bitable_sync
  ON requirements (tenant_id, bitable_sync_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_requirement_events_requirement
  ON requirement_events (tenant_id, requirement_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requirement_attachments_requirement
  ON requirement_attachments (tenant_id, requirement_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_requirement_reminder_logs_requirement
  ON requirement_reminder_logs (tenant_id, requirement_id, sent_at DESC);

ALTER TABLE requirement_bot_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE requirement_feishu_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE requirements ENABLE ROW LEVEL SECURITY;
ALTER TABLE requirement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE requirement_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE requirement_reminder_logs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT;
  tables CONSTANT TEXT[] := ARRAY[
    'requirement_bot_settings',
    'requirement_feishu_users',
    'requirements',
    'requirement_events',
    'requirement_attachments',
    'requirement_reminder_logs'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_anon_full', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_auth_tenant', t);

    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO anon USING (true) WITH CHECK (true)',
      t || '_anon_full',
      t
    );

    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO authenticated
      USING (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
      WITH CHECK (tenant_id = (SELECT tenant_id FROM public.users WHERE id = auth.uid()))
    $f$, t || '_auth_tenant', t);
  END LOOP;
END $$;

COMMIT;
