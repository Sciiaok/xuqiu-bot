-- ============================================================================
-- llm_usage_logs: 增加 session_id 列 + 索引
--
-- 背景：当前 llm_usage_logs 只记 tenant_id + call_site,无法按 ogilvy / medici
-- 单个会话聚合 token 用量。前端要做 "per-session 用量统计 + context window 占用
-- 进度" 这种 Claude Code 风格的 statusline,必须先有 session_id 维度。
--
-- 维度：
--   - session_id 跨 agent 复用——ogilvy 的 sessions.id 和 medici 的
--     orchestrator_sessions.id 都是 uuid。表里不加 FK,避免和具体 agent 表
--     耦合;查询时按 (tenant_id, session_id) 过滤即可。
--   - Nullable:不属于任何 session 的调用(后台任务、批处理)仍能落表。
-- ============================================================================

ALTER TABLE llm_usage_logs
  ADD COLUMN IF NOT EXISTS session_id UUID;

CREATE INDEX IF NOT EXISTS idx_llm_usage_session_created
  ON llm_usage_logs (session_id, created_at DESC)
  WHERE session_id IS NOT NULL;

COMMENT ON COLUMN llm_usage_logs.session_id IS
  'ogilvy/medici 等 agent 的 session uuid;不属于会话的调用为 NULL';
