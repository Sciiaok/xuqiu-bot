-- ============================================================================
-- 多租户改造 · 第二步：把现有 auth.users 全部归到 founder tenant
--
-- 切多租户前的一次性 bootstrap：现存所有 auth.users 默认都视为 founder tenant
-- 的成员（"first version, every enterprise = 1 person"，所以这批人都是
-- founder 团队）。后续邀请进来的新用户会在 signup flow 里自己建 tenant + user。
-- ============================================================================

INSERT INTO public.users (id, tenant_id, email, role)
SELECT
  au.id,
  '00000000-0000-0000-0000-000000000001',
  au.email,
  'owner'
FROM auth.users au
WHERE au.email IS NOT NULL
ON CONFLICT (id) DO NOTHING;
