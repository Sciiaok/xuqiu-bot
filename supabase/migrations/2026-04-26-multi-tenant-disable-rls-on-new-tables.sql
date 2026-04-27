-- ============================================================================
-- 多租户改造 · 紧急补丁：关掉 4 张新表的 RLS
--
-- 现象：用户认证后 getTenantContext 在 public.users 找不到自己的行（虽然
-- service-role 直查 SQL 能看到），且自动 bootstrap 也被拒：
--   code: '42501', message: 'new row violates row-level security policy for table "users"'
--
-- 根因：Supabase Cloud 对包含敏感名字的 public 表可能自动启用 RLS（具体行
-- 为依实例配置），但我们没声明 policy → authenticated 角色读写都被锁。
--
-- V1 隔离方式靠的是"server-side 显式 .eq('tenant_id', tenantId) 过滤" + 全
-- service-role / anon 直查，不依赖 RLS 强制隔离。所以这 4 张 admin/账号系
-- 统类的表显式 DISABLE RLS 与当前架构一致。Phase 1 收尾时如果要上 RLS 再
-- 在那一刀里把所有业务表统一开 RLS + 写 policy。
-- ============================================================================

ALTER TABLE public.tenants              DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.users                DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations          DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_progress  DISABLE ROW LEVEL SECURITY;
