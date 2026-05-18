-- Fix increment_conversation_message_count: 原版 SET message_count = COALESCE(message_count, 0) + 1
-- 里的 message_count 引用是歧义的 —— RETURNS TABLE 里也声明了同名 column,plpgsql
-- 解析器分不清是函数局部还是 conversations.message_count,运行时报：
--   "column reference \"message_count\" is ambiguous"
-- queue-processor 走 takeover / faq_ended / 正常路径都会撞,导致 persistMessagesOnly
-- 报 partial_persist_failed,inbox 看不到客户消息。
--
-- 修法：UPDATE 内引用全部用 conversations.<col> 限定。CREATE OR REPLACE 同名函数,
-- 不动签名,所有 caller 不用改。
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
  SET message_count = COALESCE(conversations.message_count, 0) + 1,
      last_message_at = NOW()
  WHERE conversations.id = p_conversation_id
  RETURNING conversations.id, conversations.message_count, conversations.last_message_at;
END;
$$ LANGUAGE plpgsql;
