-- ============================================================================
-- 一次性诊断：审计 leads 表的"硬编码列 vs details JSONB"存储现状
--
-- 背景：
--   leads 表上同时存在 14 个硬编码业务列（brand / car_model / destination_country
--   等）和通用容器 details (jsonb)。当前抽取器写入策略：白名单命中 → 写硬编码列；
--   未命中 → 写 details。
--   规划中的迁移路径：双写双读 → 回补 details → 翻转读取 → drop 硬编码列。
--   本脚本用于在动手前摸清家底：脏数据有多少？details 已有的 key 长什么样？
--   extra_data 还有没有人用？
--
-- 用法：
--   - 在 Supabase Dashboard → SQL Editor 中按"段"分别执行（每段一个 SELECT）
--   - 也可以在应用内 /dev-tools/sql 页面执行（dev_exec_sql 仅支持单条 SELECT）
--   - 全部只读，零副作用，可重复执行
--
-- 字段映射约定（硬编码列名 → details 中期望的 key 名）：
--   绝大部分列名直接等于 lead_fields 里的 key。唯一别名：
--     leads.incoterm  ⟷  details.international_commercial_term
--   （见 lib/repositories/lead.repository.js:459 的 normalizeIncoterm 适配）
--
-- 评分类列（inquiry_quality / business_value / score / route / conversation_intent
-- 等）跨产品线通用、属于线索质量元数据，不在通用化迁移范围内，本脚本不审计。
-- ============================================================================


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 0：数据规模 —— 每个产品线的 leads 行数                                ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

SELECT
  coalesce(product_line, '(null)') AS product_line,
  count(*) AS lead_count,
  count(*) FILTER (WHERE coalesce(details, '{}'::jsonb) <> '{}'::jsonb) AS with_details,
  count(*) FILTER (WHERE coalesce(extra_data, '{}'::jsonb) <> '{}'::jsonb) AS with_extra_data
FROM leads
GROUP BY product_line
ORDER BY lead_count DESC;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 1：lead_fields 配置摘要 —— 每个产品线的字段定义                      ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

SELECT
  pl.id AS product_line,
  pl.name,
  jsonb_array_length(pl.lead_fields) AS field_count,
  (
    SELECT array_agg(f->>'key' ORDER BY ((f->>'display_order')::int) NULLS LAST)
    FROM jsonb_array_elements(pl.lead_fields) f
  ) AS field_keys
FROM product_lines pl
ORDER BY pl.id;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 2：硬编码列填充率 —— 14 个业务字段在每个产品线的非空比例              ║
-- ║                                                                          ║
-- ║  解读：填充率为 0 的列说明"该产品线压根不用这个字段"，是迁移后可下掉的    ║
-- ║  候选；填充率高的列是真正的"热字段"。                                   ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

WITH biz_cols(col) AS (VALUES
  ('brand'), ('car_model'),
  ('destination_country'), ('destination_port'), ('loading_port'),
  ('timeline'), ('company_name'),
  ('buyer_type'), ('qty_bucket'),
  ('product_name'), ('sku_description'),
  ('color_quantity'), ('incoterm')
)
SELECT
  coalesce(l.product_line, '(null)') AS product_line,
  c.col AS column_name,
  count(*) AS n_total,
  count(*) FILTER (
    WHERE (to_jsonb(l) -> c.col) IS NOT NULL
      AND (to_jsonb(l) -> c.col) <> 'null'::jsonb
      AND (to_jsonb(l) -> c.col) <> '""'::jsonb
      AND (to_jsonb(l) -> c.col) <> '[]'::jsonb
      AND (to_jsonb(l) -> c.col) <> '{}'::jsonb
  ) AS n_filled,
  round(
    100.0 * count(*) FILTER (
      WHERE (to_jsonb(l) -> c.col) IS NOT NULL
        AND (to_jsonb(l) -> c.col) <> 'null'::jsonb
        AND (to_jsonb(l) -> c.col) <> '""'::jsonb
        AND (to_jsonb(l) -> c.col) <> '[]'::jsonb
        AND (to_jsonb(l) -> c.col) <> '{}'::jsonb
    ) / nullif(count(*), 0),
    1
  ) AS pct_filled
FROM leads l
CROSS JOIN biz_cols c
GROUP BY l.product_line, c.col
ORDER BY l.product_line, c.col;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 3：details 顶层 key 出现频次（按 product_line）                       ║
-- ║                                                                          ║
-- ║  解读：看抽取器实际往 details 里塞了哪些 key，频次能反映哪些是常见自定义  ║
-- ║  字段，哪些可能是 LLM 偶发产物。                                          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

SELECT
  coalesce(l.product_line, '(null)') AS product_line,
  k AS details_key,
  count(*) AS n_occurrences
FROM leads l
CROSS JOIN LATERAL jsonb_object_keys(coalesce(l.details, '{}'::jsonb)) k
GROUP BY l.product_line, k
ORDER BY l.product_line, n_occurrences DESC;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 4：核心审计 —— 硬编码列 vs details 同名 key 的对比                    ║
-- ║                                                                          ║
-- ║  五个互斥分类（每行 leads × 每个字段 = 一次判定）：                       ║
-- ║    n_both_match  : 列和 details 都有值，且 jsonb 上 = 相等                ║
-- ║    n_both_dirty  : 列和 details 都有值，但不一致 ← 回补脚本要处理的脏数据 ║
-- ║    n_col_only    : 仅列有值（details 缺该 key）← 回补脚本要补 details     ║
-- ║    n_details_only: 仅 details 有该 key（列空）← 当前抽取器其实不会出现    ║
-- ║    n_both_empty  : 两边都空 ← 该字段对该 lead 不适用                      ║
-- ║                                                                          ║
-- ║  目标：n_both_dirty 应该是 0 或极少；n_col_only 是回补脚本的工作量。     ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

WITH field_mapping(leads_col, field_key) AS (VALUES
  ('brand', 'brand'),
  ('car_model', 'car_model'),
  ('destination_country', 'destination_country'),
  ('destination_port', 'destination_port'),
  ('loading_port', 'loading_port'),
  ('timeline', 'timeline'),
  ('company_name', 'company_name'),
  ('buyer_type', 'buyer_type'),
  ('qty_bucket', 'qty_bucket'),
  ('product_name', 'product_name'),
  ('sku_description', 'sku_description'),
  ('color_quantity', 'color_quantity'),
  ('incoterm', 'international_commercial_term')  -- 唯一别名映射
),
per_row AS (
  SELECT
    l.product_line,
    m.leads_col,
    m.field_key,
    -- jsonb 形式的列值（NULL 列会变 jsonb null）
    CASE
      WHEN (to_jsonb(l) -> m.leads_col) IS NULL THEN NULL
      WHEN (to_jsonb(l) -> m.leads_col) = 'null'::jsonb THEN NULL
      WHEN (to_jsonb(l) -> m.leads_col) = '""'::jsonb THEN NULL
      WHEN (to_jsonb(l) -> m.leads_col) = '[]'::jsonb THEN NULL
      WHEN (to_jsonb(l) -> m.leads_col) = '{}'::jsonb THEN NULL
      ELSE (to_jsonb(l) -> m.leads_col)
    END AS col_val,
    -- details 中同名 key 的值
    CASE
      WHEN NOT (coalesce(l.details, '{}'::jsonb) ? m.field_key) THEN NULL
      WHEN (l.details -> m.field_key) IS NULL THEN NULL
      WHEN (l.details -> m.field_key) = 'null'::jsonb THEN NULL
      WHEN (l.details -> m.field_key) = '""'::jsonb THEN NULL
      WHEN (l.details -> m.field_key) = '[]'::jsonb THEN NULL
      WHEN (l.details -> m.field_key) = '{}'::jsonb THEN NULL
      ELSE (l.details -> m.field_key)
    END AS details_val
  FROM leads l
  CROSS JOIN field_mapping m
)
SELECT
  coalesce(product_line, '(null)') AS product_line,
  leads_col AS column_name,
  field_key AS details_key,
  count(*) AS n_total,
  count(*) FILTER (WHERE col_val IS NOT NULL AND details_val IS NOT NULL AND col_val = details_val) AS n_both_match,
  count(*) FILTER (WHERE col_val IS NOT NULL AND details_val IS NOT NULL AND col_val <> details_val) AS n_both_dirty,
  count(*) FILTER (WHERE col_val IS NOT NULL AND details_val IS NULL) AS n_col_only,
  count(*) FILTER (WHERE col_val IS NULL AND details_val IS NOT NULL) AS n_details_only,
  count(*) FILTER (WHERE col_val IS NULL AND details_val IS NULL) AS n_both_empty
FROM per_row
GROUP BY product_line, leads_col, field_key
ORDER BY product_line, leads_col;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 4b：脏数据样本 —— 列出所有 n_both_dirty 的具体行（最多 50 行）        ║
-- ║                                                                          ║
-- ║  当段 4 显示 n_both_dirty > 0 时跑这一段，看真实差异长什么样。            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

WITH field_mapping(leads_col, field_key) AS (VALUES
  ('brand', 'brand'),
  ('car_model', 'car_model'),
  ('destination_country', 'destination_country'),
  ('destination_port', 'destination_port'),
  ('loading_port', 'loading_port'),
  ('timeline', 'timeline'),
  ('company_name', 'company_name'),
  ('buyer_type', 'buyer_type'),
  ('qty_bucket', 'qty_bucket'),
  ('product_name', 'product_name'),
  ('sku_description', 'sku_description'),
  ('color_quantity', 'color_quantity'),
  ('incoterm', 'international_commercial_term')
)
SELECT
  l.id AS lead_id,
  l.product_line,
  m.leads_col AS column_name,
  to_jsonb(l) -> m.leads_col AS column_value,
  l.details -> m.field_key AS details_value,
  l.updated_at
FROM leads l
CROSS JOIN field_mapping m
WHERE (to_jsonb(l) -> m.leads_col) IS NOT NULL
  AND (to_jsonb(l) -> m.leads_col) <> 'null'::jsonb
  AND coalesce(l.details, '{}'::jsonb) ? m.field_key
  AND (l.details -> m.field_key) IS NOT NULL
  AND (l.details -> m.field_key) <> 'null'::jsonb
  AND (to_jsonb(l) -> m.leads_col) <> (l.details -> m.field_key)
ORDER BY l.updated_at DESC
LIMIT 50;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 5：孤儿 details key —— 既不在硬编码列也不在该产品线 lead_fields 里    ║
-- ║                                                                          ║
-- ║  解读：理论上抽取器只会把"白名单外但属于 lead_fields 的字段"写进 details, ║
-- ║  所以这一查询的结果应该接近空。如果出现意外 key，说明：                   ║
-- ║   - LLM 抽出了 schema 之外的字段（应该被 normalizeAgentResponse 过滤掉）  ║
-- ║   - 历史数据有遗留（lead_fields 配置变更时旧字段没清理）                  ║
-- ║   - 我们的字段映射表漏了某些列                                            ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

WITH biz_col_keys(k) AS (VALUES
  ('brand'), ('car_model'),
  ('destination_country'), ('destination_port'), ('loading_port'),
  ('timeline'), ('company_name'),
  ('buyer_type'), ('qty_bucket'),
  ('product_name'), ('sku_description'),
  ('color_quantity'),
  ('incoterm'), ('international_commercial_term')
),
expected_per_pl AS (
  SELECT
    pl.id AS product_line_id,
    array_cat(
      ARRAY(SELECT k FROM biz_col_keys),
      coalesce(
        (SELECT array_agg(f->>'key') FROM jsonb_array_elements(pl.lead_fields) f),
        ARRAY[]::text[]
      )
    ) AS allowed_keys
  FROM product_lines pl
)
SELECT
  coalesce(l.product_line, '(null)') AS product_line,
  k AS unexpected_key,
  count(*) AS n_occurrences,
  (array_agg(l.id ORDER BY l.updated_at DESC))[1:3] AS sample_lead_ids
FROM leads l
CROSS JOIN LATERAL jsonb_object_keys(coalesce(l.details, '{}'::jsonb)) k
LEFT JOIN expected_per_pl e ON e.product_line_id = l.product_line
WHERE k <> ALL(coalesce(e.allowed_keys, ARRAY[]::text[]))
GROUP BY l.product_line, k
ORDER BY l.product_line, n_occurrences DESC;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 6：extra_data 列状态 —— 是否还有人在用这个老容器？                    ║
-- ║                                                                          ║
-- ║  当前已知：抽取器不写、UI 不读，仅 src/external-sync.service.js 读        ║
-- ║  extra_data.notes 子键。这一查询确认实际数据情况。                         ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

SELECT
  coalesce(l.product_line, '(null)') AS product_line,
  count(*) AS n_total,
  count(*) FILTER (WHERE coalesce(l.extra_data, '{}'::jsonb) <> '{}'::jsonb) AS n_extra_filled,
  count(DISTINCT k) AS n_distinct_keys,
  array_agg(DISTINCT k) FILTER (WHERE k IS NOT NULL) AS extra_data_keys
FROM leads l
LEFT JOIN LATERAL jsonb_object_keys(coalesce(l.extra_data, '{}'::jsonb)) k ON true
GROUP BY l.product_line
ORDER BY l.product_line;
