-- Agent configuration table for multi-product-line support
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  product_line TEXT NOT NULL UNIQUE,
  system_prompt TEXT NOT NULL,
  output_schema JSONB NOT NULL,
  wa_phone_number_id TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Unique constraint: one active agent per phone number
CREATE UNIQUE INDEX idx_agents_wa_phone_unique
  ON agents (wa_phone_number_id)
  WHERE is_active = true AND wa_phone_number_id IS NOT NULL;

-- Link conversations to agents
ALTER TABLE conversations
  ADD COLUMN agent_id UUID REFERENCES agents(id);

-- Replace old unique constraint: allow same contact to have active conversations
-- on different agents (product lines)
DROP INDEX IF EXISTS idx_unique_active_conversation;
CREATE UNIQUE INDEX idx_unique_active_conversation
  ON conversations (contact_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'))
  WHERE status = 'active';

-- Link leads to agents (for filtering by product line)
ALTER TABLE leads
  ADD COLUMN agent_id UUID REFERENCES agents(id);

-- Add generic lead fields for multi-product support
ALTER TABLE leads
  ADD COLUMN product_name TEXT,
  ADD COLUMN sku_description TEXT,
  ADD COLUMN details JSONB DEFAULT '{}'::jsonb;

-- Indexes
CREATE INDEX idx_conversations_agent ON conversations (agent_id);
CREATE INDEX idx_leads_agent ON leads (agent_id);
