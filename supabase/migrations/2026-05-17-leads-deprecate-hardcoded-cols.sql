-- ============================================================================
-- 阶段 2 收尾：标记 leads 表的 13 个硬编码业务列为 DEPRECATED。
--
-- 代码已停止读写：PR 122 翻转所有读取到 details；本批改动停止 INSERT/UPDATE
-- 写硬编码列。列暂留作 rollback safety + 备份历史数据，阶段 3 一并 drop。
--
-- extra_data 列的 DEPRECATED COMMENT 在 PR 107 已加，这里不重复。
--
-- idx_leads_destination / idx_leads_car_model 两个旧 BTREE 索引也暂留 ──
-- 它们现在没人用（PR 122 翻转读后查询走 details->> 的表达式索引）但 drop
-- 安排在阶段 3，跟 drop 列一起。
-- ============================================================================

COMMENT ON COLUMN leads.brand IS
  'DEPRECATED 2026-05-17 — 业务字段已迁移到 details JSONB。阶段 3 drop。';
COMMENT ON COLUMN leads.car_model IS
  'DEPRECATED 2026-05-17 — 业务字段已迁移到 details JSONB。阶段 3 drop。';
COMMENT ON COLUMN leads.destination_country IS
  'DEPRECATED 2026-05-17 — 业务字段已迁移到 details JSONB。阶段 3 drop。';
COMMENT ON COLUMN leads.destination_port IS
  'DEPRECATED 2026-05-17 — 业务字段已迁移到 details JSONB。阶段 3 drop。';
COMMENT ON COLUMN leads.loading_port IS
  'DEPRECATED 2026-05-17 — 业务字段已迁移到 details JSONB。阶段 3 drop。';
COMMENT ON COLUMN leads.timeline IS
  'DEPRECATED 2026-05-17 — 业务字段已迁移到 details JSONB。阶段 3 drop。';
COMMENT ON COLUMN leads.company_name IS
  'DEPRECATED 2026-05-17 — 业务字段已迁移到 details JSONB。阶段 3 drop。';
COMMENT ON COLUMN leads.buyer_type IS
  'DEPRECATED 2026-05-17 — 业务字段已迁移到 details JSONB。阶段 3 drop。';
COMMENT ON COLUMN leads.qty_bucket IS
  'DEPRECATED 2026-05-17 — 业务字段已迁移到 details JSONB。阶段 3 drop。';
COMMENT ON COLUMN leads.product_name IS
  'DEPRECATED 2026-05-17 — 业务字段已迁移到 details JSONB。阶段 3 drop。';
COMMENT ON COLUMN leads.sku_description IS
  'DEPRECATED 2026-05-17 — 业务字段已迁移到 details JSONB。阶段 3 drop。';
COMMENT ON COLUMN leads.color_quantity IS
  'DEPRECATED 2026-05-17 — 业务字段已迁移到 details JSONB。阶段 3 drop。';
COMMENT ON COLUMN leads.incoterm IS
  'DEPRECATED 2026-05-17 — 业务字段已迁移到 details.international_commercial_term（注意 key 别名）。阶段 3 drop。';
