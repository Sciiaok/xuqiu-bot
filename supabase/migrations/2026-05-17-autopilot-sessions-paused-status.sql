-- ═══════════════════════════════════════════════════════════════════════
-- autopilot_sessions: 增加 'paused' status
--
-- 背景：原 status 状态机是 active → staging → launched / failed。投放上线后
-- 用户没有「暂停」入口，只能去 Meta 后台改。/ogilvy 卡片新增「暂停投放」
-- 按钮，把 launched ↔ paused 做成可逆，对应 Meta 三层 ACTIVE ↔ PAUSED。
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE autopilot_sessions
  DROP CONSTRAINT IF EXISTS autopilot_sessions_status_check;

ALTER TABLE autopilot_sessions
  ADD CONSTRAINT autopilot_sessions_status_check
  CHECK (status IN ('active', 'staging', 'launched', 'paused', 'failed', 'archived'));
