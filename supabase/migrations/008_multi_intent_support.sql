-- Migration: Support multiple conversation intents
-- Date: 2026-02-19
-- Description: Add conversation_intent_summary, allow multi-value conversation_intent

-- Add conversation_intent_summary column
ALTER TABLE leads
ADD COLUMN IF NOT EXISTS conversation_intent_summary TEXT;

-- Drop the single-value constraint on conversation_intent
-- (now stores comma-separated values like "business_inquiry,business_cooperation")
ALTER TABLE leads
DROP CONSTRAINT IF EXISTS check_conversation_intent;

-- Comment on columns
COMMENT ON COLUMN leads.conversation_intent IS 'Customer intent(s): comma-separated values (personal_consumer, business_inquiry, business_cooperation, other)';
COMMENT ON COLUMN leads.conversation_intent_summary IS 'Brief analysis of all detected intents';
