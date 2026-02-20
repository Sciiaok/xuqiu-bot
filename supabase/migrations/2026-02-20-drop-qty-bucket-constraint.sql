-- Drop qty_bucket check constraint to allow flexible values
-- Previously only allowed: '1-5', '6-20', '20+'
-- Now allows any string like "10", "10-15", etc.

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_qty_bucket_check;
