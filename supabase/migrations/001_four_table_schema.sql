-- =====================================================
-- Lead Engine Database Redesign
-- 4-Table Separation: contacts → conversations → messages / leads
-- Run in Supabase SQL Editor
-- =====================================================

-- 1. Contacts
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_id TEXT UNIQUE NOT NULL,
  name TEXT,
  company_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_wa_id ON contacts(wa_id);

-- 2. Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'idle', 'closed')),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  message_count INT DEFAULT 0,
  closed_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversations_contact_id ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at);

-- 3. Messages
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  score_delta INT DEFAULT 0,
  risk_flags TEXT[] DEFAULT '{}',
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  sent_by TEXT CHECK (sent_by IN ('customer', 'bot', 'operator')),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at);

-- 4. Leads
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  stage TEXT DEFAULT 'GREET' CHECK (stage IN ('GREET', 'QUALIFY', 'PROOF')),
  score INT DEFAULT 0,
  route TEXT CHECK (route IN ('CONTINUE', 'HUMAN_NOW', 'NURTURE', 'FAQ_END')),
  destination_country TEXT,
  destination_port TEXT,
  car_model TEXT,
  qty_bucket TEXT CHECK (qty_bucket IN ('1-5', '6-20', '20+')),
  buyer_type TEXT CHECK (buyer_type IN ('dealer', 'store_owner', 'trading_org')),
  timeline TEXT,
  incoterm TEXT,
  loading_port TEXT,
  extra_data JSONB DEFAULT '{}',
  handoff_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_conversation_id ON leads(conversation_id);
CREATE INDEX IF NOT EXISTS idx_leads_contact_id ON leads(contact_id);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score);
CREATE INDEX IF NOT EXISTS idx_leads_destination ON leads(destination_country);
CREATE INDEX IF NOT EXISTS idx_leads_car_model ON leads(car_model);

-- =====================================================
-- Realtime Setup
-- =====================================================

ALTER TABLE messages REPLICA IDENTITY FULL;
ALTER TABLE leads REPLICA IDENTITY FULL;
ALTER TABLE conversations REPLICA IDENTITY FULL;

-- Add to realtime publication (ignore error if already exists)
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE messages;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE leads;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE conversations;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- =====================================================
-- Verification Queries (run after migration)
-- =====================================================

-- Check tables created:
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
-- AND table_name IN ('contacts', 'conversations', 'messages', 'leads');

-- Check realtime enabled:
-- SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
