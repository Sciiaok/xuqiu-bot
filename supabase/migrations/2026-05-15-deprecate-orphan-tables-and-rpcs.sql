-- ============================================================================
-- Deprecation comments for orphan tables and RPCs
--
-- Per .claude/index/tables-actual-usage.md (B + D sections), these tables and
-- functions exist in DB but have **no runtime references** in app/, lib/,
-- src/, scripts/, or proxy.js. They're remnants of past iterations:
--   * `orchestrator_*` / `campaign_*`  → superseded by autopilot_* (Ogilvy)
--   * `kb_test_*`                       → KB sandbox feature shelved
--   * `kb_glossary` / `kb_product_assets` → never wired into search / linker
--   * `fix_knowledge`                   → early auto-fix experiment
--   * `product_*`                       → pre-KB v2 (before 2026-05-08 4-layer collapse)
--   * `search_product_embeddings` / `query_product_specs` / `get_spec_fields`
--     → RPCs pointing at orphan product_* tables
--
-- Per CLAUDE.md "Forward compatibility":
--   > preserve existing data: never delete or rewrite old rows
-- This migration deliberately does NOT drop anything. It only annotates the
-- objects so:
--   1. supabase dashboard / pg_dump readers immediately see deprecation status
--   2. future contributors don't accidentally start using them
--   3. when we eventually decide to drop, the rationale is already on record
--
-- Row counts at deprecation time (2026-05-15):
--   orchestrator_messages    11 771
--   orchestrator_sessions       193
--   campaign_briefs             188
--   kb_test_messages             57
--   fix_knowledge                53
--   kb_test_sessions             19
--   product_doc_operations       15
--   campaign_messages            12
--   product_embeddings            7
--   kb_glossary                   4
--   product_documents             4
--   product_specs                 3
--   kb_product_assets             0
--   product_assets                0
-- ============================================================================

-- Pre-Ogilvy campaign-studio orchestrator (replaced by autopilot_*)
COMMENT ON TABLE campaign_briefs IS
  'DEPRECATED 2026-05-15: pre-Ogilvy campaign-studio orchestrator. Superseded by autopilot_sessions. No runtime references. 188 rows preserved for forensic inspection.';
COMMENT ON TABLE campaign_messages IS
  'DEPRECATED 2026-05-15: pre-Ogilvy campaign-studio orchestrator. Superseded by autopilot_messages. No runtime references. 12 rows preserved.';
COMMENT ON TABLE orchestrator_sessions IS
  'DEPRECATED 2026-05-15: pre-autopilot orchestrator (Ogilvy migrated to autopilot_sessions and kept the new name forward). No runtime references. 193 rows preserved.';
COMMENT ON TABLE orchestrator_messages IS
  'DEPRECATED 2026-05-15: pre-autopilot orchestrator. Superseded by autopilot_messages. No runtime references. 11,771 rows preserved.';

-- Shelved KB sandbox feature
COMMENT ON TABLE kb_test_sessions IS
  'DEPRECATED 2026-05-15: KB "test the AI with current KB" sandbox feature shelved. No runtime references. 19 rows preserved.';
COMMENT ON TABLE kb_test_messages IS
  'DEPRECATED 2026-05-15: KB sandbox feature shelved. No runtime references. 57 rows preserved.';

-- Per-tenant glossary never wired into search
COMMENT ON TABLE kb_glossary IS
  'DEPRECATED 2026-05-15: per-tenant term dictionary never wired into KB search. No runtime references. 4 rows preserved.';

-- M:N join superseded by denormalized linked_skus on kb_assets
COMMENT ON TABLE kb_product_assets IS
  'DEPRECATED 2026-05-15: M:N join table; current code denormalizes linked_skus onto kb_assets (see src/kb-asset-linker.service.js). 0 rows.';

-- Early auto-fix experiment
COMMENT ON TABLE fix_knowledge IS
  'DEPRECATED 2026-05-15: early auto-fix experiment with embeddings of error patterns. No runtime references. 53 rows preserved.';

-- Pre-KB-v2 product_* family (before 2026-05-08 4-layer collapse)
COMMENT ON TABLE product_assets IS
  'DEPRECATED 2026-05-15: pre-KB v2 product asset table. Replaced by kb_assets. 0 rows.';
COMMENT ON TABLE product_documents IS
  'DEPRECATED 2026-05-15: pre-KB v2 document table (before 4-layer collapse). Replaced by kb_documents. 4 rows preserved.';
COMMENT ON TABLE product_specs IS
  'DEPRECATED 2026-05-15: pre-KB v2 structured specs. Replaced by kb_products.specs JSONB. 3 rows preserved.';
COMMENT ON TABLE product_embeddings IS
  'DEPRECATED 2026-05-15: pre-KB v2 chunk embeddings. Replaced by kb_knowledge_points.embedding_*. 7 rows preserved.';
COMMENT ON TABLE product_doc_operations IS
  'DEPRECATED 2026-05-15: pre-KB v2 operation audit log. No runtime references. 15 rows preserved.';

-- RPCs pointing at orphan product_* tables — no callers
COMMENT ON FUNCTION search_product_embeddings(p_agent_id uuid, p_embedding vector, p_top_k integer) IS
  'DEPRECATED 2026-05-15: points at orphan product_embeddings. No callers in app/, lib/, src/, scripts/. Replaced by search_kb_knowledge_en against kb_knowledge_points.';
COMMENT ON FUNCTION query_product_specs(p_agent_id uuid, p_where_clause text) IS
  'DEPRECATED 2026-05-15: points at orphan product_specs. No callers. Replaced by direct queries against kb_products.specs JSONB.';
COMMENT ON FUNCTION get_spec_fields(p_agent_id uuid) IS
  'DEPRECATED 2026-05-15: helper for query_product_specs (orphan product_specs). No callers.';
