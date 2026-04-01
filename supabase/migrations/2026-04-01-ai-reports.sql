-- AI Analysis Reports table
-- Stores auto-generated (daily/weekly/monthly) and manual reports

CREATE TABLE IF NOT EXISTS ai_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('daily', 'weekly', 'monthly', 'manual')),
  status TEXT NOT NULL DEFAULT 'generating' CHECK (status IN ('generating', 'completed', 'failed')),
  agent_ids TEXT[] NOT NULL DEFAULT '{}',
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  content JSONB,
  summary_line TEXT,
  kpi_snapshot JSONB,
  retry_count INT NOT NULL DEFAULT 0,
  error_message TEXT,
  generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for listing reports by type and date
CREATE INDEX idx_ai_reports_type_created ON ai_reports (type, created_at DESC);

-- Index for finding failed reports that need retry
CREATE INDEX idx_ai_reports_status ON ai_reports (status) WHERE status = 'failed';

-- Prevent duplicate auto-generated reports for the same period
CREATE UNIQUE INDEX idx_ai_reports_unique_auto
  ON ai_reports (type, period_start, period_end)
  WHERE type IN ('daily', 'weekly', 'monthly') AND agent_ids = '{}';

COMMENT ON TABLE ai_reports IS 'AI-generated analysis reports (daily/weekly/monthly/manual)';
COMMENT ON COLUMN ai_reports.agent_ids IS 'Agent ID array for business line scope. Empty = all lines.';
COMMENT ON COLUMN ai_reports.content IS 'Structured report content as JSONB (chapters/sections)';
COMMENT ON COLUMN ai_reports.kpi_snapshot IS 'KPI snapshot for list view display';
COMMENT ON COLUMN ai_reports.summary_line IS 'One-line summary for list card display';
