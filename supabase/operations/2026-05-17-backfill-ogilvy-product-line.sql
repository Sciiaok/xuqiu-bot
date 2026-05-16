-- ============================================================================
-- Ogilvy 历史会话 + LLM 调用按产品线回填
--
-- 背景: 2026-05-17 起 Ogilvy 项目按产品线绑定(autopilot_sessions.product_line),
-- 之前的会话 product_line 为 NULL。RevoPanda (tenant 00000000-...0001) 的存量
-- 项目都是整车业务,用户确认全部归到 'vehicle'。其它租户当前没有 ogilvy 数据,
-- 本脚本只处理 tenant 001;后续若有别家租户的旧数据,自行追加 WHERE 条件即可。
--
-- 安全性: 全部 UPDATE 只填 product_line IS NULL 的行,不覆盖任何已写值。
-- 幂等可重跑。
-- ============================================================================

DO $$
DECLARE
  session_count INT;
  log_count INT;
BEGIN
  -- 1. autopilot_sessions: RevoPanda 现存 ogilvy 项目 → vehicle
  UPDATE autopilot_sessions
  SET product_line = 'vehicle'
  WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
    AND product_line IS NULL
    AND deleted_at IS NULL;

  GET DIAGNOSTICS session_count = ROW_COUNT;
  RAISE NOTICE 'autopilot_sessions backfilled rows: %', session_count;

  -- 2. llm_usage_logs: 通过 session_id join autopilot_sessions 反推 product_line。
  -- session_id 是 2026-05-15 才加的列,之前的 ogilvy 调用 session_id 为 NULL,
  -- 这部分仍然回不来 —— 接受。
  UPDATE llm_usage_logs lu
  SET product_line = s.product_line
  FROM autopilot_sessions s
  WHERE lu.session_id = s.id
    AND lu.call_site LIKE 'ogilvy.%'
    AND lu.product_line IS NULL
    AND s.product_line IS NOT NULL;

  GET DIAGNOSTICS log_count = ROW_COUNT;
  RAISE NOTICE 'llm_usage_logs (ogilvy.*) backfilled rows: %', log_count;

  RAISE NOTICE 'Backfill complete. autopilot_sessions=%, llm_usage_logs=%', session_count, log_count;
END$$;

-- 验证:产品线下成本分布
SELECT
  COALESCE(product_line, '(NULL/不归属)') AS product_line,
  COUNT(*) FILTER (WHERE call_site LIKE 'ogilvy.%') AS ogilvy_rows,
  ROUND(SUM(cost_usd) FILTER (WHERE call_site LIKE 'ogilvy.%')::numeric, 4) AS ogilvy_usd,
  COUNT(*) FILTER (WHERE call_site NOT LIKE 'ogilvy.%') AS other_rows,
  ROUND(SUM(cost_usd) FILTER (WHERE call_site NOT LIKE 'ogilvy.%')::numeric, 4) AS other_usd
FROM llm_usage_logs
WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
GROUP BY product_line
ORDER BY (COALESCE(SUM(cost_usd), 0)) DESC NULLS LAST;
