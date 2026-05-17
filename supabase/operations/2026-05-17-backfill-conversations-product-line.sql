-- 一次性回填：conversations.product_line = NULL 但 wa_phone_number_id 能在
-- product_lines 表里查到映射的行。**已在 2026-05-17 跑完 373 行**
-- （vehicle 183 + agri_machinery 190）。
--
-- 起因：早期写入路径漏了 conversations.product_line，导致 leads.product_line
-- 回填脚本（同日另一份 ops）捞不到这部分历史。先填 conversation，再重跑 lead
-- 回填，两步合起来才把 leads.product_line 的 null 清零。
--
-- 配套脚本：scripts/backfill-conversations-product-line.mjs（PostgREST 走法，
-- 因为 dev_exec_sql 是 READ ONLY 跑不了 UPDATE）。
--
-- 跑完后剩 1 条 conversations.product_line=null —— 测试号 wa_phone_number_id
-- "123456123"，无 product_lines 映射，保留。

UPDATE conversations c
SET product_line = pl.id
FROM product_lines pl
WHERE c.wa_phone_number_id = pl.wa_phone_number_id
  AND c.product_line IS NULL;
