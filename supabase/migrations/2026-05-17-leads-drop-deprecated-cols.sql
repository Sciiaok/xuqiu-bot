-- ============================================================================
-- 阶段 3：drop leads 表的 13 个 DEPRECATED 业务列
--
-- 上下文：
--   阶段 2 完成（PR 122 翻转读 + 28d025d 停止写 + 6c42b49 残留清理）：所有
--   代码路径已切到 details JSONB 读写；2026-05-17 早些时候加了 DEPRECATED
--   COMMENT；本 migration 把列从 schema physically 移除.
--
-- 安全性 checklist（已确认）:
--   - 全仓 grep 0 处代码读写这 13 列；compareLeads dead code 已删
--   - 13 列全部 nullable + 无任何 FK 引用
--   - DROP COLUMN 会自动 cascade drop 列上的索引
--     （idx_leads_destination 建在 destination_country；idx_leads_car_model
--     建在 car_model — 都跟着 drop，不需显式 DROP INDEX）
--   - 不影响 details 上的表达式索引（idx_leads_details_destination_country
--     等 4 个），它们建在 (details->>'xxx') 表达式而非列本身
--
-- 不在本 migration 范围:
--   - extra_data 列：用户决策保留，仅 DEPRECATED 标记（"代码不再读写，列保留"）
--   - approved / approved_at / approved_by：不属于线索字段通用化迁移，单独 DEPRECATED
--
-- 部署后:
--   1. 跑 `node scripts/build-index.mjs` 刷新 .claude/index/schema.md
--   2. 监测 1-2 天，确认 inquiry-dashboard / inquiries / feishu 通知 / external
--      sync / reports 导出 / AI 报表都正常（这些路径在 PR 1 已全部翻转到 details
--      读取，drop 后理论上无回归，但 dev-tools/sql 或运维脚本若手写 SELECT
--      带这些列名会立即 fail）.
-- ============================================================================

ALTER TABLE leads
  DROP COLUMN IF EXISTS brand,
  DROP COLUMN IF EXISTS car_model,
  DROP COLUMN IF EXISTS destination_country,
  DROP COLUMN IF EXISTS destination_port,
  DROP COLUMN IF EXISTS loading_port,
  DROP COLUMN IF EXISTS timeline,
  DROP COLUMN IF EXISTS company_name,
  DROP COLUMN IF EXISTS buyer_type,
  DROP COLUMN IF EXISTS qty_bucket,
  DROP COLUMN IF EXISTS product_name,
  DROP COLUMN IF EXISTS sku_description,
  DROP COLUMN IF EXISTS color_quantity,
  DROP COLUMN IF EXISTS incoterm;
