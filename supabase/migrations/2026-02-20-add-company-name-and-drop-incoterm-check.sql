-- Migration: remove incoterm check constraint and add company_name to leads
-- Date: 2026-02-20

-- 1) Add company_name column for lead-level company capture
ALTER TABLE leads
ADD COLUMN IF NOT EXISTS company_name TEXT;

-- 2) Remove incoterm CHECK to allow comma-separated multi-values
ALTER TABLE leads
DROP CONSTRAINT IF EXISTS leads_incoterm_check;

COMMENT ON COLUMN leads.company_name IS 'Company name extracted at lead level';
