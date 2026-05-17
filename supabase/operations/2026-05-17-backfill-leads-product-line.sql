-- 一次性回填：把 leads.product_line = NULL 但对应 conversation 有 product_line
-- 的行补上。**已在 2026-05-17 跑完 518 行**（vehicle 515 + agri_machinery 3）。
--
-- 起因：replaceConversationLeads 的 insert payload 一直漏 product_line 字段
-- （lib/repositories/lead.repository.js），所以从该函数引入以来的 lead 都没
-- 落产品线。fix 同步打在 lib/session.js 和该 repository 里；本 ops 只修历史
-- 数据。
--
-- 跑法：dev_exec_sql 是 READ ONLY 跑不了 UPDATE，配套脚本
-- scripts/backfill-leads-product-line.mjs 通过 PostgREST 分批 UPDATE。
--
-- 范围：~518 行。只动 product_line IS NULL 的 lead，不覆盖已有值。

UPDATE leads l
SET product_line = c.product_line
FROM conversations c
WHERE l.conversation_id = c.id
  AND l.product_line IS NULL
  AND c.product_line IS NOT NULL;
