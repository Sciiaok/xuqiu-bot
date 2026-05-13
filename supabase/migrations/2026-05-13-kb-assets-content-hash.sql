-- kb_assets: dedup identical image bytes per document.
--
-- Why: a single document (especially xlsx with logos repeated across sheets,
-- or a PDF using the same hero image multiple times) can yield the same image
-- blob N times. Each duplicate costs a vision-caption call + storage write +
-- bloats the AVAILABLE ASSETS prompt block.
--
-- We compute SHA-256 of the raw decoded JPEG bytes before insert. If a row
-- already exists for (tenant_id, source_doc_id, content_sha256) we skip the
-- insert entirely. NULL on legacy rows is fine — the unique index treats
-- NULLs as distinct so old data isn't blocked.

ALTER TABLE kb_assets
  ADD COLUMN IF NOT EXISTS content_sha256 text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_kb_assets_doc_content
  ON kb_assets (tenant_id, source_doc_id, content_sha256)
  WHERE source_doc_id IS NOT NULL AND content_sha256 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_kb_assets_content_sha
  ON kb_assets (content_sha256)
  WHERE content_sha256 IS NOT NULL;
