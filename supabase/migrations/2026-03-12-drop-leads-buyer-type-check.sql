-- Migration: remove buyer_type check constraint from leads
-- Date: 2026-03-12

ALTER TABLE leads
DROP CONSTRAINT IF EXISTS leads_buyer_type_check;
