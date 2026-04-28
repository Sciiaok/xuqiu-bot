-- ============================================================================
-- dev_exec_sql：加 10s statement_timeout
--
-- 跟前端 UI 上标注的 "10s 超时" 对齐。原函数只挡了写操作（READ ONLY），
-- 慢查询会一直占着连接 —— 加事务级 statement_timeout 兜底。
-- ============================================================================

CREATE OR REPLACE FUNCTION dev_exec_sql(query text)
RETURNS SETOF jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  SET LOCAL TRANSACTION READ ONLY;
  SET LOCAL statement_timeout = '10s';
  RETURN QUERY EXECUTE format('SELECT row_to_json(t)::jsonb FROM (%s) t', query);
END;
$$;

NOTIFY pgrst, 'reload schema';
