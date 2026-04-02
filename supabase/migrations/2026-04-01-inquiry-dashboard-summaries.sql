-- Migration: Create inquiry_dashboard_summaries table for AI summary cache
-- Date: 2026-04-01

CREATE TABLE inquiry_dashboard_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_lines TEXT NOT NULL,       -- sorted comma-separated: "agri_machinery,auto_parts,vehicle"
  period_key TEXT NOT NULL,          -- "7d" / "14d" / "30d" / "custom:2026-03-25:2026-04-01"
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  content TEXT NOT NULL,             -- AI-generated Markdown summary
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX idx_inquiry_summary_lookup
  ON inquiry_dashboard_summaries (product_lines, period_key);
