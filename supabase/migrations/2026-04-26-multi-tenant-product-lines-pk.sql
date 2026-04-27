-- ============================================================================
-- 多租户改造 · product_lines PK 改成 (tenant_id, id) 复合
--
-- 现状：product_lines.id 是用户起的 slug（"vehicle" / "agri_machinery"），并且
-- 当作全局 PRIMARY KEY。第二个 tenant 想建一个同名 product line 时直接 PK 冲撞。
--
-- 改法：
--   1. 把 conversations.product_line 和 leads.product_line 上的 FK 引用 drop 掉
--      —— 这两个列其实只是冗余的 slug，靠 (tenant_id, slug) 去 product_lines 反查，
--      FK 只是个 lazy enforcement，不用作真正 join。
--   2. 把 product_lines.id 上的单列 PK drop 掉，换成 (tenant_id, id) 复合 PK。
--      这样两个 tenant 各自有一个 id='vehicle' 互不冲突。
-- ============================================================================

BEGIN;

-- 1. Drop FKs that referenced product_lines(id) 单列
--    Postgres 自动命名规则：<table>_<column>_fkey
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_product_line_fkey;
ALTER TABLE leads         DROP CONSTRAINT IF EXISTS leads_product_line_fkey;

-- 2. 单列 PK → 复合 PK
ALTER TABLE product_lines DROP CONSTRAINT product_lines_pkey;
ALTER TABLE product_lines ADD PRIMARY KEY (tenant_id, id);

COMMIT;
