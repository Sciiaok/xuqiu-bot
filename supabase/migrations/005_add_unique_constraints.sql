-- Add unique constraints to prevent race condition duplicates

-- 1. Leads: One lead per conversation
-- ALTER TABLE leads ADD CONSTRAINT unique_lead_per_conversation UNIQUE (conversation_id);

-- 2. Conversations: One active conversation per contact
-- Using partial unique index (PostgreSQL feature)
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_conversation
ON conversations (contact_id)
WHERE status = 'active';
