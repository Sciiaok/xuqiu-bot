-- ============================================================================
-- 一锅梭：彻底干掉 agents 表 + agent_id 列 + 5 张 dormant product_* 表
--
-- 前置：代码层已经完全切到 product_line。本 PR 同步落库。
--
-- 顺序（FK 依赖驱动）：
--   1. DROP 5 张 dormant product_* 表（≤15 行残留，零代码引用，FK → agents.id）
--   2. ai_reports: 加 product_lines TEXT[]，backfill (单 agent → ARRAY[product_line]
--      多/空 agent → '{}'); 重建唯一索引 idx_ai_reports_unique_auto 走新列；DROP agent_ids
--   3. DROP COLUMN agent_id on conversations / leads (先 DROP 视图后重建)
--   4. DROP COLUMN agent_id on kb_documents / kb_knowledge_points / kb_products
--      / kb_shipping_routes / kb_assets / kb_pricing_rules / kb_knowledge_gaps
--      / kb_glossary / kb_test_sessions（前一个 PR 已松 NOT NULL，本次彻底删列）；
--      同时干掉 kb_autofill_product_line_id() trigger（不再有 agent_id 可填）
--   5. 合并历史"同 contact 多条 active"脏行（老 unique idx 按 agent 分桶允许的）
--   6. 重建 idx_unique_active_conversation 走 (contact_id) WHERE status='active'
--   7. DROP TABLE agents
--   8. NOTIFY pgrst
--
-- 历史 agent_id / agent_ids 数据随列消失。
-- 单产品线（agents 表 product_line UNIQUE） → 1:1 映射保证 backfill 完整。
-- ============================================================================

-- ── 1. Dormant product_* 五张表 ────────────────────────────────────────────
-- FK → agents.id，必须先这些走，否则 DROP agents 时 cascade 链上挂。
DROP TABLE IF EXISTS product_doc_operations CASCADE;
DROP TABLE IF EXISTS product_embeddings CASCADE;
DROP TABLE IF EXISTS product_specs CASCADE;
DROP TABLE IF EXISTS product_documents CASCADE;
DROP TABLE IF EXISTS product_assets CASCADE;

-- 顺手清掉这些表附带的 RPC（schema.md 里有列出）
DROP FUNCTION IF EXISTS search_product_embeddings(uuid, vector, integer);
DROP FUNCTION IF EXISTS query_product_specs(uuid, text);
DROP FUNCTION IF EXISTS get_spec_fields(uuid);

-- ── 2. ai_reports: agent_ids[] → product_lines[] ────────────────────────────
ALTER TABLE ai_reports
  ADD COLUMN IF NOT EXISTS product_lines TEXT[] NOT NULL DEFAULT '{}';

-- backfill：单 agent → ARRAY[那条 agent.product_line]；多/空 agent → '{}'
UPDATE ai_reports r
   SET product_lines = ARRAY[a.product_line]
  FROM agents a
 WHERE array_length(r.agent_ids, 1) = 1
   AND r.agent_ids[1]::uuid = a.id
   AND a.product_line IS NOT NULL
   AND r.product_lines = '{}';

-- 唯一索引：自动报表（产品线为空数组）一天/一周/一月只能存一份
DROP INDEX IF EXISTS idx_ai_reports_unique_auto;
CREATE UNIQUE INDEX idx_ai_reports_unique_auto
  ON ai_reports (type, period_start, period_end)
  WHERE type IN ('daily', 'weekly', 'monthly') AND product_lines = '{}';

ALTER TABLE ai_reports DROP COLUMN IF EXISTS agent_ids;

-- ── 3. conversations / leads: 删 agent_id 列 ─────────────────────────────
-- 删列会自动连带 FK 约束和 idx_conversations_agent / idx_leads_agent。
--
-- conversations_with_resolved_route 视图 SELECT c.*，所以 DROP COLUMN 前必须
-- 先 DROP VIEW，列删完后用同样的 c.* 重建（自动跟随新 schema）。视图定义
-- 见 2026-05-16-conversations-resolved-route-view.sql。
DROP VIEW IF EXISTS conversations_with_resolved_route;

ALTER TABLE conversations DROP COLUMN IF EXISTS agent_id;
ALTER TABLE leads DROP COLUMN IF EXISTS agent_id;

CREATE OR REPLACE VIEW conversations_with_resolved_route
WITH (security_invoker = on)
AS
SELECT
  c.*,
  CASE
    WHEN c.is_human_takeover THEN 'HUMAN_NOW'
    ELSE COALESCE((
      SELECT l.route
      FROM leads l
      WHERE l.conversation_id = c.id
      ORDER BY l.updated_at DESC NULLS LAST
      LIMIT 1
    ), 'CONTINUE')
  END AS resolved_route
FROM conversations c;

GRANT SELECT ON conversations_with_resolved_route TO anon, authenticated, service_role;

-- ── 4. kb_* 表：删 agent_id 列 + 干掉 autofill trigger ──────────────────
-- trigger 先删（否则 DROP COLUMN 触发 trigger 的 reference 报错）
DO $$
DECLARE
  t TEXT;
  kb_tables CONSTANT TEXT[] := ARRAY[
    'kb_documents', 'kb_knowledge_points', 'kb_products',
    'kb_shipping_routes', 'kb_assets', 'kb_pricing_rules',
    'kb_knowledge_gaps', 'kb_glossary',
    'kb_test_sessions', 'kb_test_messages'
  ];
BEGIN
  FOREACH t IN ARRAY kb_tables LOOP
    IF to_regclass(format('public.%I', t)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_autofill_pl ON %I', t, t);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS kb_autofill_product_line_id();

-- 删 agent_id 列（连带 FK + idx_*_agent 索引）
ALTER TABLE kb_documents       DROP COLUMN IF EXISTS agent_id;
ALTER TABLE kb_knowledge_points DROP COLUMN IF EXISTS agent_id;
ALTER TABLE kb_products        DROP COLUMN IF EXISTS agent_id;
ALTER TABLE kb_shipping_routes DROP COLUMN IF EXISTS agent_id;
ALTER TABLE kb_assets          DROP COLUMN IF EXISTS agent_id;
ALTER TABLE kb_pricing_rules   DROP COLUMN IF EXISTS agent_id;
ALTER TABLE kb_knowledge_gaps  DROP COLUMN IF EXISTS agent_id;

-- dormant 的 (无代码引用,但 schema 里还在)
DO $$
BEGIN
  IF to_regclass('public.kb_glossary') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE kb_glossary DROP COLUMN IF EXISTS agent_id';
  END IF;
  IF to_regclass('public.kb_test_sessions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE kb_test_sessions DROP COLUMN IF EXISTS agent_id';
  END IF;
END $$;

-- ── 5. 合并历史"同 contact 多条 active"脏行 ────────────────────────────
-- 老 unique 索引 (contact_id, COALESCE(agent_id, 全零UUID)) 允许同 contact 在
-- 不同 agent 下各开一条 active；切到 (contact_id) WHERE status='active' 之前，
-- 必须把每个 contact 保留最新 last_message_at 的那条，其余改 idle。
-- 跑迁移前 SELECT 显示只 1 个 contact / 1 行需要处理。
UPDATE conversations c
   SET status = 'idle',
       closed_reason = 'migration_consolidation_2026-05-29',
       ended_at = COALESCE(c.ended_at, NOW())
  FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY contact_id
             ORDER BY last_message_at DESC NULLS LAST, id DESC
           ) AS rn
      FROM conversations
     WHERE status = 'active'
  ) ranked
 WHERE c.id = ranked.id
   AND ranked.rn > 1;

-- ── 6. 重建 idx_unique_active_conversation ─────────────────────────────
-- 老索引含 COALESCE(agent_id, ...)，新约束是 (contact_id) WHERE status='active'：
-- 一个 contact 只能有一条 active 对话。
DROP INDEX IF EXISTS idx_unique_active_conversation;
CREATE UNIQUE INDEX idx_unique_active_conversation
  ON conversations (contact_id)
  WHERE status = 'active';

-- ── 7. DROP agents 表 ────────────────────────────────────────────────────
DROP TABLE IF EXISTS agents CASCADE;

-- ── 8. PostgREST schema cache reload ────────────────────────────────────
NOTIFY pgrst, 'reload schema';
