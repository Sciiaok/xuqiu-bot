# Domain Glossary (hand-maintained)

Words that appear repeatedly across code, schema, and UI. Many are not self-explanatory or have UI/DB naming divergence.

> A concept might appear in `schema.md` but be dead in current code — when in doubt about whether a table is wired up, check [`tables-actual-usage.md`](tables-actual-usage.md) before extending it. Strikethrough entries below mean "table exists, no runtime code refs it".

**Update this file when:**
- Adding a new domain concept (table, agent role, lifecycle state)
- Renaming a concept (note both old and new names during transition)
- A concept goes dead (move it to a strikethrough form rather than deleting outright)

---

## Tenancy & identity

- **Tenant** — Workspace / organization. Multi-tenant schema, RLS-enforced. Currently 1 user = 1 tenant in practice (no team scenarios).
- **Founder** — The single owner of a tenant. `FOUNDER_TENANT_ID` constant in `lib/tenant-context.js` gates admin-only routes. Founder-id helpers in `lib/founder-id.js`.
- **User** — Auth user (Supabase auth). Joined to tenant via `users` table.
- **Invitation** — JWT-token invite for adding a user to a tenant. Mostly dormant; we don't have teams.

## Conversation / messaging

- **Contact** — A WhatsApp contact (phone-number-identified, but also supports `bsuid` / `username` since IG/Instagram-like sources got added).
- **Conversation** — Message thread with one contact. Scoped to a `product_line`. Has a `status` (active / archived) and AI takeover state.
- **Message** — Individual WhatsApp/IM message in a conversation. May be tied to a `lead_id` if it triggered extraction.
- **Takeover** — Manual pause of AI auto-reply on a conversation. Released after timeout by `release-takeovers` cron, or manually. See `/api/conversations/[id]/takeover`.
- **Routing** — `src/routing.service.js` decides what AI does on each inbound message: FAQ-reply, lead-extract, handoff, ignore.

## Lead lifecycle

- **Lead** (DB) ≡ **Inquiry** (UI) — Extracted prospect record from a conversation. Fields: brand, car_model, destination_country, color_quantity, qty_bucket, timeline, business_value, inquiry_quality, etc. **The UI calls them "inquiries"; the schema calls them "leads".** Don't rename either.
- **Inquiry quality** — Categorical score: `PROOF` / `QUALIFY` / `GOOD` / `BAD`. Set by LLM during extraction per `src/scoring-rules.json`.
- **Business value** — Categorical score: `HIGH` / `AVERAGE` / `LOW`.
- **Lead-extractor** — `lib/lead-extractor.js` — LLM logic that parses conversation history → structured lead. Triggered by inbound messages and by `sync-leads` cron.
- **Approval** — A lead can be manually `approved` (boolean), capturing the founder's confirmation; tracked with `approved_at`, `approved_by`.
- **lead_key** — Dedup key (contact + brand + product, roughly) so re-extractions update the same row instead of creating duplicates.
- **Inquiry dashboard** — Pre-computed daily rollup table `inquiry_dashboard_summaries`. Used by Reports/Analytics for fast loads.

## Product lines

- **Product line** — Top-level catalog bucket (e.g. "Cars", "Shipping"). Composite PK `(tenant_id, id)`. Owns KB content, scopes conversations, maps to a WhatsApp Business Account.
- **Business value guidance / FAQ message / message style examples** — Per-product-line LLM prompt customization, stored as columns on `product_lines`.

## Knowledge Base (the big one)

- **4-layer KB** — Since the 2026-05-08 redesign, KB is structured as:
  1. **`kb_documents`** — raw uploaded files (PDF, image, etc.) + parsed content.
  2. **`kb_products`** — structured product records extracted from docs.
  3. **`kb_shipping_routes`** — route/logistics records.
  4. **`kb_knowledge_points`** — atomic Q&A-style chunks.
- **KB chunk / knowledge point** — Generic name for an atomic searchable KB unit. Usually means a row in `kb_knowledge_points`.
- **QA snippet** (`kb_qa_snippets`) — Pre-computed Q&A pair with embedding. Faster lookup than full KB search for common questions.
- **Gap** (`kb_knowledge_gaps`) — A question the AI couldn't answer well from current KB. Tracked so the founder can teach the KB.
- **Correction** (`kb_corrections`) — Founder-submitted fix to a KB answer. Used to override/augment LLM outputs.
- **Pending review** (`kb_pending_review`) — Editorial buffer for KB writes that conflict with existing content (e.g. new product overlaps an existing one). Founder approves/rejects.
- **Asset** (`kb_assets`) — Media item (image, etc.) extracted from KB docs. Has caption embedding for visual search. Tagged with `scenario`, `view`, `color`, `language`.
- **Pricing rule** (`kb_pricing_rules`) — Pricing logic extracted from KB (used by quote generation). Read-only at runtime; managed offline.
- ~~**KB glossary**~~ / ~~**KB test session / message**~~ — Tables exist (`kb_glossary`, `kb_test_sessions`, `kb_test_messages`) but no code references them. Pre-decision or shelved features. See `tables-actual-usage.md` §B.
- **Teach** (`/api/knowledge/teach`) — Entry point for founder to add a knowledge point / answer a gap. Writes into `kb_knowledge_points` or `kb_corrections`.

## Campaign / orchestrator

- **Ogilvy session** — Unit of LLM-driven multi-turn ad planning. **Stored in `autopilot_sessions` + `autopilot_messages`** (table names retained from the pre-Ogilvy iteration; the code calls them Ogilvy sessions). `plan_json` holds the in-progress ad draft. Soft-delete via `deleted_at`.
- **AIGC asset** — AI-generated image. Row in `aigc_assets`, file in storage bucket `aigc-assets`. Best-of-N controlled by `AIGC_BEST_OF_N`.
- ~~**Campaign brief / Campaign message / Orchestrator session**~~ — Pre-Ogilvy orchestrator concepts. The tables (`campaign_briefs`, `campaign_messages`, `orchestrator_sessions`, `orchestrator_messages`) still exist in DB but no code references them. Don't extend or rely on them — see `tables-actual-usage.md` §B.

## Meta / WhatsApp

- **WABA** — WhatsApp Business Account. Maps 1:N to phone numbers.
- **Phone number id** — Meta's identifier for a WABA phone line. Stored in `meta_phone_numbers`. Webhooks arrive keyed on this.
- **BM** — Business Manager. `meta-bm-resolver` figures out which BM/WABA → tenant + product-line.
- **Token crypto** — Meta access tokens are envelope-encrypted with `META_TOKEN_ENCRYPTION_KEY`. See `lib/meta-token-crypto.js`.

## Infra / cross-cutting

- **Tenant context** (`lib/tenant-context.js`) — Server-side helper that resolves the current request's tenant. Returns `{ tenantId, userId, supabase }`.
- **Service role** — Supabase service-role key. Bypasses RLS. Used for admin ops, cron, webhook ingestion (before tenant resolved). Lives in `lib/supabase-admin.js`.
- **Queue** — `message_queue` table + `lib/queue-processor.js` consumer. Aggregates rapid inbound messages (2s window) so AI replies to a burst, not each message.
- **Dev exec SQL** — `dev_exec_sql(query text)` Postgres RPC. Read-only, founder-only. Powers the dev-tools SQL page and `scripts/build-index.mjs`.
- **LLM usage log** — `llm_usage_logs` — every LLM call writes a row with model, tokens, cost. Drives the LLM cost dashboard.
