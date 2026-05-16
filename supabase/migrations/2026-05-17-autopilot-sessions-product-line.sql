-- ============================================================================
-- autopilot_sessions: 增加 product_line 列
--
-- 背景: Ogilvy 工作台从"租户级跨产品线"改成"按产品线绑定"——每个新建项目
-- 强制选择产品线,创建后锁定;后续工作流自动使用该产品线绑定的 WA 号码,
-- 不再让模型通过工具让用户重新选号码。成本归属也跟着对齐:llm-client 写入
-- llm_usage_logs 时 productLine = session.product_line。
--
-- Nullable:旧数据迁移期间允许 NULL,稍后通过 supabase/operations/2026-05-17-
-- backfill-ogilvy-product-line.sql 全量回填到 'vehicle'(RevoPanda 现存
-- session 全是整车业务,确认过),回填完成后历史 ogilvy.* 调用都能挂到正确产品线。
--
-- 不加 FK 到 product_lines:product_lines 的 PK 是 (tenant_id, id) 复合键,
-- autopilot_sessions 只引用 id slug,跟 conversations.product_line 的做法一致。
-- ============================================================================

ALTER TABLE autopilot_sessions
  ADD COLUMN IF NOT EXISTS product_line TEXT;

CREATE INDEX IF NOT EXISTS idx_autopilot_sessions_pl
  ON autopilot_sessions (tenant_id, product_line)
  WHERE deleted_at IS NULL;

COMMENT ON COLUMN autopilot_sessions.product_line IS
  '产品线 slug(对应 product_lines.id);新会话创建时强制选择,创建后不允许修改。NULL=迁移前老数据,回填脚本之后应全部非空';
