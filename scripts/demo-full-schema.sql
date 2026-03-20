-- =====================================================
-- Lead Engine - Full Schema + Demo Seed Data
-- Run this in Supabase SQL Editor (B database)
-- =====================================================

-- =====================================================
-- 001: Core 4-table schema
-- =====================================================

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

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  stage TEXT DEFAULT 'GREET',
  score INT DEFAULT 0,
  route TEXT,
  destination_country TEXT,
  destination_port TEXT,
  car_model TEXT,
  qty_bucket TEXT,
  buyer_type TEXT,
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

-- Realtime
ALTER TABLE messages REPLICA IDENTITY FULL;
ALTER TABLE leads REPLICA IDENTITY FULL;
ALTER TABLE conversations REPLICA IDENTITY FULL;

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE messages; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE leads; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE conversations; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================
-- 003: Batch sync schema
-- =====================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT FALSE;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS brand TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS approved_by TEXT;

CREATE INDEX IF NOT EXISTS idx_leads_approved ON leads(approved) WHERE approved = TRUE;
CREATE INDEX IF NOT EXISTS idx_leads_approved_at ON leads(approved_at);

CREATE TABLE IF NOT EXISTS lead_sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  external_id TEXT,
  external_no TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'syncing', 'success', 'failed')),
  request_payload JSONB,
  response_payload JSONB,
  error_message TEXT,
  retry_count INT DEFAULT 0,
  synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_logs_lead_id ON lead_sync_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_status ON lead_sync_logs(status);
CREATE INDEX IF NOT EXISTS idx_sync_logs_created_at ON lead_sync_logs(created_at);

ALTER TABLE lead_sync_logs REPLICA IDENTITY FULL;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE lead_sync_logs; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================
-- 004: Message queue
-- =====================================================

CREATE TABLE IF NOT EXISTS message_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  wa_id TEXT NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  wa_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  process_after TIMESTAMPTZ NOT NULL,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  processed_at TIMESTAMPTZ,
  error_message TEXT,
  retry_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_wa_message UNIQUE (wa_message_id)
);

CREATE INDEX IF NOT EXISTS idx_queue_pending ON message_queue(status, process_after) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_queue_conversation ON message_queue(conversation_id, status);

CREATE OR REPLACE FUNCTION acquire_queue_messages(
  p_conversation_id UUID,
  p_instance_id TEXT
) RETURNS SETOF message_queue AS $$
DECLARE
  has_ready BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM message_queue
    WHERE conversation_id = p_conversation_id
      AND status = 'pending'
      AND process_after <= NOW()
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ) INTO has_ready;

  IF NOT has_ready THEN RETURN; END IF;

  RETURN QUERY
  UPDATE message_queue
  SET status = 'processing', locked_at = NOW(), locked_by = p_instance_id
  WHERE id IN (
    SELECT id FROM message_queue
    WHERE conversation_id = p_conversation_id AND status = 'pending'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION release_stale_queue_locks(
  p_timeout_seconds INT DEFAULT 30
) RETURNS INT AS $$
DECLARE
  released_count INT;
BEGIN
  UPDATE message_queue
  SET status = 'pending', locked_at = NULL, locked_by = NULL
  WHERE status = 'processing'
    AND locked_at < NOW() - (p_timeout_seconds || ' seconds')::INTERVAL;
  GET DIAGNOSTICS released_count = ROW_COUNT;
  RETURN released_count;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE message_queue; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- =====================================================
-- 005: Unique active conversation per contact
-- =====================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_conversation
ON conversations (contact_id)
WHERE status = 'active';

-- =====================================================
-- 006: Multi-lead support
-- =====================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_key TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS color_quantity JSONB DEFAULT '[]';

CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_lead_key
ON leads (conversation_id, lead_key)
WHERE route = 'CONTINUE' AND lead_key IS NOT NULL;

-- =====================================================
-- 008: Multi-intent support
-- =====================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversation_intent_summary TEXT;

-- =====================================================
-- 012: Human takeover
-- =====================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS is_human_takeover BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS human_takeover_at TIMESTAMPTZ;

-- Note: skip CHECK constraint for demo (would fail on bulk insert)
-- ALTER TABLE conversations ADD CONSTRAINT check_takeover_timestamp
--   CHECK (is_human_takeover = false OR human_takeover_at IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_conversations_human_takeover
  ON conversations (human_takeover_at)
  WHERE is_human_takeover = true;

-- =====================================================
-- 013: Agents table
-- =====================================================

CREATE TABLE IF NOT EXISTS agents (
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

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id);

-- Replace old unique index to support agent-scoped conversations
DROP INDEX IF EXISTS idx_unique_active_conversation;
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_conversation
  ON conversations (contact_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'))
  WHERE status = 'active';

ALTER TABLE leads ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES agents(id);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS product_name TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS sku_description TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations (agent_id);
CREATE INDEX IF NOT EXISTS idx_leads_agent ON leads (agent_id);

-- =====================================================
-- 014: Chat media storage bucket
-- =====================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('chat-media', 'chat-media', true)
ON CONFLICT (id) DO NOTHING;

-- =====================================================
-- 015: Message queue metadata
-- =====================================================

ALTER TABLE message_queue ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- =====================================================
-- 016: Agent ad_context_map
-- =====================================================

ALTER TABLE agents ADD COLUMN IF NOT EXISTS ad_context_map JSONB NOT NULL DEFAULT '{}'::jsonb;

-- =====================================================
-- 017: Conversations wa_phone_number_id
-- =====================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS wa_phone_number_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_wa_phone_number_id
  ON conversations (wa_phone_number_id)
  WHERE wa_phone_number_id IS NOT NULL;

-- =====================================================
-- 018: Drop agents phone binding index
-- =====================================================

DROP INDEX IF EXISTS idx_agents_wa_phone_unique;

-- =====================================================
-- 2026-02-18: Inquiry quality fields
-- =====================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversation_intent TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS inquiry_quality TEXT DEFAULT 'GOOD';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS business_value TEXT DEFAULT 'LOW';

CREATE INDEX IF NOT EXISTS idx_leads_inquiry_quality ON leads(inquiry_quality);
CREATE INDEX IF NOT EXISTS idx_leads_business_value ON leads(business_value);

-- =====================================================
-- 2026-02-20: Company name + drop incoterm check
-- =====================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_incoterm_check;

-- =====================================================
-- 2026-02-20: Drop qty_bucket constraint
-- =====================================================

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_qty_bucket_check;

-- =====================================================
-- 2026-03-11: Agent qualification_config
-- =====================================================

ALTER TABLE agents ADD COLUMN IF NOT EXISTS qualification_config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- =====================================================
-- 2026-03-12: Meta ad_id attribution
-- =====================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS meta_ad_id TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS meta_ad_id TEXT;

CREATE INDEX IF NOT EXISTS idx_conversations_meta_ad_id
  ON conversations (meta_ad_id) WHERE meta_ad_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_leads_meta_ad_id
  ON leads (meta_ad_id) WHERE meta_ad_id IS NOT NULL;

-- =====================================================
-- 2026-03-12: Drop buyer_type check
-- =====================================================

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_buyer_type_check;


-- #####################################################
-- DEMO SEED DATA
-- #####################################################

-- 1. Agents
INSERT INTO agents (id, name, product_line, system_prompt, output_schema, is_active, qualification_config, ad_context_map)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Auto Parts Agent', 'auto_parts', 'You are an auto parts sales assistant.', '{}', true, '{}', '{}'),
  ('a0000000-0000-0000-0000-000000000002', 'Vehicle Agent', 'vehicle', 'You are a vehicle sales assistant.', '{}', true, '{}', '{}'),
  ('a0000000-0000-0000-0000-000000000003', 'Agri Machinery Agent', 'agri_machinery', 'You are an agricultural machinery sales assistant.', '{}', true, '{}', '{}');

-- 2. Contacts
INSERT INTO contacts (id, wa_id, name, company_name, created_at, updated_at, metadata)
VALUES
  ('c0000000-0000-0000-0000-000000000001', '971501234567', 'Ahmed Al-Rashid', 'Gulf Auto Trading LLC', NOW() - INTERVAL '15 days', NOW() - INTERVAL '1 day', '{}'),
  ('c0000000-0000-0000-0000-000000000002', '234801234567', 'Chukwu Obi', 'Lagos Motors Import', NOW() - INTERVAL '12 days', NOW() - INTERVAL '2 days', '{}'),
  ('c0000000-0000-0000-0000-000000000003', '255712345678', 'James Mwangi', 'East Africa Vehicles', NOW() - INTERVAL '10 days', NOW() - INTERVAL '3 days', '{}'),
  ('c0000000-0000-0000-0000-000000000004', '593912345678', 'Carlos Mendez', 'Mendez Auto Parts', NOW() - INTERVAL '8 days', NOW() - INTERVAL '1 day', '{}'),
  ('c0000000-0000-0000-0000-000000000005', '77071234567', 'Nursultan Abayev', 'KZ Farm Equipment', NOW() - INTERVAL '6 days', NOW() - INTERVAL '2 days', '{}'),
  ('c0000000-0000-0000-0000-000000000006', '84912345678', 'Nguyen Thanh', 'Vietnam Trade Co.', NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 day', '{}'),
  ('c0000000-0000-0000-0000-000000000007', '201012345678', 'Fatima Hassan', 'Cairo Import Export', NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 day', '{}'),
  ('c0000000-0000-0000-0000-000000000008', '998901234567', 'Dilshod Karimov', 'Tashkent Agro', NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 day', '{}');

-- 3. Conversations
INSERT INTO conversations (id, contact_id, status, last_message_at, message_count, created_at, is_human_takeover, agent_id)
VALUES
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', 'active', NOW() - INTERVAL '1 day',  12, NOW() - INTERVAL '15 days', false, 'a0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002', 'active', NOW() - INTERVAL '2 days',  8, NOW() - INTERVAL '12 days', true,  'a0000000-0000-0000-0000-000000000002'),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000003', 'active', NOW() - INTERVAL '3 days',  6, NOW() - INTERVAL '10 days', false, 'a0000000-0000-0000-0000-000000000002'),
  ('d0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000004', 'active', NOW() - INTERVAL '1 day', 15, NOW() - INTERVAL '8 days',  false, 'a0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000005', 'active', NOW() - INTERVAL '2 days', 10, NOW() - INTERVAL '6 days',  false, 'a0000000-0000-0000-0000-000000000003'),
  ('d0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000006', 'idle',   NOW() - INTERVAL '1 day',  4, NOW() - INTERVAL '5 days',  false, 'a0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000007', 'c0000000-0000-0000-0000-000000000007', 'active', NOW() - INTERVAL '1 day',  9, NOW() - INTERVAL '4 days',  false, 'a0000000-0000-0000-0000-000000000002'),
  ('d0000000-0000-0000-0000-000000000008', 'c0000000-0000-0000-0000-000000000008', 'active', NOW() - INTERVAL '1 day',  7, NOW() - INTERVAL '3 days',  false, 'a0000000-0000-0000-0000-000000000003');

-- 4. Leads
INSERT INTO leads (id, conversation_id, contact_id, route, destination_country, car_model, qty_bucket, buyer_type, timeline, handoff_summary, inquiry_quality, business_value, conversation_intent, brand, product_name, approved, approved_at, agent_id, created_at, updated_at)
VALUES
  ('e0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   'HUMAN_NOW', 'UAE', 'Toyota Hilux 2024', '20+', 'dealer', '2 weeks',
   'Large dealer in Dubai looking for bulk brake pads and filters for Toyota Hilux fleet.',
   'PROOF', 'HIGH', 'business_inquiry', 'Toyota', 'Brake Pads', true, NOW() - INTERVAL '1 day',
   'a0000000-0000-0000-0000-000000000001', NOW() - INTERVAL '14 days', NOW() - INTERVAL '1 day'),

  ('e0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000002',
   'HUMAN_NOW', 'Nigeria', 'Toyota Land Cruiser', '6-20', 'trading_org', '1 month',
   'Trading company wants 10 Land Cruisers for resale in Lagos market.',
   'QUALIFY', 'HIGH', 'business_inquiry', 'Toyota', 'Land Cruiser', false, NULL,
   'a0000000-0000-0000-0000-000000000002', NOW() - INTERVAL '11 days', NOW() - INTERVAL '2 days'),

  ('e0000000-0000-0000-0000-000000000003', 'd0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000003',
   'CONTINUE', 'Tanzania', 'Isuzu D-Max', '1-5', 'dealer', '3 months',
   NULL, 'GOOD', 'MEDIUM', 'business_inquiry', 'Isuzu', 'D-Max', false, NULL,
   'a0000000-0000-0000-0000-000000000002', NOW() - INTERVAL '9 days', NOW() - INTERVAL '3 days'),

  ('e0000000-0000-0000-0000-000000000004', 'd0000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000004',
   'HUMAN_NOW', 'Ecuador', 'Hyundai Accent', '20+', 'store_owner', '1 week',
   'Auto parts store owner needs headlights and bumpers for Hyundai Accent.',
   'PROOF', 'MEDIUM', 'business_inquiry', 'Hyundai', 'Headlights', true, NOW() - INTERVAL '1 day',
   'a0000000-0000-0000-0000-000000000001', NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day'),

  ('e0000000-0000-0000-0000-000000000005', 'd0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000005',
   'CONTINUE', 'Kazakhstan', NULL, '1-5', 'dealer', '2 months',
   NULL, 'QUALIFY', 'HIGH', 'business_inquiry', 'YTO', 'Tractor YTO-504', false, NULL,
   'a0000000-0000-0000-0000-000000000003', NOW() - INTERVAL '5 days', NOW() - INTERVAL '2 days'),

  ('e0000000-0000-0000-0000-000000000006', 'd0000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000006',
   'NURTURE', 'Vietnam', 'Honda Civic', '1-5', NULL, NULL,
   NULL, 'GOOD', 'LOW', 'price_check', 'Honda', 'Oil Filter', false, NULL,
   'a0000000-0000-0000-0000-000000000001', NOW() - INTERVAL '4 days', NOW() - INTERVAL '1 day'),

  ('e0000000-0000-0000-0000-000000000007', 'd0000000-0000-0000-0000-000000000007', 'c0000000-0000-0000-0000-000000000007',
   'HUMAN_NOW', 'Egypt', 'Changan CS75', '6-20', 'trading_org', '2 weeks',
   'Wants to import 8 Changan CS75 Plus for Egyptian market.',
   'QUALIFY', 'HIGH', 'business_inquiry', 'Changan', 'CS75 Plus', false, NULL,
   'a0000000-0000-0000-0000-000000000002', NOW() - INTERVAL '3 days', NOW() - INTERVAL '1 day'),

  ('e0000000-0000-0000-0000-000000000008', 'd0000000-0000-0000-0000-000000000008', 'c0000000-0000-0000-0000-000000000008',
   'CONTINUE', 'Uzbekistan', NULL, '6-20', 'dealer', '1 month',
   NULL, 'QUALIFY', 'MEDIUM', 'business_inquiry', 'Lovol', 'Harvester', false, NULL,
   'a0000000-0000-0000-0000-000000000003', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day');

-- 5. Messages
INSERT INTO messages (conversation_id, role, content, sent_at, sent_by)
VALUES
  ('d0000000-0000-0000-0000-000000000001', 'user',      'Hi, I need brake pads for Toyota Hilux 2024 model.',                NOW() - INTERVAL '15 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000001', 'assistant',  'Hello Ahmed! Welcome. I can help you with Toyota Hilux brake pads. Could you tell me the quantity you need and your delivery location?', NOW() - INTERVAL '15 days' + INTERVAL '30 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000001', 'user',      'I need 500 sets, delivery to Dubai. We are a dealer.',              NOW() - INTERVAL '14 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000001', 'assistant',  'Great! 500 sets of brake pads for Toyota Hilux 2024, delivered to Dubai. Let me connect you with our sales team for pricing on this bulk order.', NOW() - INTERVAL '14 days' + INTERVAL '25 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000001', 'user',      'Also need oil filters, same quantity.',                              NOW() - INTERVAL '13 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000001', 'assistant',  'Noted! Adding 500 oil filters to your inquiry. Our team will prepare a combined quotation for you.', NOW() - INTERVAL '13 days' + INTERVAL '20 seconds', 'bot'),

  ('d0000000-0000-0000-0000-000000000002', 'user',      'Good day. We want to buy Toyota Land Cruiser for Nigeria.',          NOW() - INTERVAL '12 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000002', 'assistant',  'Hello! Thank you for your interest in Toyota Land Cruiser. How many units are you looking for, and what specifications do you need?', NOW() - INTERVAL '12 days' + INTERVAL '28 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000002', 'user',      'We need 10 units, 2024 model, diesel engine. FOB Shanghai.',         NOW() - INTERVAL '11 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000002', 'assistant',  'Understood - 10 Toyota Land Cruiser 2024 diesel units, FOB Shanghai to Nigeria. Let me transfer you to our vehicle specialist.', NOW() - INTERVAL '11 days' + INTERVAL '22 seconds', 'bot'),

  ('d0000000-0000-0000-0000-000000000004', 'user',      'Necesito luces y bumpers para Hyundai Accent.',                     NOW() - INTERVAL '8 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000004', 'assistant',  'Hola Carlos! I can help with Hyundai Accent parts. What year model, and how many sets do you need?', NOW() - INTERVAL '8 days' + INTERVAL '30 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000004', 'user',      '2020-2023 model, 100 sets of headlights and 50 front bumpers.',      NOW() - INTERVAL '7 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000004', 'assistant',  'Got it! 100 headlight sets and 50 front bumpers for Hyundai Accent 2020-2023. I will get our team to prepare pricing for you.', NOW() - INTERVAL '7 days' + INTERVAL '25 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000004', 'user',      'CIF Guayaquil please.',                                             NOW() - INTERVAL '6 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000004', 'assistant',  'CIF Guayaquil noted. Our team will include shipping costs in the quotation.', NOW() - INTERVAL '6 days' + INTERVAL '20 seconds', 'bot'),

  ('d0000000-0000-0000-0000-000000000005', 'user',      'I am interested in YTO tractor for my farm equipment dealership.',   NOW() - INTERVAL '6 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000005', 'assistant',  'Hello Nursultan! Great to hear your interest in YTO tractors. Which model are you looking for, and how many units?', NOW() - INTERVAL '6 days' + INTERVAL '35 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000005', 'user',      'YTO-504 model, 3 units first as trial order.',                       NOW() - INTERVAL '5 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000005', 'assistant',  'YTO-504, 3 units as a trial order to Kazakhstan. Could you share your preferred delivery terms and timeline?', NOW() - INTERVAL '5 days' + INTERVAL '25 seconds', 'bot'),

  ('d0000000-0000-0000-0000-000000000007', 'user',      'We want Changan CS75 Plus for Egypt. Can you give price?',           NOW() - INTERVAL '4 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000007', 'assistant',  'Hello Fatima! The Changan CS75 Plus is a great choice. How many units do you need, and what is your preferred delivery term?', NOW() - INTERVAL '4 days' + INTERVAL '30 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000007', 'user',      '8 units, 2024 model, automatic. CIF Alexandria.',                    NOW() - INTERVAL '3 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000007', 'assistant',  '8 Changan CS75 Plus 2024 automatic, CIF Alexandria. Let me connect you with our vehicle team for a detailed quotation.', NOW() - INTERVAL '3 days' + INTERVAL '25 seconds', 'bot'),

  ('d0000000-0000-0000-0000-000000000008', 'user',      'Hello, looking for Lovol harvester machines.',                        NOW() - INTERVAL '3 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000008', 'assistant',  'Hello Dilshod! We carry Lovol harvesters. Which model interests you, and how many units do you need?', NOW() - INTERVAL '3 days' + INTERVAL '32 seconds', 'bot'),
  ('d0000000-0000-0000-0000-000000000008', 'user',      'Need 8 combine harvesters for wheat. Delivery to Tashkent.',          NOW() - INTERVAL '2 days', 'customer'),
  ('d0000000-0000-0000-0000-000000000008', 'assistant',  '8 Lovol combine harvesters for wheat, delivered to Tashkent. I will check stock and pricing for you. What is your expected delivery timeline?', NOW() - INTERVAL '2 days' + INTERVAL '28 seconds', 'bot');

-- Done!
-- Set human_takeover_at for the one conversation that has is_human_takeover=true
UPDATE conversations SET human_takeover_at = NOW() - INTERVAL '2 days'
WHERE id = 'd0000000-0000-0000-0000-000000000002';
