# Feature Map (hand-maintained)

Goal: when Claude Code picks up a task touching feature X, read this file first to know which directories/files to open. Saves 5–10 minutes of grepping per task.

**Update this file when:**
- Adding a new top-level feature (new section)
- Moving a feature's primary files to a different directory
- Adding a new cross-cutting service that lives in a non-obvious place

**Don't update for:**
- New routes (already covered by `routes.md`)
- New tables/columns (covered by `schema.md`)
- Internal refactors that don't change the top-level layout

---

## Quick "where do I add X"

| If you're adding... | Goes in... |
| --- | --- |
| New API endpoint | `app/api/<feature>/route.js` (Next.js App Router conventions) |
| New page | `app/(app)/<feature>/page.js` |
| Domain service (LLM, KB, WhatsApp, routing) | `src/*.service.js` |
| Supabase access helpers / data fetching | `lib/repositories/*.repository.js` |
| Cross-cutting infra (Redis, SSE, queue, tenant context) | `lib/*.js` (no subdir unless a clear cluster) |
| Shared UI component | `app/components/<ComponentName>/` |
| DB migration | `supabase/migrations/<YYYY-MM-DD-name>.sql` (append-only, never edit past files) |
| New skill | `skills/<skill-name>/SKILL.md` |
| One-off ops query | `supabase/operations/` |

---

## Repo conventions worth knowing

- **`src/` vs `lib/`**: `src/` = domain services (KB, WhatsApp, LLM, routing, report generation, external sync). `lib/` = infra plumbing (Supabase clients, repositories, queue, SSE, tenant context). Repositories live in `lib/repositories/`; all services live at `src/*.service.js`.
- **Config**: only `src/config.js` reads `process.env.*`. Everything else imports from `config`.
- **Tenant scoping**: every query that touches user data must go through `getTenantContext()` (`lib/tenant-context.js`). RLS is enforced; service-role usage is rare and lives in `lib/supabase-admin.js`.
- **Single-user product**: founder-only access in places. See `FOUNDER_TENANT_ID` in `lib/tenant-context.js`. Do not add team/multi-seat scaffolding.
- **Product-line is the primary scope**: most knowledge, leads, conversations are bucketed under a `product_line` FK. KB lives **inside** `product-lines/[id]/knowledge-base/`, not as a top-level page.

---

## Features

### LeadHub — inbox + conversation UI
- **UI**: `app/(app)/leadhub/page.js`
- **API**: `/api/inquiries`, `/api/conversations/[id]/leads`, `/api/conversations/[id]/takeover`, `/api/contacts/[id]/profile`, `/api/contacts/[id]/notes`
- **Repositories**: `lib/repositories/{lead,conversation,contact}.repository.js`
- **Lib**: `lib/inquiries-filters.js`, `lib/inquiry-dashboard.js`, `lib/conversation-context.service.js`, `lib/lead-extractor.js`
- **Tables**: `contacts`, `conversations`, `messages`, `leads`, `contact_notes`, `inquiry_dashboard_summaries`
- **Notes**: "inquiry" in UI ≡ "lead" in DB; see `glossary.md`. Lead extraction is LLM-driven via `lead-extractor.js`, triggered after inbound messages. The "takeover" endpoint pauses AI auto-reply for a conversation.

### Product Lines — catalog management + per-line config
- **UI**: `app/(app)/product-lines/page.js`, `app/(app)/product-lines/[id]/page.js`
- **API**: `/api/product-lines`, `/api/product-lines/[id]`
- **Repositories**: `lib/repositories/product-line.repository.js`
- **Lib**: `lib/car-catalog-context.js` (catalog snapshot for LLM prompts)
- **Tables**: `product_lines` (composite PK `tenant_id, id`)
- **Notes**: Product-line is THE scope unit. Adding a feature that's "per workspace"? Almost always means "per product-line". The detail page hosts KB + Medici simulator as tabs.

### Knowledge Base — upload, parse, embed, search, QA, gaps, corrections
- **UI**: `app/(app)/product-lines/[id]/knowledge-base/KnowledgeBaseTab.js` (lives inside product-line detail page)
- **API**: `/api/knowledge/*` — `upload`, `documents`, `documents/download`, `assets`, `gaps`, `corrections`, `pending-review`, `qa-snippets`, `teach`, `health`, `conflicts/resolve`
- **Services** (in `src/`): `kb-upload.service.js`, `kb-search.service.js`, `kb-corrections.service.js`, `kb-gaps.service.js`, `kb-qa-snippets.service.js`, `kb-pending-review.service.js`, `kb-image-extractor.service.js`, `kb-tools.service.js`, `kb-file-parsers.js`
- **Lib**: `lib/kb-upload-bus.js` (async event bus), `lib/repositories/knowledge-base.repository.js`
- **Tables**: `kb_documents`, `kb_products`, `kb_shipping_routes`, `kb_knowledge_points`, `kb_qa_snippets`, `kb_corrections`, `kb_knowledge_gaps`, `kb_pending_review`, `kb_assets`, `kb_product_assets`, `kb_pricing_rules`, `kb_glossary`, `kb_test_sessions`, `kb_test_messages`
- **Notes**: Heavy module — biggest single feature. Upload is async via `kb-upload-bus`; parsing → embedding → 4-layer KB (documents / products / routes / knowledge_points). Pending review handles editorial conflicts. Gaps track unanswered questions for KB improvement. **Flagged duplication**: services scattered across `src/` and a single repository in `lib/` — fine for now, just know both places exist.

### Campaign Studio — ad campaign generation
- **UI**: `app/(app)/campaign-studio/page.js`
- **API**: `/api/ads/{route,dashboard,metrics,preview,by-campaign,creative-image}`
- **Agents**: `src/agents/` (orchestrator code for brief + creative generation)
- **Tables**: `campaign_briefs`, `campaign_messages`, `orchestrator_sessions`, `orchestrator_messages`, `aigc_assets`
- **Notes**: Orchestrator session is the unit of work. AIGC images go to the `aigc-assets` Supabase Storage bucket.

### Ogilvy — overseas ad planning skill
- **UI**: `app/(app)/ogilvy/page.js` (+ `components/`, `hooks/`)
- **API**: `/api/ogilvy/*`
- **Skill**: `skills/overseas-ad-planning/SKILL.md` (v1.1, 10 chapters w/ stage-independent calls)
- **Repositories**: `lib/repositories/ogilvy.repository.js`
- **Tables**: shares `orchestrator_sessions`, `orchestrator_messages` with Campaign Studio
- **Notes**: Front-end to the overseas-ad-planning skill. Reuses orchestrator tables.

### Meta / WhatsApp Integration
- **UI**: `app/(app)/settings/meta-connection/page.js`
- **API**: `/api/meta/*`, `/api/webhook` (inbound from Meta), `/api/send-message` (outbound), `/api/media/whatsapp`
- **Services**: `src/whatsapp.service.js`, `src/whatsapp-media.service.js`, `src/routing.service.js` (decides reply vs handoff)
- **Lib**: `lib/meta-bm-resolver.js` (WABA → product-line), `lib/meta-token-crypto.js` (envelope encryption, key from `META_TOKEN_ENCRYPTION_KEY`), `lib/meta-tenant-context.js`, `lib/repositories/meta-connection.repository.js`
- **Cron**: `/api/cron/meta-health-check`
- **Tables**: `meta_connections`, `meta_phone_numbers`, `meta_ad_accounts`
- **Storage bucket**: `chat-media`
- **Notes**: Tokens encrypted at rest. BM resolver routes inbound webhooks to the right tenant + product-line by WABA phone number. Outbound goes via `whatsapp.service.js`; auto-reply controlled by takeover state on the conversation.

### Reports & Analytics
- **UI**: `app/(app)/reports/page.js`, `app/(app)/reports/[id]/page.js`, `app/(app)/analytics/page.js`
- **API**: `/api/reports`, `/api/reports/[id]`, `/api/reports/export`, `/api/ai/report`, `/api/ai/report/stream`, `/api/inquiry-dashboard`, `/api/cron/generate-reports`
- **Services**: `src/llm-client.js` (all LLM calls + cost logging), `src/llm-pricing.js`
- **Lib**: `lib/ai-summary.js`, `lib/sse.js` + `lib/consume-sse.js` (streaming reports)
- **Tables**: `inquiry_dashboard_summaries` (pre-computed), `ai_reports`, `llm_usage_logs`
- **Notes**: Inquiry dashboard summaries are pre-computed (cron-generated). AI report streams via SSE. LLM cost dashboard reads `llm_usage_logs`.

### Onboarding & Auth
- **UI**: `app/(auth)/*` (login/signup pages), `app/(app)/admin/invitations/page.js`
- **API**: `/api/auth/signup`, `/api/auth/invitation/[token]`, `/api/onboarding/progress`
- **Lib**: `lib/session.js`, `lib/founder-id.js`, `lib/tenant-context.js` (and `meta-tenant-context.js` for webhook ingestion)
- **Repositories**: `lib/repositories/onboarding.repository.js`
- **Tables**: `tenants`, `users`, `invitations`, `onboarding_progress`
- **Notes**: Single founder per tenant. `FOUNDER_TENANT_ID` constant gates admin routes. Onboarding progress tracks milestone timestamps (meta_connected_at, first_ai_reply_at, etc.).

### Settings
- **UI**: `app/(app)/settings/meta-connection/page.js`, `app/(app)/settings/notifications/page.js`
- **API**: `/api/settings/notifications`, `/api/meta/*`
- **Tables**: `notification_settings`
- **Notes**: Feishu notifications are per-tenant webhook URLs stored in `notification_settings` (no global Feishu app).

### Admin & Dev Tools
- **UI**: `app/(app)/admin/{tenants,invitations,llm-usage}/page.js`, `app/(app)/dev-tools/page.js`, `app/(app)/dev-tools/sql/page.js`
- **API**: `/api/admin/*`, `/api/dev-tools/sql`, `/api/dev-tools/ai-sql`, `/api/health`
- **Notes**: Admin routes restricted to `FOUNDER_TENANT_ID`. `dev_exec_sql` Postgres RPC enables read-only SQL queries from the dev-tools UI (see `supabase/migrations/2026-04-27-dev-exec-sql-rpc.sql`). The same RPC is what `scripts/build-index.mjs` uses.

### Cron jobs (see `routes.md` for full list)
- `generate-reports` — daily AI report rollup
- `meta-health-check` — token refresh + connection health
- `process-queue` — message_queue aggregation worker (also runs in-process; PM2 hosts a long-runner via `ecosystem.config.cjs`)
- `recover-stale-kb-docs` — re-runs stalled KB document parsing
- `release-takeovers` — auto-resumes AI after takeover timeout
- `sync-leads` — re-extracts leads on conversation updates

### Process-level background workers
- **Queue processor**: `lib/queue-processor.js` runs in-process (see `app/api/cron/process-queue/route.js` for the entrypoint signature) and also as a PM2 daemon (`ecosystem.config.cjs`). The cron is a backup trigger.
- **KB upload bus**: `lib/kb-upload-bus.js` — Redis-backed pub/sub for async parsing pipeline.

---

## Cross-cutting concerns

- **Tenant context**: `lib/tenant-context.js` — every server route should resolve this first. Webhook ingestion uses `lib/meta-tenant-context.js` (which resolves tenant from phone_number_id).
- **LLM access**: ALL LLM calls go through `src/llm-client.js` (uses OpenRouter). Direct OpenAI calls are only allowed for embeddings + Whisper.
- **SSE streaming**: `lib/sse.js` (server side), `lib/consume-sse.js` (client side). Used by AI report, possibly orchestrator streams.
- **Tracing**: `lib/core-trace.js` — wrap long-running flows for trace IDs.
- **Supabase clients**: `lib/supabase-server.js` (RLS-respecting, request-scoped), `lib/supabase-browser.js` (client component), `lib/supabase-admin.js` (service-role, server only).
- **Redis**: `lib/redis.js` — single shared connection; queue + rate limiter + cache.

---

## Known duplication / "why are there two of these"

- ~~`src/*.service.js` + `lib/services/`~~: collapsed — all services now at `src/*.service.js`. The old split was incidental, not principled.
- **`orchestrator_*` tables**: shared by Campaign Studio + Ogilvy. Don't assume one feature owns them.
- **`product_doc_operations` / `product_documents` / `product_specs`** (older) vs **`kb_*`** (newer): legacy product-doc tables predate the 4-layer KB redesign (see `2026-05-08-kb-collapse-to-four-layers.sql`). Reads should target `kb_*` going forward; legacy tables still exist for backward compat.
