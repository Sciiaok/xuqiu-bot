-- RPC function: aggregate conversation stats per ad with QUALIFY/PROOF from leads
-- Replaces multiple paginated queries + JS-side aggregation in /api/ads

CREATE OR REPLACE FUNCTION ad_conversation_stats(
  from_ts timestamptz,
  to_ts   timestamptz
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
    WHERE c.meta_ad_id IS NOT NULL
      AND c.created_at >= from_ts
      AND c.created_at <= to_ts
  ),
  lead_quality AS (
    SELECT DISTINCT
      l.conversation_id,
      upper(l.inquiry_quality) AS quality
    FROM leads l
    INNER JOIN conv c ON c.id = l.conversation_id
    WHERE l.inquiry_quality IS NOT NULL
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
