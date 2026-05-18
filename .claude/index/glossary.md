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
- **Takeover** — Manual pause of AI auto-reply on a conversation (`conversations.is_human_takeover`). 1-hour TTL: auto-released inline by `checkAndExpireTakeover` on the next inbound message, or in bulk by `release-takeovers` cron. See `/api/conversations/[id]/takeover`.
- **FAQ_END mute** — After Medici routes a turn to `FAQ_END`, `conversations.faq_ended_at` gets set; subsequent customer messages bypass Medici (only persisted to `messages` table). Auto-cleared when a new CTWA referral arrives (= fresh business intent); otherwise stays muted until the 3-day idle timeout opens a new conversation.
- **Routing** — `src/routing.service.js` decides what AI does on each inbound message: FAQ-reply, lead-extract, handoff, ignore.

## Lead lifecycle

- **Lead** (DB) ≡ **Inquiry** (UI) — Extracted prospect record from a conversation. **The UI calls them "inquiries"; the schema calls them "leads".** Don't rename either.
  - **业务字段**（brand / car_model / destination_country / destination_port / loading_port / qty_bucket / color_quantity / company_name / buyer_type / timeline / product_name / sku_description / international_commercial_term 等，按 `product_lines.lead_fields` 配置驱动）全部存在 `leads.details` JSONB 列里，由产品线 lead_fields 决定具体 key 集.
  - **评分/路由元数据**（inquiry_quality / business_value / route / score / conversation_intent / conversation_intent_summary / handoff_summary）继续作为 leads 表的顶层列存储，跨产品线通用、参与 dashboard 聚合.
  - 早期版本 leads 表上还有 13 个硬编码业务列（同名于 details key），已 DEPRECATED 2026-05-17，等待 drop. 别再用，业务字段一律读写 `details->>'xxx'`.
- **Inquiry quality** — Categorical score: `PROOF` / `QUALIFY` / `GOOD` / `BAD`. Set by Medici (`src/agents/medici/`) during lead extraction; enum lives in `src/agents/medici/output-schema.js::INQUIRY_QUALITY_ENUM`.
- **Business value** — Categorical score: `HIGH` / `AVERAGE` / `LOW`.
- **Lead-extractor** — `lib/lead-extractor.js` — LLM logic that parses conversation history → structured lead. Triggered by inbound messages.
- **Lead 去重 / 替换** — Medici 每轮输出后 `replaceConversationLeads`（[lib/repositories/lead.repository.js](../../lib/repositories/lead.repository.js)）对该会话执行"删旧批 + 插新批"全量替换，整对话天然就一组活 leads（按 `lead.id` 区分多 leads），不依赖业务键。早期 `lead_key` 列与 `idx_unique_lead_key` partial unique 索引曾设计为去重键，2026-05-18 已 DEPRECATED（全表 2617 行仅 2 行非 null，生产代码从未写入），等阶段 3 drop。
- **Inquiry dashboard** — `/api/inquiry-dashboard` queries `leads` directly for the dashboard data. `/api/inquiry-dashboard/summary` writes LLM-generated markdown summaries to `inquiry_dashboard_summaries` (7-day TTL, keyed by tenant + product_lines + period).

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
- **Correction** (`kb_corrections`) — Founder-submitted fix to a KB answer. Used to override/augment LLM outputs.
- **Pending review** (`kb_pending_review`) — Editorial buffer for KB writes that conflict with existing content (e.g. new product overlaps an existing one). Founder approves/rejects.
- **Asset** (`kb_assets`) — Media item (image, etc.) extracted from KB docs. Has caption embedding for visual search. Tagged with `scenario`, `view`, `color`, `language`.
- **Pricing rule** (`kb_pricing_rules`) — Pricing logic extracted from KB (used by quote generation). Read-only at runtime; managed offline.
- ~~**KB glossary**~~ / ~~**KB test session / message**~~ / ~~**Gap** (`kb_knowledge_gaps`)~~ — Tables exist (`kb_glossary`, `kb_test_sessions`, `kb_test_messages`, `kb_knowledge_gaps`) but no code references them. Pre-decision or retired features. See `tables-actual-usage.md` §B.
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
- **Queue** — `message_queue` table + `lib/queue-processor.js` consumer. Aggregates rapid inbound messages (per-burst random 15–30s window, see `pickAggregationWindowMs`) so AI replies to a burst, not each fragment. Post-persist failures are caught and don't retry to avoid duplicate Medici calls / double WhatsApp sends — see Plan A comments in `queue-processor.js`.
- **Dev exec SQL** — `dev_exec_sql(query text)` Postgres RPC. Read-only, founder-only. Powers the dev-tools SQL page and `scripts/build-index.mjs`.
- **LLM usage log** — `llm_usage_logs` — every LLM call writes a row with model, tokens, cost. Drives the LLM cost dashboard.
