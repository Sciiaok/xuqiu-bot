-- ============================================================================
-- 标记 leads 表 3 个系统列为 DEPRECATED：agent_id / score / lead_key
--
-- 背景：本次清理把这 3 列在代码层的所有读写路径全部摘除（全仓 grep 0 残留）。
-- 物理列暂留作 rollback safety + 备份历史数据，与 13 个业务列、approved 三联
-- 一起在阶段 3 统一 drop。
--
-- 各列退役原因 + 数据快照（截至 2026-05-18）:
--   agent_id   — 产品线归属事实真源已切到 leads.product_line。2026-04-26 后
--                停止写入；自 2026-05-17 起 0 行新写入；历史 2049/2617 行有值。
--                FK leads.agent_id → agents.id 与 idx_leads_agent 索引保留。
--   score      — 设计上的"线索评分"字段从未真正实现：全表 2617 行全为 0,
--                历史从未出现过非零值，UI 也从未展示。idx_leads_score 索引保留。
--   lead_key   — multi-lead 区分键（migration 006 引入），但 multi-lead 业务
--                场景实际走 lead.id 区分，本字段从未被生产代码写入。全表
--                2617 行中仅 2 行为非 null（疑似早期手动测试数据，最后写入
--                时间无从考证），partial unique 索引 idx_unique_lead_key 实际
--                从未真正约束过任何写入。索引保留。
--
-- 不在本 migration 范围（已在历史 migration 标注）:
--   - extra_data：PR 107 / 2026-05-16-leads-details-backfill.sql 段 4 已标
--   - approved / approved_at / approved_by：2026-05-17-deprecate-lead-sync.sql 已标
--   - 13 个业务字段：2026-05-17-leads-deprecate-hardcoded-cols.sql 已标
--
-- 阶段 3 drop 时一并处理（追加到 2026-05-17-leads-drop-deprecated-cols.sql
-- 同款 migration 或新建一个）:
--   ALTER TABLE leads
--     DROP COLUMN IF EXISTS agent_id,        -- 连带 FK + idx_leads_agent
--     DROP COLUMN IF EXISTS score,           -- 连带 idx_leads_score
--     DROP COLUMN IF EXISTS lead_key;        -- 连带 idx_unique_lead_key
-- ============================================================================

COMMENT ON COLUMN leads.agent_id IS
  'DEPRECATED 2026-05-18 — 产品线归属切到 leads.product_line；2026-04-26 后停写。阶段 3 drop（连带 FK + idx_leads_agent）。';
COMMENT ON COLUMN leads.score IS
  'DEPRECATED 2026-05-18 — 设计未落地，全表 0 值；无 UI 消费。阶段 3 drop（连带 idx_leads_score）。';
COMMENT ON COLUMN leads.lead_key IS
  'DEPRECATED 2026-05-18 — multi-lead 区分走 lead.id；本字段全表仅 2 行非 null。阶段 3 drop（连带 idx_unique_lead_key）。';
