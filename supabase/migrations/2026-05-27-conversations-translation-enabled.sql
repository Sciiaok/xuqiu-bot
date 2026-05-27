-- 2026-05-27: 询盘对话面板「翻译为中文」会话级开关。
--
-- 当 translation_enabled=true：
--   1. 打开该会话时，前端调用 /api/conversations/[id]/translate 把已存在的非中文
--      消息批量翻译一次（结果写入 messages.metadata.translation.zh）；
--   2. 之后该会话所有新消息入库时，createMessage 自动触发 fire-and-forget
--      翻译，避免操作员看到一段时间的纯外文。
-- 当 translation_enabled=false：UI 不展示翻译，已落库的 metadata.translation
--   保留（不删除），方便用户再次开启时秒亮。
--
-- 翻译结果的存储仍走现有 messages.metadata JSONB（无需 schema 变更），保证翻
-- 译过的消息永不重复消耗 LLM。
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS translation_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN conversations.translation_enabled IS
  '会话级翻译开关。true 时新消息自动触发翻译，写入 messages.metadata.translation.zh。';
