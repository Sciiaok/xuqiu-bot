-- 2026-05-28: 移除 conversations.translation_enabled 列。
--
-- 翻译功能改为默认全开 —— 不再由用户在 UI 端手动开/关：
--   - createMessage 落库后无条件 fire-and-forget 翻译；
--   - 是否真的调 LLM 由 shouldSkipTranslation 控制（已中文 / 附件 /
--     已缓存全自动跳过，开销和「全员一直开着」一致）；
--   - 会话首次打开时由前端调一次 /api/conversations/[id]/translate
--     做历史回填，幂等。
--
-- 该列原本只是「展示开关 + 触发闸」，是二元布尔，无历史价值，直接 drop。
ALTER TABLE conversations
  DROP COLUMN IF EXISTS translation_enabled;
