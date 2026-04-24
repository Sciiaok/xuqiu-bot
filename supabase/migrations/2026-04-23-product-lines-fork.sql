-- Phase 1 of the agent -> product_lines simplification.
-- Strictly additive: creates a new product_lines table and new product_line
-- columns alongside the existing agents table and agent_id columns.
-- Nothing is renamed, dropped, or altered on the legacy side, so every
-- existing code path keeps working until later phases cut over.

BEGIN;

-- 1. New product_lines table.
--    TEXT id for self-documenting rows ('vehicle', 'auto_parts', 'agri_machinery').
--    Content slots (catalog_description / domain_glossary / lead_fields) are
--    nullable / empty and get populated in Phase 2, together with the
--    base-prompt assembly logic that consumes them.
CREATE TABLE IF NOT EXISTS product_lines (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  catalog_description   TEXT,
  domain_glossary       TEXT,
  lead_fields           JSONB NOT NULL DEFAULT '[]'::jsonb,
  wa_phone_number_id    TEXT UNIQUE,
  is_active             BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- 2. Structural backfill from agents. Content slots are intentionally left
--    at their defaults; Phase 2 populates them alongside the assembly code.
INSERT INTO product_lines (id, name, wa_phone_number_id, is_active, created_at, updated_at)
SELECT product_line, name, wa_phone_number_id, is_active, created_at, updated_at
  FROM agents
ON CONFLICT (id) DO NOTHING;

-- 3. New product_line columns on the hot-path tables. Nullable and coexisting
--    with agent_id so the legacy read/write paths are untouched.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS product_line TEXT REFERENCES product_lines(id);
ALTER TABLE leads         ADD COLUMN IF NOT EXISTS product_line TEXT REFERENCES product_lines(id);

-- 4. Backfill the new columns from the existing agent_id -> agents.product_line link.
UPDATE conversations c
   SET product_line = a.product_line
  FROM agents a
 WHERE c.agent_id = a.id
   AND c.product_line IS NULL;

UPDATE leads l
   SET product_line = a.product_line
  FROM agents a
 WHERE l.agent_id = a.id
   AND l.product_line IS NULL;

-- 5. Indexes for the lookups that later phases will rely on:
--    - conversations / leads filtering by product_line
--    - Phase 4 routing: phone_number_id -> product_line
CREATE INDEX IF NOT EXISTS idx_conversations_product_line ON conversations (product_line);
CREATE INDEX IF NOT EXISTS idx_leads_product_line         ON leads (product_line);
CREATE INDEX IF NOT EXISTS idx_product_lines_wa_phone     ON product_lines (wa_phone_number_id) WHERE wa_phone_number_id IS NOT NULL;

COMMIT;
