-- ============================================================================
-- llm_usage_logs: 增加 product_line 列 + 索引
--
-- 背景：成本分析要按产品线切，现有 llm_usage_logs 只有 tenant_id + session_id +
-- call_site,无法直接切到单产品线。新增 nullable text 列;新写入由 llm-client.js
-- 透传 productLine 字段（已知产品线的 call_site 才挂,比如 medici.qualify /
-- kb.search.* / contacts.profile.summary）。
--
-- Ogilvy 工作台调用（ogilvy.turn / ogilvy.web_search / ogilvy.read_webpage）刻
-- 意不归属——一次 session 可能聊多个产品,硬塞反而误导;dashboard 把这部分单列。
--
-- 老数据保持 NULL,稍后通过 supabase/operations/2026-05-16-backfill-llm-usage-product-line.sql
-- 按时间窗反推回填(整车这种长期运行的线能恢复历史成本)。
-- ============================================================================

ALTER TABLE llm_usage_logs
  ADD COLUMN IF NOT EXISTS product_line TEXT;

CREATE INDEX IF NOT EXISTS idx_llm_usage_product_line_created
  ON llm_usage_logs (tenant_id, product_line, created_at DESC)
  WHERE product_line IS NOT NULL;

COMMENT ON COLUMN llm_usage_logs.product_line IS
  '产品线 slug(对应 product_lines.id),用于成本分析按产品线聚合;不归属或租户级调用为 NULL';
