-- 原 updateConversationOnMessage 是 SELECT message_count → UPDATE +1，并发场景
-- （queue-processor 与 operator 通过 inbox 同时写）会丢更新。改成 SQL 单条原子
-- 自增，顺手返回新值便于调用方观测。
CREATE OR REPLACE FUNCTION increment_conversation_message_count(
  p_conversation_id UUID
) RETURNS TABLE (
  id UUID,
  message_count INTEGER,
  last_message_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  UPDATE conversations
  SET message_count = COALESCE(message_count, 0) + 1,
      last_message_at = NOW()
  WHERE conversations.id = p_conversation_id
  RETURNING conversations.id, conversations.message_count, conversations.last_message_at;
END;
$$ LANGUAGE plpgsql;
