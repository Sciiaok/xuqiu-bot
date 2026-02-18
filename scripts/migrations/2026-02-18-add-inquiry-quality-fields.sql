-- Migration: Add inquiry_quality schema fields to leads table
-- Date: 2026-02-18
-- Description: Add conversation_intent, inquiry_quality, business_value fields

-- Add new columns
ALTER TABLE leads
ADD COLUMN IF NOT EXISTS conversation_intent TEXT,
ADD COLUMN IF NOT EXISTS inquiry_quality TEXT DEFAULT 'GOOD',
ADD COLUMN IF NOT EXISTS business_value TEXT DEFAULT 'LOW';

-- Add check constraints for valid enum values
ALTER TABLE leads
ADD CONSTRAINT check_inquiry_quality
CHECK (inquiry_quality IN ('BAD', 'GOOD', 'QUALIFY', 'PROOF'));

ALTER TABLE leads
ADD CONSTRAINT check_business_value
CHECK (business_value IN ('LOW', 'AVERAGE', 'HIGH'));

ALTER TABLE leads
ADD CONSTRAINT check_conversation_intent
CHECK (conversation_intent IS NULL OR conversation_intent IN ('personal_consumer', 'business_inquiry', 'business_cooperation', 'other'));

-- Create index for filtering
CREATE INDEX IF NOT EXISTS idx_leads_inquiry_quality ON leads(inquiry_quality);
CREATE INDEX IF NOT EXISTS idx_leads_business_value ON leads(business_value);

-- Update existing leads: map stage to inquiry_quality
UPDATE leads SET inquiry_quality = 'GOOD' WHERE stage = 'GREET' AND inquiry_quality IS NULL;
UPDATE leads SET inquiry_quality = 'QUALIFY' WHERE stage = 'QUALIFY' AND inquiry_quality IS NULL;
UPDATE leads SET inquiry_quality = 'PROOF' WHERE stage = 'PROOF' AND inquiry_quality IS NULL;

-- Set default business_value based on qty_bucket for existing leads
UPDATE leads SET business_value = 'HIGH' WHERE qty_bucket = '20+' AND business_value IS NULL;
UPDATE leads SET business_value = 'AVERAGE' WHERE qty_bucket = '6-20' AND business_value IS NULL;
UPDATE leads SET business_value = 'LOW' WHERE qty_bucket = '1-5' AND business_value IS NULL;
UPDATE leads SET business_value = 'LOW' WHERE business_value IS NULL;

-- Comment on columns
COMMENT ON COLUMN leads.conversation_intent IS 'Customer intent: personal_consumer, business_inquiry, business_cooperation, other';
COMMENT ON COLUMN leads.inquiry_quality IS 'Lead qualification level: BAD, GOOD, QUALIFY, PROOF';
COMMENT ON COLUMN leads.business_value IS 'Business value assessment: LOW, AVERAGE, HIGH';
