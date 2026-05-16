-- ============================================================================
-- 一次性回补：把 leads 表硬编码列的值同步到 details JSONB
--
-- 背景：阶段 1 已部署 ── normalizer 和 lead.repository 改成"硬编码列 + details 双写"。
-- 但历史数据里 details 不全（vehicle 产品线 868 行 details 完全为空，
-- agri_machinery 730 行 details 仅含 5 个非标 key）。本脚本把硬编码列的值
-- 合并进 details，仅在 details 缺该 key 时填充（不覆盖已有值）。
--
-- 执行前提：
--   - 阶段 1 代码（normalizer + repository）已部署。否则跑完后新写入仍可能
--     产生 details 不全的行。
--   - 跑前先执行 supabase/operations/2026-05-16-leads-storage-audit.sql
--     段 4，记录基线（dirty / col_only 等指标），跑完后比对。
--
-- 用法：在 Supabase Dashboard → SQL Editor 中按段执行。每段 BEGIN/COMMIT 独立。
-- 全部可重复执行（idempotent）：段 1 仅补缺；段 2 用 = 比较条件，已修复的行
-- 不再变更。
--
-- 字段映射（硬编码列名 → details key）：13 个业务字段。
-- 注意 incoterm → international_commercial_term 是唯一别名。
--
-- 评分类列（inquiry_quality / business_value / score / route 等）跨产品线
-- 通用，不在迁移范围；本脚本不动这些列。
-- ============================================================================


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 0：跑前快照 —— 记录待回补的行数（read-only，便于跑完后对比）          ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

SELECT
  coalesce(product_line, '(null)') AS product_line,
  count(*) AS n_total,
  count(*) FILTER (WHERE coalesce(details, '{}'::jsonb) = '{}'::jsonb) AS n_details_empty,
  count(*) FILTER (
    WHERE incoterm IS NOT NULL AND incoterm <> ''
      AND coalesce(details, '{}'::jsonb) ? 'international_commercial_term'
      AND (details ->> 'international_commercial_term') <> incoterm
  ) AS n_incoterm_dirty
FROM leads
GROUP BY product_line
ORDER BY n_total DESC;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 1：回补 details ── 把 13 个硬编码列的非空值合并进 details            ║
-- ║                                                                          ║
-- ║  策略：仅在 details 缺该 key 时补；已有值的 key 不覆盖。                  ║
-- ║  默认对所有 leads 执行（含 product_line=NULL 的 487 行历史数据）。        ║
-- ║  如不希望动 product_line=NULL 的行，把最后的 WHERE 改成：                 ║
-- ║    WHERE product_line IS NOT NULL                                        ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

UPDATE leads l
SET details = coalesce(l.details, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
  'brand',
    CASE WHEN NOT (coalesce(l.details, '{}'::jsonb) ? 'brand')
              AND l.brand IS NOT NULL AND l.brand <> ''
         THEN to_jsonb(l.brand) END,
  'car_model',
    CASE WHEN NOT (coalesce(l.details, '{}'::jsonb) ? 'car_model')
              AND l.car_model IS NOT NULL AND l.car_model <> ''
         THEN to_jsonb(l.car_model) END,
  'destination_country',
    CASE WHEN NOT (coalesce(l.details, '{}'::jsonb) ? 'destination_country')
              AND l.destination_country IS NOT NULL AND l.destination_country <> ''
         THEN to_jsonb(l.destination_country) END,
  'destination_port',
    CASE WHEN NOT (coalesce(l.details, '{}'::jsonb) ? 'destination_port')
              AND l.destination_port IS NOT NULL AND l.destination_port <> ''
         THEN to_jsonb(l.destination_port) END,
  'loading_port',
    CASE WHEN NOT (coalesce(l.details, '{}'::jsonb) ? 'loading_port')
              AND l.loading_port IS NOT NULL AND l.loading_port <> ''
         THEN to_jsonb(l.loading_port) END,
  'timeline',
    CASE WHEN NOT (coalesce(l.details, '{}'::jsonb) ? 'timeline')
              AND l.timeline IS NOT NULL AND l.timeline <> ''
         THEN to_jsonb(l.timeline) END,
  'company_name',
    CASE WHEN NOT (coalesce(l.details, '{}'::jsonb) ? 'company_name')
              AND l.company_name IS NOT NULL AND l.company_name <> ''
         THEN to_jsonb(l.company_name) END,
  'buyer_type',
    CASE WHEN NOT (coalesce(l.details, '{}'::jsonb) ? 'buyer_type')
              AND l.buyer_type IS NOT NULL AND l.buyer_type <> ''
         THEN to_jsonb(l.buyer_type) END,
  'qty_bucket',
    CASE WHEN NOT (coalesce(l.details, '{}'::jsonb) ? 'qty_bucket')
              AND l.qty_bucket IS NOT NULL AND l.qty_bucket <> ''
         THEN to_jsonb(l.qty_bucket) END,
  'product_name',
    CASE WHEN NOT (coalesce(l.details, '{}'::jsonb) ? 'product_name')
              AND l.product_name IS NOT NULL AND l.product_name <> ''
         THEN to_jsonb(l.product_name) END,
  'sku_description',
    CASE WHEN NOT (coalesce(l.details, '{}'::jsonb) ? 'sku_description')
              AND l.sku_description IS NOT NULL AND l.sku_description <> ''
         THEN to_jsonb(l.sku_description) END,
  'color_quantity',
    CASE WHEN NOT (coalesce(l.details, '{}'::jsonb) ? 'color_quantity')
              AND l.color_quantity IS NOT NULL
              AND l.color_quantity <> '[]'::jsonb
         THEN l.color_quantity END,
  'international_commercial_term',
    CASE WHEN NOT (coalesce(l.details, '{}'::jsonb) ? 'international_commercial_term')
              AND l.incoterm IS NOT NULL AND l.incoterm <> ''
         THEN to_jsonb(l.incoterm) END
))
WHERE TRUE;  -- 改成 product_line IS NOT NULL 可跳过 487 行 NULL 历史数据

COMMIT;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 2：清理 incoterm 脏数据 ── 32 行 details 与列不一致                  ║
-- ║                                                                          ║
-- ║  现状：lib/repositories/lead.repository.js 的 normalizeIncoterm 把       ║
-- ║  "FOB, CIF" 归一化为 "FOB,CIF" 写到列；但 normalizer 把原值塞进 details。 ║
-- ║  阶段 1 修了新数据；这一段处理已存在的 32 行旧数据，以列归一化值为准。    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

BEGIN;

UPDATE leads
SET details = jsonb_set(details, '{international_commercial_term}', to_jsonb(incoterm))
WHERE incoterm IS NOT NULL
  AND incoterm <> ''
  AND coalesce(details, '{}'::jsonb) ? 'international_commercial_term'
  AND (details ->> 'international_commercial_term') <> incoterm;

COMMIT;


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 3：post-check ── 验证回补效果                                        ║
-- ║                                                                          ║
-- ║  期望结果：                                                              ║
-- ║    - n_incoterm_dirty = 0（脏数据清干净）                                 ║
-- ║    - 所有产品线 details 包含相应硬编码列的值（用 audit 脚本段 4 复核）    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

SELECT
  coalesce(product_line, '(null)') AS product_line,
  count(*) AS n_total,
  count(*) FILTER (WHERE coalesce(details, '{}'::jsonb) = '{}'::jsonb) AS n_details_still_empty,
  count(*) FILTER (
    WHERE incoterm IS NOT NULL AND incoterm <> ''
      AND coalesce(details, '{}'::jsonb) ? 'international_commercial_term'
      AND (details ->> 'international_commercial_term') <> incoterm
  ) AS n_incoterm_still_dirty
FROM leads
GROUP BY product_line
ORDER BY n_total DESC;

-- 跑完后建议再执行一次 supabase/operations/2026-05-16-leads-storage-audit.sql 段 4，
-- 应该看到所有产品线 col_only=0 / dirty=0、match=各列填充行数。


-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  段 4：标记 extra_data 列为 DEPRECATED                                   ║
-- ║                                                                          ║
-- ║  现状：全表 0 行非空。代码中 createLead/updateLead 仍接受 extraData      ║
-- ║  参数（接受值默认 {}），src/external-sync.service.js 用 ?. 安全读取。     ║
-- ║  阶段 3 drop 列时再彻底清理代码引用。                                    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

COMMENT ON COLUMN leads.extra_data IS
  'DEPRECATED 2026-05-16 — 全表 0 行非空，details JSONB 已取代。阶段 3 drop。';
