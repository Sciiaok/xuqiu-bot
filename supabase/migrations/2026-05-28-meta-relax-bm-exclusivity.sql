-- 2026-05-28: 放开 Meta BM 跨租户独占限制，同时补齐 page_id 排他保护。
--
-- 之前 BM 是「1 BM = 1 租户」全局唯一（idx_meta_connections_bm_active_global，
-- 见 2026-04-27 migration）。新需求：同一 BM 可以被多个租户连接，但 BM 下面的
-- WABA / 广告账户 / phone_number_id / page_id 仍然不能跨租户共享。
--
-- 已有的资源级排他依然有效，本次只动 BM 这一层 + 给 page_id 补上索引：
--   - meta_phone_numbers.phone_number_id  PK 全局唯一  ✓（保留）
--   - meta_phone_numbers.waba_id trigger check_waba_tenant_exclusivity()  ✓（保留）
--   - meta_ad_accounts.ad_account_id  PK 全局唯一  ✓（保留）
--   - meta_connections.metadata->>page_id  ← 本次新增 functional unique 索引
--
-- 注意：page_id 当前存在 metadata JSONB 字段里，一个 connection 1 个 page，与
-- WABA / 号码 / 广告账户 的 1:N 关系不同，所以直接用 functional unique index 即
-- 可，不需要新建独立 meta_pages 表。
-- ============================================================================

-- 1. 删 BM 全局唯一索引（解锁跨租户共享同一 BM）
DROP INDEX IF EXISTS idx_meta_connections_bm_active_global;

-- 2. 新增 page_id 全局唯一索引（仅 status=active 且 page_id 非空）
--    与 BM 老索引同样的 partial unique 思路：disconnected 行的 page_id 不挡新
--    binding；NULL page_id（用户尚未填）也不会互相冲突。
CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_connections_active_page_global
  ON meta_connections ((metadata->>'page_id'))
  WHERE status = 'active' AND (metadata->>'page_id') IS NOT NULL;

COMMENT ON INDEX idx_meta_connections_active_page_global IS
  '跨租户独占：同一时刻一个 Facebook Page ID 只能被一个租户的 active 连接绑定。';

NOTIFY pgrst, 'reload schema';
