-- Sessions table for lead_engine WhatsApp bot
-- Run this in Supabase SQL Editor

CREATE TABLE IF NOT EXISTS sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  wa_id TEXT UNIQUE NOT NULL,
  messages JSONB DEFAULT '[]'::jsonb,
  stage TEXT DEFAULT 'GREET' CHECK (stage IN ('GREET', 'QUALIFY', 'PROOF')),
  stage_turn_count INTEGER DEFAULT 0,
  score INTEGER DEFAULT 0,
  score_history JSONB DEFAULT '[]'::jsonb,
  risk_flags JSONB DEFAULT '[]'::jsonb,
  lead_data JSONB DEFAULT '{
    "destination_country": "",
    "destination_port": "",
    "qty_bucket": "",
    "car_model": "",
    "company_name": "",
    "loading_port": "",
    "buyer_type": "",
    "timeline": "",
    "budget_indication": "",
    "international_commercial_term": ""
  }'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index on wa_id for fast lookups
CREATE INDEX IF NOT EXISTS idx_sessions_wa_id ON sessions(wa_id);

-- Index on stage for filtering
CREATE INDEX IF NOT EXISTS idx_sessions_stage ON sessions(stage);

-- Index on score for lead scoring queries
CREATE INDEX IF NOT EXISTS idx_sessions_score ON sessions(score);

-- Enable Row Level Security (optional - adjust as needed)
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

-- Policy to allow all operations (adjust for production)
CREATE POLICY "Allow all operations on sessions" ON sessions
  FOR ALL
  USING (true)
  WITH CHECK (true);
