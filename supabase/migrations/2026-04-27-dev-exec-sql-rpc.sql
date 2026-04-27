-- ============================================================================
-- dev_exec_sql RPC —— founder 全库只读查询用
--
-- 路由 /api/dev-tools/sql 用 service-role 调用此函数。前端已经做了一道
-- WRITE_RE 关键字过滤，但函数自身用 SET TRANSACTION READ ONLY 兜底，
-- 确保即使绕过前端 guard 也无法写库。
--
-- 函数定义为 SECURITY DEFINER，但调用入口（路由）已限制 ctx.tenantId =
-- FOUNDER_TENANT_ID，所以只有 founder 能触达。
-- ============================================================================

CREATE OR REPLACE FUNCTION dev_exec_sql(query text)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- 强制只读，即使输入是 INSERT/UPDATE 之类也会被 Postgres 拒掉
  SET LOCAL TRANSACTION READ ONLY;
  RETURN QUERY EXECUTE format('SELECT row_to_json(t)::jsonb FROM (%s) t', query);
END;
$$;

-- 仅 service-role 可调（PostgREST 默认会暴露给所有有权 EXECUTE 的角色）
REVOKE EXECUTE ON FUNCTION dev_exec_sql(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION dev_exec_sql(text) TO service_role;

NOTIFY pgrst, 'reload schema';
