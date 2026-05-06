-- ============================================================================
-- KB Wave 2/3 follow-up — 关掉新建表的 RLS
--
-- 现象：CREATE TABLE ... 在该 Supabase 实例上默认会启用 RLS（项目级默认），
-- 没有 policy 时所有写入被 42501 拒绝。本仓库 V1 隔离全靠 server-side
-- .eq('tenant_id', ...) 显式过滤（参见 2026-04-26-multi-tenant-disable-rls-
-- on-new-tables.sql 的解释），所以这 3 张表统一关 RLS 与现状一致。
-- ============================================================================

ALTER TABLE public.kb_pending_review DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_qa_snippets    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.kb_corrections    DISABLE ROW LEVEL SECURITY;
