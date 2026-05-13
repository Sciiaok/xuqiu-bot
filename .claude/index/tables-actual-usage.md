# Tables · Actual Usage (hand-maintained)

DB has 47 tables (see `schema.md`), but only **~33 are referenced by runtime code** (`app/`, `lib/`, `src/`, `scripts/`, `proxy.js`). The rest are orphaned by past pivots and kept for backward-compat / data preservation. **2 tables are referenced by code but do not exist in the DB** — those code paths are silently broken.

Update this file when:
- Adding a new table → list which columns the code actually touches
- Dropping or renaming a code path → re-check the column list for affected tables
- A "Used" or "Orphan" classification flips

Last manually verified against live DB: **2026-05-14**.

---

## A. Active tables (referenced by runtime code)

For each table: which columns the runtime actually touches and which are dead weight (schema defines them but nothing in `app/lib/src` reads or writes them). Migrations / markdown / type definitions do not count.

### Tenancy & auth

| Table | Used cols | Dead cols | Notes |
|---|---|---|---|
| `tenants` | id, name, slug, status, created_by, metadata | — | Written only at signup; read at admin listing. |
| `users` | id, tenant_id, email, display_name, role | — | Written at signup; never updated. Read for tenant resolution. |
| `invitations` | id, email, token, status, expires_at, accepted_at, accepted_by_user_id, invited_by_user_id | — | Full lifecycle: admin issues → invitee accepts → revoked. |
| `onboarding_progress` | all 9 cols | — | One row per tenant, write-once timestamps. Upsert by tenant_id. |
| `notification_settings` | all 8 cols | — | One row per tenant. Feishu webhook (AES-256-GCM). |

### Conversation & messaging

| Table | Used cols | Dead cols | Notes |
|---|---|---|---|
| `contacts` | id, wa_id, bsuid, username, name, company_name, metadata, tenant_id, updated_at | — | Dual-key lookup (wa_id + bsuid). Backfill on legacy phone-only rows. |
| `conversations` | id, contact_id, tenant_id, agent_id, status, started_at, ended_at, last_message_at, message_count, closed_reason, is_human_takeover, human_takeover_at, wa_phone_number_id, meta_ad_id, product_line, feishu_notified_at | — | Heavy write. 3-day idle timeout. Feishu dedup via `feishu_notified_at`. |
| `messages` | id, conversation_id, tenant_id, role, content, score_delta, risk_flags, sent_at, sent_by, metadata | — | Append-only; no deletes. |
| `contact_notes` | id, contact_id, content, type, created_by, created_at, updated_at | — | Simple CRUD. Hard delete. |
| `message_queue` | id, conversation_id, contact_id, wa_id, content, message_type, wa_message_id, status, process_after, locked_at, locked_by, processed_at, error_message, retry_count, created_at, metadata | — | `FOR UPDATE SKIP LOCKED` aggregation window. No `tenant_id` (scoped via conversation_id). |

### Lead lifecycle

| Table | Used cols | Dead cols | Notes |
|---|---|---|---|
| `leads` | all 36 cols | — | 36 columns including `details` JSONB for custom lead_fields. Approval flow uses `approved`, `approved_at`, `approved_by`. Dedup via `lead_key`. |
| `lead_sync_logs` | all 13 cols | — | External CRM push tracking. |
| `agents` | id, tenant_id, product_line, name, display_label | system_prompt, output_schema, wa_phone_number_id, is_active, ad_context_map, qualification_config, created_at, updated_at | **Read-only legacy bridge** — runtime never writes. `system_prompt` / `output_schema` etc. ignored by current code; seeded once and never re-read. Used as 1:1 join partner for `product_lines` by slug. |

### Meta / WhatsApp integration

| Table | Used cols | Dead cols | Notes |
|---|---|---|---|
| `meta_connections` | all 13 cols | — | BM-level connection + AES-256-GCM-encrypted token. |
| `meta_phone_numbers` | all 11 cols | — | WABA phone lines. Quality-rating filter blocks RED. |
| `meta_ad_accounts` | all 9 cols | — | Single ad-account per tenant in practice. |
| `product_lines` | all 13 cols | — | `id` is text slug, not UUID. `lead_fields` defines per-line custom inquiry fields. |

### Knowledge Base (4-layer)

| Table | Used cols | Dead cols | Notes |
|---|---|---|---|
| `kb_documents` | id, agent_id, product_line_id, filename, layer, status, content_sha256, knowledge_points_count, file_size, source_type, description, partial_reason, created_at, updated_at | storage_path, external_id, sync_enabled, last_synced_at, error_message, authority_level, is_authoritative, is_outdated | External-sync columns never wired; authority/outdated columns shelved. |
| `kb_knowledge_points` | id, doc_id, agent_id, tenant_id, product_line_id, layer, content_original, status, metadata_json, embedding_original, embedding_en, confidence, created_at | content_en, source_lang, source_location, authority_level, effective_date, expires_at, superseded_by | Bilingual / supersession features unused — only `embedding_en` + `embedding_original` are queried. |
| `kb_products` | id, agent_id, tenant_id, product_line_id, sku, product_name, product_name_en, model, category, specs, fob_price_usd, moq, lead_time_days, is_active, effective_date, expiry_date, confidence, source_doc_id, created_at, updated_at | source_row, doc_id (legacy — replaced by source_doc_id) | `doc_id` is the old FK; current code writes only `source_doc_id`. |
| `kb_shipping_routes` | id, agent_id, tenant_id, product_line_id, destination_port, destination_country, shipping_method, cost_per_unit_usd, transit_days, effective_date, expiry_date, confidence, source_doc_id, created_at, updated_at | origin_port, notes, doc_id | `doc_id` superseded by `source_doc_id`. |
| `kb_assets` | id, agent_id, asset_type, filename, storage_path, mime_type, description, description_en, linked_skus, view, color, scenario, language, is_sendable, caption_embedding, source_doc_id, tenant_id, product_line_id, created_at | file_size_bytes, layer, tags, expiry_date | `layer` + `tags` never queried; `expiry_date` not enforced. |
| `kb_corrections` | id, tenant_id, product_line_id, conversation_id, medici_original_answer, human_corrected_answer, status, created_by, resolved_by, resolved_at, adopted_target_id, created_at | message_id, customer_question, diff_summary, suggested_kb_action, suggested_payload | Diff/suggest fields unused — sales just submits the corrected answer. **0 rows in DB.** |
| `kb_knowledge_gaps` | id, tenant_id, product_line_id, agent_id, query, status, gap_type, occurrence_count, last_occurred_at, question_signature, question_examples, example_message_ids, tool_name, created_at | layer, resolved_by, suggested_resolution, addressed_by_ref | Resolution-suggestion features never wired. |
| `kb_pending_review` | all 15 cols | — | Conflict / low-confidence approval queue. **0 rows in DB** but actively wired. |
| `kb_qa_snippets` | id, tenant_id, product_line_id, questions, questions_embedding, answer, applicable_when, priority, is_active, created_by, created_at, updated_at | — | Hand-curated sales Q&A; checked before main KB search. **0 rows in DB.** |
| `kb_pricing_rules` | id, rule_name, rule_type, conditions, calculation, requires_approval, is_active, effective_from, effective_until, priority, tenant_id, product_line_id | agent_id, doc_id | **Read-only at runtime** — no insert/update path. 1 row in DB. |

### Reports / orchestration / ads

| Table | Used cols | Dead cols | Notes |
|---|---|---|---|
| `autopilot_sessions` | all 10 cols | — | Ogilvy conversation sessions (table name kept for backward compat). Soft-delete via `deleted_at`. |
| `autopilot_messages` | all 12 cols | — | Multi-turn transcript w/ tool I/O. |
| `aigc_assets` | id, tenant_id, conversation_id, user_id, prompt, model, source_filename, product_info, storage_path, metadata, created_at | — | Generated ad images from Ogilvy. `conversation_id` written but always null today. |
| `ai_reports` | all 14 cols | — | Daily / weekly / monthly rollup. |
| `llm_usage_logs` | all 13 cols | — | Every LLM call writes a row (fire-and-forget) for cost dashboard. |

### Legacy but kept on by health check

| Table | Used cols | Dead cols | Notes |
|---|---|---|---|
| `sessions` | (count only) | wa_id, messages, stage, stage_turn_count, score, score_history, risk_flags, lead_data | **Fully dead** — only `/api/health` counts rows. 0 rows in DB. Replaced by `conversations` + `messages`. Safe to drop. |

---

## B. Orphan tables (in DB, NOT referenced by code)

These exist in the public schema but no `.from(...)` / `.rpc(...)` call in `app/`, `lib/`, `src/`, `scripts/`, or `proxy.js` mentions them. They're remnants of past iterations. Row counts at last check shown for forensic context — `0` means abandoned at design, non-zero means actually got used at some point.

| Table | Rows | Replaced by / why orphaned |
|---|---:|---|
| `campaign_briefs` | 188 | Pre-Ogilvy campaign-studio orchestrator. Campaign Studio is now a read-only ad dashboard. |
| `campaign_messages` | 12 | Same. |
| `orchestrator_sessions` | 193 | Pre-`autopilot_*` orchestrator. Ogilvy migrated to `autopilot_*` and kept the table name for back-compat. |
| `orchestrator_messages` | 11 771 | Same. |
| `kb_test_sessions` | 19 | "Test the AI with current KB" sandbox feature shelved. |
| `kb_test_messages` | 57 | Same. |
| `kb_glossary` | 4 | Per-tenant term dictionary never wired into search. |
| `kb_product_assets` | 0 | M:N join table — current code denormalizes `linked_skus` onto `kb_assets`. |
| `fix_knowledge` | 53 | Old auto-fix experiment with embeddings of error patterns. |
| `product_assets` | 0 | Pre-KB product asset table. |
| `product_documents` | 4 | Pre-KB document table (before 2026-05-08 4-layer collapse). |
| `product_specs` | 3 | Pre-KB structured specs. |
| `product_embeddings` | 7 | Pre-KB chunk embeddings. |
| `product_doc_operations` | 15 | Pre-KB operation audit log. |

**Do not delete blindly.** Some still hold historical data the founder might want to inspect via the dev-tools SQL page. But:
- Don't add new code that reads or writes them.
- New features must go through `kb_*` / `autopilot_*` / direct ad-API reads instead.
- A future cleanup migration can drop them once we've confirmed nothing exports their data.

---

## C. Broken references (code mentions, DB does NOT have)

| Table | Code path | What's broken |
|---|---|---|
| `audit_log` | [audit-log.repository.js](../../lib/repositories/audit-log.repository.js), [meta/connect/route.js](../../app/api/meta/connect/route.js), [meta/disconnect/route.js](../../app/api/meta/disconnect/route.js) | Migration `2026-04-26-phase3-audit-log.sql` exists but the table is not in the live DB. Calls to `insert / select from audit_log` silently fail. Either re-apply the migration or remove the repository. |
| `inquiry_dashboard_summaries` | [inquiry-dashboard/summary/route.js](../../app/api/inquiry-dashboard/summary/route.js) | Migration `2026-04-01-inquiry-dashboard-summaries.sql` exists but the table is not in the live DB. The endpoint returns no data. Verify whether the inquiry-dashboard UI is actually wired to this endpoint or to the more recent `/api/inquiry-dashboard` (which queries `leads` directly). |

Pick a resolution before the next dashboard rebuild:
- **(a)** Re-apply the missing migrations and start using these tables, or
- **(b)** Delete the orphan migrations + repository code so the index agrees with reality.

---

## D. RPC functions actually called

From grep of `supabase.rpc(...)` across `app/`, `lib/`, `src/`, `scripts/`:

- `acquire_queue_messages` — message_queue worker
- `release_stale_queue_locks` — queue cron
- `search_kb_knowledge_en` — KB vector search
- `search_kb_qa_snippets` — QA-snippet semantic match
- `ad_conversation_stats` — ad dashboard
- `dev_exec_sql` — read-only SQL for `scripts/build-index.mjs` and `/dev-tools/sql` (called from scripts, not from request handlers)

**Defined in migrations but never invoked at runtime** (likely safe to drop in a future cleanup):

- `search_product_embeddings` — pointed at orphan `product_embeddings`
- `query_product_specs` / `get_spec_fields` — pointed at orphan `product_specs`

---

## E. Storage buckets actually used

- `chat-media` — inbound WhatsApp media
- `chat-uploads` — Ogilvy chat uploads
- `kb-assets` (and legacy `kb_assets` path) — KB document files & extracted images
- `aigc-assets` — Ogilvy-generated ad images

---

## How to keep this file honest

1. After any sweep that touches DB code: run `node scripts/build-index.mjs` (refreshes `schema.md` from live DB).
2. Cross-check this file against the new `schema.md` and update tables that gained / lost columns.
3. If a table moves from Active → Orphan (or vice versa), move its row across sections.
4. Rerun a column-level grep for major tables periodically:
   ```bash
   grep -rEn "from\(['\"]TABLE['\"]" --include="*.js" app lib src
   ```
