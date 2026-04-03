-- Knowledge Base Test Chat & Coverage Tables
-- Supports AI Q&A testing, session persistence, and knowledge gap tracking

-- Test chat sessions
CREATE TABLE IF NOT EXISTS kb_test_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  title TEXT, -- auto-generated from first message
  message_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_kb_test_sessions_agent ON kb_test_sessions(agent_id, updated_at DESC);

-- Test chat messages
CREATE TABLE IF NOT EXISTS kb_test_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES kb_test_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  sources JSONB, -- KB search results used for this response
  search_meta JSONB, -- intent, rewritten query, scores, etc.
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_kb_test_messages_session ON kb_test_messages(session_id, created_at);

-- Knowledge gaps detected during test chat or production conversations
CREATE TABLE IF NOT EXISTS kb_knowledge_gaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id),
  query TEXT NOT NULL, -- the question that had no good answer
  layer TEXT, -- which layer was expected
  gap_type TEXT DEFAULT 'no_result' CHECK (gap_type IN ('no_result', 'low_confidence', 'outdated', 'conflicting')),
  occurrence_count INT DEFAULT 1,
  last_occurred_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'ignored')),
  resolved_by UUID, -- doc_id or knowledge_point_id that resolved it
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_kb_knowledge_gaps_agent ON kb_knowledge_gaps(agent_id, status, last_occurred_at DESC);
