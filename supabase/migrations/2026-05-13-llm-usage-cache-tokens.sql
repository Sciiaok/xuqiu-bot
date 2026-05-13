-- ============================================================================
-- llm_usage_logs: 增加 prompt cache token 字段
--
-- 背景：Anthropic prompt caching 命中后 prompt_tokens 会被 OpenRouter 拆成三段：
--   - prompt_tokens                   常规未缓存输入
--   - cache_creation_input_tokens    本次写入 cache 的 token (1.25× 价)
--   - cache_read_input_tokens        命中 cache 读到的 token  (0.1×  价)
-- 旧表只记 prompt_tokens（含全部三段），看不出 cache 命中率，也算不准成本。
--
-- 这两列允许后续在看板里把"未缓存输入 / 缓存写入 / 缓存命中"分开展示，
-- 并据此校准 cost_usd 计算（pricing 表同步加 cache_creation/cache_read 价位）。
-- ============================================================================

ALTER TABLE llm_usage_logs
  ADD COLUMN IF NOT EXISTS cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN llm_usage_logs.cache_creation_input_tokens IS
  'Anthropic prompt-caching 本次写入 cache 的 token 数 (计费 1.25× 输入价)';
COMMENT ON COLUMN llm_usage_logs.cache_read_input_tokens IS
  'Anthropic prompt-caching 本次命中 cache 读取的 token 数 (计费 0.1× 输入价)';
