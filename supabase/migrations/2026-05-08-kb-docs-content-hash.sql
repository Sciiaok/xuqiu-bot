-- Add SHA-256 content hash to kb_documents for upload idempotency.
-- Same (agent_id, content_sha256) → reuse existing doc instead of creating
-- duplicates when client retries / network blips.
--
-- Partial unique index: legacy rows have NULL hash and stay un-deduped (safe).
-- New uploads always populate the hash, so they fall under the constraint.

ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS content_sha256 TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_kb_documents_agent_content
  ON kb_documents (agent_id, content_sha256)
  WHERE content_sha256 IS NOT NULL;
