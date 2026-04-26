-- Per-product-line FAQ fallback message sent to low-quality (BAD/FAQ_END) leads.
-- NULL → fall back to the platform default in src/routing.service.js.
ALTER TABLE product_lines ADD COLUMN IF NOT EXISTS faq_message TEXT;
