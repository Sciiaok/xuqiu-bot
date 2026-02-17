-- Message Queue table for aggregating rapid messages
-- Implements time-window aggregation with distributed locking

CREATE TABLE message_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  wa_id TEXT NOT NULL,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text', -- text/audio
  wa_message_id TEXT, -- WhatsApp message ID for deduplication

  -- Queue status
  status TEXT NOT NULL DEFAULT 'pending', -- pending/processing/completed/failed
  process_after TIMESTAMPTZ NOT NULL, -- When to start processing
  locked_at TIMESTAMPTZ, -- Lock timestamp
  locked_by TEXT, -- Lock owner (instance ID)

  -- Processing results
  processed_at TIMESTAMPTZ,
  error_message TEXT,
  retry_count INT DEFAULT 0,

  created_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT unique_wa_message UNIQUE (wa_message_id)
);

-- Index for finding pending messages ready for processing
CREATE INDEX idx_queue_pending ON message_queue(status, process_after)
  WHERE status = 'pending';

-- Index for finding messages by conversation
CREATE INDEX idx_queue_conversation ON message_queue(conversation_id, status);

-- Function to acquire and lock pending messages for a conversation
-- Uses SELECT FOR UPDATE SKIP LOCKED for distributed safety
-- Key logic: Only triggers if at least one message has expired (process_after <= NOW),
-- but then locks ALL pending messages for that conversation to maximize aggregation
CREATE OR REPLACE FUNCTION acquire_queue_messages(
  p_conversation_id UUID,
  p_instance_id TEXT
) RETURNS SETOF message_queue AS $$
DECLARE
  has_ready BOOLEAN;
BEGIN
  -- First check if there's at least one message ready to process
  SELECT EXISTS (
    SELECT 1 FROM message_queue
    WHERE conversation_id = p_conversation_id
      AND status = 'pending'
      AND process_after <= NOW()
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  ) INTO has_ready;

  -- If no ready messages, return empty (another instance may be processing)
  IF NOT has_ready THEN
    RETURN;
  END IF;

  -- Lock and return ALL pending messages for this conversation
  -- This ensures we aggregate messages that arrived during the window
  RETURN QUERY
  UPDATE message_queue
  SET status = 'processing',
      locked_at = NOW(),
      locked_by = p_instance_id
  WHERE id IN (
    SELECT id FROM message_queue
    WHERE conversation_id = p_conversation_id
      AND status = 'pending'
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql;

-- Function to release stale locks (heartbeat cleanup)
-- Call this periodically to recover from crashed instances
CREATE OR REPLACE FUNCTION release_stale_queue_locks(
  p_timeout_seconds INT DEFAULT 30
) RETURNS INT AS $$
DECLARE
  released_count INT;
BEGIN
  UPDATE message_queue
  SET status = 'pending',
      locked_at = NULL,
      locked_by = NULL
  WHERE status = 'processing'
    AND locked_at < NOW() - (p_timeout_seconds || ' seconds')::INTERVAL;

  GET DIAGNOSTICS released_count = ROW_COUNT;
  RETURN released_count;
END;
$$ LANGUAGE plpgsql;

-- Enable realtime for the queue table (optional, for monitoring)
ALTER PUBLICATION supabase_realtime ADD TABLE message_queue;
