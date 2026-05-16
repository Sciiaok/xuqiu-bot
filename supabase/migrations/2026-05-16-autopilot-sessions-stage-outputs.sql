-- ============================================================================
-- autopilot_sessions: 增加 stage_outputs jsonb 列
--
-- 背景：ogilvy 长会话历史会累积到接近 200K context window 上限（实测撞过
-- 93%）。引入"长产出存档 + 历史压缩"协议（模型主动调 persist_stage_output
-- 工具把长 markdown 归档，对话历史里仅保留 200 字 summary），让会话能继续
-- 跑而不撞墙。
--
-- 设计原则：schema 不绑定 skill 阶段定义
--   - stage_outputs 是有序 jsonb 数组，每条 { id, label, summary, markdown,
--     created_at }，label 由模型自由文本生成（"阶段 3 · 10 章策划案" / "市场
--     分析 V2" / ...）
--   - 宿主代码不约束 label 取值，不维护阶段枚举。skill 改阶段名/数量/划分，
--     schema 一行不动，旧记录保留旧 label。
--
-- 命名：列名沿用 "stage_outputs"，与 host-patch 中"历史压缩协议"用语一致。
-- ============================================================================

ALTER TABLE autopilot_sessions
  ADD COLUMN IF NOT EXISTS stage_outputs JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN autopilot_sessions.stage_outputs IS
  '已存档的长产出 ordered array：[{id, label, summary, markdown, created_at}]；
   skill 阶段定义无关，由模型主动调 persist_stage_output 工具 append。';
