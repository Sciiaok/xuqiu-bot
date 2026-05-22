-- ============================================================================
-- llm_usage_logs: 增加 error_message 列，让失败的 LLM 调用也能在 DB 里查到原因
--
-- 背景：ogilvy/creative.service.js 的 primary→fallback 路径里，primary
-- (gpt-image-2) 失败只 console.warn 不落表 —— 一旦实际生图全部走了 Gemini
-- fallback，DB 完全看不出 primary 当时报了什么错，每次都要 ssh aws-test 去
-- 翻 pm2 logs 找 "[ogilvy/creative] primary (gpt-image-2) failed: ..."。
--
-- 修法：给 llm_usage_logs 加 error_message TEXT，logLlmCall 接 errorMessage
-- 参数；caller 在失败的 catch 块里也调一次 logLlmCall(finish_reason='error',
-- errorMessage=err.message)，这样 SQL 一查就知道：哪一次 session 的 image-gen
-- 主路径挂了、挂在 401 还是 429 还是 timeout、duration_ms 多少。
-- ============================================================================

ALTER TABLE llm_usage_logs
  ADD COLUMN IF NOT EXISTS error_message TEXT;

COMMENT ON COLUMN llm_usage_logs.error_message IS
  '失败调用的 provider 错误文本（OpenAI/OpenRouter error.message 或本地 throw 的 err.message）。
   成功调用应为 NULL。配合 finish_reason=''error'' 使用，便于事后定位主路径失败原因
   而无需 ssh 看 pm2 日志。';
