-- Phase 2a follow-up: two more content slots on product_lines.
-- These hold per-line business-value thresholds and message-style examples
-- that the assembly code (src/product-lines/assemble.js) splices into the
-- shared BASE_PROMPT template.

ALTER TABLE product_lines ADD COLUMN IF NOT EXISTS business_value_guidance TEXT;
ALTER TABLE product_lines ADD COLUMN IF NOT EXISTS message_style_examples  TEXT;
