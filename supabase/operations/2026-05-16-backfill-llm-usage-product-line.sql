-- ============================================================================
-- llm_usage_logs.product_line 历史回填
--
-- 背景: 2026-05-16 给 llm_usage_logs 加了 product_line 列(参见
-- supabase/migrations/2026-05-16-llm-usage-product-line.sql),新写入由 llm-client.js
-- 透传。本脚本对已存在的老行做"时间窗反推",尽可能恢复历史归属。
--
-- 用法: 在 Supabase SQL Editor 里整体执行;每条 UPDATE 自带 RETURNING COUNT 写法,
-- 跑完后 NOTICE 会打印命中行数。Dry-run 在 supabase/migrations 之前已做(2026-05-16),
-- 实测覆盖率有限,详见下方"已知限制"。
--
-- 安全性: 全部 UPDATE 只填 product_line IS NULL 的行,不会覆盖任何已写入数据。
-- forward-compatible,可重复执行。
--
-- ── 已知限制(重要) ──────────────────────────────────────────────────────────
--   * medici.qualify (历史 1156 行,共 ~$73): dry-run 仅 ~3% 可反推。原因:
--       绝大多数历史 medici 调用来自 medici-simulator 的 dev 测试,而 simulator
--       不写 messages 表;真实对话触发的调用又因 queue lag / 重试,跟 messages.sent_at
--       的时间窗匹配率偏低。整车的早期历史成本基本拿不回来,接受。
--   * kb.upload.* (历史 128 行,共 ~$18): dry-run ~23% 可反推。kb_documents
--       的 created_at 与 upload 流水的 LLM 调用之间存在分钟级到小时级延迟,
--       超出合理窗口的关联视为不可信,留 NULL。
--   * 其它 call_site (kb.search.*, kb_asset_linker, knowledge.teach.extract,
--       contacts.profile.summary, report-generator.*): 计数太少(总成本 < $0.5),
--       不做反推。
--
-- 推荐: 跑完脚本看 NOTICE 给出的命中数,如果觉得回填的样本不具代表性,直接
-- DROP COLUMN 重新建空列也可(不影响新数据流)。
-- ============================================================================

DO $$
DECLARE
  medici_count INT;
  kb_upload_count INT;
BEGIN
  -- ── 1. medici.qualify ────────────────────────────────────────────────────
  -- 反推路径: 本次调用前 60s 内的 user 消息 → conversation → product_line。
  -- 窗口设小一点是为了过掉前后无关的对话(队列里可能并发处理多个 line)。
  WITH resolved AS (
    SELECT
      u.id,
      (
        SELECT c.product_line
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.tenant_id = u.tenant_id
          AND m.role = 'user'
          AND m.sent_at BETWEEN u.created_at - INTERVAL '60 seconds'
                            AND u.created_at + INTERVAL '2 seconds'
        ORDER BY ABS(EXTRACT(EPOCH FROM (u.created_at - m.sent_at)))
        LIMIT 1
      ) AS pl
    FROM llm_usage_logs u
    WHERE u.call_site = 'medici.qualify'
      AND u.product_line IS NULL
  )
  UPDATE llm_usage_logs lu
  SET product_line = r.pl
  FROM resolved r
  WHERE lu.id = r.id
    AND r.pl IS NOT NULL;

  GET DIAGNOSTICS medici_count = ROW_COUNT;
  RAISE NOTICE 'medici.qualify backfilled rows: %', medici_count;

  -- ── 2. kb.upload.* (extract-points / extract-products / extract-shipping) ──
  -- 反推路径: 本次调用前 4 小时内创建的 kb_documents 最近的一条 → product_line_id。
  -- 窗口偏宽,Excel 大文件 chunked 抽取可能跨多个小时。
  WITH resolved AS (
    SELECT
      u.id,
      (
        SELECT k.product_line_id
        FROM kb_documents k
        WHERE k.tenant_id = u.tenant_id
          AND k.created_at BETWEEN u.created_at - INTERVAL '4 hours'
                              AND u.created_at + INTERVAL '30 minutes'
        ORDER BY ABS(EXTRACT(EPOCH FROM (u.created_at - k.created_at)))
        LIMIT 1
      ) AS pl
    FROM llm_usage_logs u
    WHERE u.call_site LIKE 'kb.upload.%'
      AND u.product_line IS NULL
  )
  UPDATE llm_usage_logs lu
  SET product_line = r.pl
  FROM resolved r
  WHERE lu.id = r.id
    AND r.pl IS NOT NULL;

  GET DIAGNOSTICS kb_upload_count = ROW_COUNT;
  RAISE NOTICE 'kb.upload.* backfilled rows: %', kb_upload_count;

  -- ── 总结 ─────────────────────────────────────────────────────────────────
  RAISE NOTICE 'Backfill complete. Total resolved: %', medici_count + kb_upload_count;
END$$;

-- 验证: 看看每条产品线现在能"看到"多少历史成本
SELECT
  COALESCE(product_line, '(NULL/不归属)') AS product_line,
  COUNT(*) AS rows,
  ROUND(SUM(cost_usd)::numeric, 4) AS cost_usd
FROM llm_usage_logs
GROUP BY product_line
ORDER BY cost_usd DESC NULLS LAST;
