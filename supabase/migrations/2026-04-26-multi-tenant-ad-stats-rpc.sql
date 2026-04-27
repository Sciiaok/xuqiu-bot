-- ============================================================================
-- 多租户改造 · ad_conversation_stats RPC 加 tenant_id 参数
--
-- 原 RPC 全量扫 conversations / leads，没有 tenant 维度。多租户后必须按调用方
-- 的 tenant_id 过滤，否则租户 A 能看到租户 B 的广告归因数据。
-- ============================================================================

DROP FUNCTION IF EXISTS ad_conversation_stats(timestamptz, timestamptz);

CREATE OR REPLACE FUNCTION ad_conversation_stats(
  p_tenant_id uuid,
  from_ts     timestamptz,
  to_ts       timestamptz
)
RETURNS TABLE (
  meta_ad_id         text,
  conversation_count bigint,
  qualify_count      bigint,
  proof_count        bigint,
  last_conversation  timestamptz,
  daily_counts       jsonb
)
LANGUAGE sql STABLE
AS $$
  WITH conv AS (
    SELECT
      c.id,
      c.meta_ad_id,
      c.created_at,
      (c.created_at AT TIME ZONE 'UTC')::date AS day
    FROM conversations c
    WHERE c.tenant_id = p_tenant_id
      AND c.meta_ad_id IS NOT NULL
      AND c.created_at >= from_ts
      AND c.created_at <= to_ts
  ),
  lead_quality AS (
    SELECT DISTINCT
      l.conversation_id,
      upper(l.inquiry_quality) AS quality
    FROM leads l
    INNER JOIN conv c ON c.id = l.conversation_id
    WHERE l.tenant_id = p_tenant_id
      AND l.inquiry_quality IS NOT NULL
  ),
  daily AS (
    SELECT
      c.meta_ad_id,
      c.day,
      count(*) AS cnt
    FROM conv c
    GROUP BY c.meta_ad_id, c.day
  )
  SELECT
    c.meta_ad_id::text,
    count(DISTINCT c.id)                                              AS conversation_count,
    count(DISTINCT CASE WHEN lq.quality = 'QUALIFY' THEN c.id END)    AS qualify_count,
    count(DISTINCT CASE WHEN lq.quality = 'PROOF'   THEN c.id END)    AS proof_count,
    max(c.created_at)                                                  AS last_conversation,
    (
      SELECT jsonb_agg(jsonb_build_object('date', d.day, 'count', d.cnt) ORDER BY d.day)
      FROM daily d
      WHERE d.meta_ad_id = c.meta_ad_id
    )                                                                  AS daily_counts
  FROM conv c
  LEFT JOIN lead_quality lq ON lq.conversation_id = c.id
  GROUP BY c.meta_ad_id;
$$;
