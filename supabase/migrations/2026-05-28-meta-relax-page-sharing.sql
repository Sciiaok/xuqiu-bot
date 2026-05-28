-- 2026-05-28: 放开 Facebook Page 跨租户共享。
--
-- 之前（同一天早些时候的 2026-05-28-meta-relax-bm-exclusivity.sql）：
-- 解锁 BM 跨租户共享时新增了 page_id 全局唯一索引，保留 page 级独占。
--
-- 新需求：多个租户可以同时绑定同一个 Facebook Page（CTWA 广告主体允许复用）。
-- WABA / phone_number_id / ad_account_id 仍然独占，本次只放开 page。
-- ============================================================================

DROP INDEX IF EXISTS idx_meta_connections_active_page_global;

NOTIFY pgrst, 'reload schema';
