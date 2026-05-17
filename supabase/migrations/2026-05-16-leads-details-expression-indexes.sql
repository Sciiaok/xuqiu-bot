-- ============================================================================
-- 阶段 2 准备：为 leads.details 顶层 key 建 BTREE 表达式索引
--
-- 上下文：阶段 1 完成后 details 已与硬编码业务列同源。阶段 2 把所有读取路径
-- 从硬编码列翻转到 details。inquiries API 和 inquiry-dashboard 之前依赖
-- idx_leads_destination / idx_leads_car_model（普通 BTREE）做 .eq filter；
-- 翻转读后这些索引就用不上了，必须建 (details->>'xxx') 表达式索引兜底，
-- 否则会全表扫。
--
-- 选 BTREE 不选 GIN：所有目标查询都是 = 等值匹配，BTREE 比 GIN 更小更快；
-- GIN 适合 ?, @>, ?| 这类 jsonb 包含查询。
--
-- 现有 idx_leads_destination / idx_leads_car_model 暂时保留 ── 阶段 3
-- drop 硬编码列时会一并失效。
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_leads_details_destination_country
  ON leads ((details->>'destination_country'));

CREATE INDEX IF NOT EXISTS idx_leads_details_car_model
  ON leads ((details->>'car_model'));

CREATE INDEX IF NOT EXISTS idx_leads_details_brand
  ON leads ((details->>'brand'));

CREATE INDEX IF NOT EXISTS idx_leads_details_buyer_type
  ON leads ((details->>'buyer_type'));
