-- Add file_size (bytes) to kb_documents for displaying upload size in the UI.
ALTER TABLE kb_documents ADD COLUMN IF NOT EXISTS file_size BIGINT;
