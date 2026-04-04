-- Add BSUID (Business Scoped User ID) and username columns to contacts
-- Required for WhatsApp username feature rollout (June 2026)
-- BSUID is always present in webhooks; wa_id (phone) may be absent for username-initiated contacts

-- New columns
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS bsuid TEXT UNIQUE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS username TEXT;

-- Allow wa_id to be NULL (username-initiated contacts won't have a phone number)
ALTER TABLE contacts ALTER COLUMN wa_id DROP NOT NULL;

-- Ensure every contact has at least one identifier
ALTER TABLE contacts ADD CONSTRAINT contacts_has_identifier
  CHECK (wa_id IS NOT NULL OR bsuid IS NOT NULL);

-- Index for BSUID lookups
CREATE INDEX IF NOT EXISTS idx_contacts_bsuid ON contacts(bsuid) WHERE bsuid IS NOT NULL;
