# Routes (auto-generated)

Generated: 2026-06-04T08:32:28.390Z

Filesystem-derived list of API endpoints and UI pages. **Do not edit** — run `node scripts/build-index.mjs` to refresh.

## API Endpoints

Total: **85**

| Path | Methods | File |
| --- | --- | --- |
| `/api/admin/invitations` | GET, POST | [app/api/admin/invitations/route.js](../../app/api/admin/invitations/route.js) |
| `/api/admin/invitations/[id]` | DELETE | [app/api/admin/invitations/[id]/route.js](../../app/api/admin/invitations/[id]/route.js) |
| `/api/admin/llm-usage` | GET | [app/api/admin/llm-usage/route.js](../../app/api/admin/llm-usage/route.js) |
| `/api/admin/skills` | GET | [app/api/admin/skills/route.js](../../app/api/admin/skills/route.js) |
| `/api/admin/skills/[name]/activate` | POST | [app/api/admin/skills/[name]/activate/route.js](../../app/api/admin/skills/[name]/activate/route.js) |
| `/api/admin/skills/[name]/branches` | GET | [app/api/admin/skills/[name]/branches/route.js](../../app/api/admin/skills/[name]/branches/route.js) |
| `/api/admin/skills/[name]/commits` | GET | [app/api/admin/skills/[name]/commits/route.js](../../app/api/admin/skills/[name]/commits/route.js) |
| `/api/admin/tenants` | GET | [app/api/admin/tenants/route.js](../../app/api/admin/tenants/route.js) |
| `/api/admin/tenants/[id]` | PATCH | [app/api/admin/tenants/[id]/route.js](../../app/api/admin/tenants/[id]/route.js) |
| `/api/ads` | GET | [app/api/ads/route.js](../../app/api/ads/route.js) |
| `/api/ads/by-campaign` | GET | [app/api/ads/by-campaign/route.js](../../app/api/ads/by-campaign/route.js) |
| `/api/ads/creative-image` | GET | [app/api/ads/creative-image/route.js](../../app/api/ads/creative-image/route.js) |
| `/api/ads/dashboard` | GET | [app/api/ads/dashboard/route.js](../../app/api/ads/dashboard/route.js) |
| `/api/ads/info` | GET | [app/api/ads/info/route.js](../../app/api/ads/info/route.js) |
| `/api/ads/metrics` | GET | [app/api/ads/metrics/route.js](../../app/api/ads/metrics/route.js) |
| `/api/ads/preview` | GET | [app/api/ads/preview/route.js](../../app/api/ads/preview/route.js) |
| `/api/ai/report` | POST | [app/api/ai/report/route.js](../../app/api/ai/report/route.js) |
| `/api/ai/report/stream` | GET | [app/api/ai/report/stream/route.js](../../app/api/ai/report/stream/route.js) |
| `/api/auth/invitation/[token]` | GET | [app/api/auth/invitation/[token]/route.js](../../app/api/auth/invitation/[token]/route.js) |
| `/api/auth/signup` | POST | [app/api/auth/signup/route.js](../../app/api/auth/signup/route.js) |
| `/api/contacts/[id]/notes` | GET, POST | [app/api/contacts/[id]/notes/route.js](../../app/api/contacts/[id]/notes/route.js) |
| `/api/contacts/[id]/notes/[noteId]` | DELETE | [app/api/contacts/[id]/notes/[noteId]/route.js](../../app/api/contacts/[id]/notes/[noteId]/route.js) |
| `/api/contacts/[id]/profile` | GET | [app/api/contacts/[id]/profile/route.js](../../app/api/contacts/[id]/profile/route.js) |
| `/api/conversations/[id]/leads` | GET | [app/api/conversations/[id]/leads/route.js](../../app/api/conversations/[id]/leads/route.js) |
| `/api/conversations/[id]/suggest-reply` | POST | [app/api/conversations/[id]/suggest-reply/route.js](../../app/api/conversations/[id]/suggest-reply/route.js) |
| `/api/conversations/[id]/takeover` | POST, DELETE | [app/api/conversations/[id]/takeover/route.js](../../app/api/conversations/[id]/takeover/route.js) |
| `/api/conversations/[id]/translate` | POST | [app/api/conversations/[id]/translate/route.js](../../app/api/conversations/[id]/translate/route.js) |
| `/api/conversations/[id]/translate-draft` | POST | [app/api/conversations/[id]/translate-draft/route.js](../../app/api/conversations/[id]/translate-draft/route.js) |
| `/api/cron/generate-reports` | GET, POST | [app/api/cron/generate-reports/route.js](../../app/api/cron/generate-reports/route.js) |
| `/api/cron/meta-health-check` | POST | [app/api/cron/meta-health-check/route.js](../../app/api/cron/meta-health-check/route.js) |
| `/api/cron/process-queue` | GET | [app/api/cron/process-queue/route.js](../../app/api/cron/process-queue/route.js) |
| `/api/cron/recover-stale-kb-docs` | GET | [app/api/cron/recover-stale-kb-docs/route.js](../../app/api/cron/recover-stale-kb-docs/route.js) |
| `/api/dev-tools/ai-sql` | POST | [app/api/dev-tools/ai-sql/route.js](../../app/api/dev-tools/ai-sql/route.js) |
| `/api/dev-tools/sql` | POST | [app/api/dev-tools/sql/route.js](../../app/api/dev-tools/sql/route.js) |
| `/api/health` | GET | [app/api/health/route.js](../../app/api/health/route.js) |
| `/api/inquiries` | GET | [app/api/inquiries/route.js](../../app/api/inquiries/route.js) |
| `/api/inquiry-dashboard` | GET | [app/api/inquiry-dashboard/route.js](../../app/api/inquiry-dashboard/route.js) |
| `/api/knowledge/assets` | GET, POST, PATCH, DELETE | [app/api/knowledge/assets/route.js](../../app/api/knowledge/assets/route.js) |
| `/api/knowledge/conflicts/resolve` | POST | [app/api/knowledge/conflicts/resolve/route.js](../../app/api/knowledge/conflicts/resolve/route.js) |
| `/api/knowledge/corrections` | GET, POST, PUT | [app/api/knowledge/corrections/route.js](../../app/api/knowledge/corrections/route.js) |
| `/api/knowledge/documents` | GET, DELETE | [app/api/knowledge/documents/route.js](../../app/api/knowledge/documents/route.js) |
| `/api/knowledge/documents/download` | GET | [app/api/knowledge/documents/download/route.js](../../app/api/knowledge/documents/download/route.js) |
| `/api/knowledge/documents/reparse` | POST | [app/api/knowledge/documents/reparse/route.js](../../app/api/knowledge/documents/reparse/route.js) |
| `/api/knowledge/health` | GET | [app/api/knowledge/health/route.js](../../app/api/knowledge/health/route.js) |
| `/api/knowledge/pending-review` | GET, POST | [app/api/knowledge/pending-review/route.js](../../app/api/knowledge/pending-review/route.js) |
| `/api/knowledge/qa-snippets` | GET, PUT, DELETE | [app/api/knowledge/qa-snippets/route.js](../../app/api/knowledge/qa-snippets/route.js) |
| `/api/knowledge/teach` | POST | [app/api/knowledge/teach/route.js](../../app/api/knowledge/teach/route.js) |
| `/api/knowledge/teach/commit` | POST | [app/api/knowledge/teach/commit/route.js](../../app/api/knowledge/teach/commit/route.js) |
| `/api/knowledge/upload` | POST | [app/api/knowledge/upload/route.js](../../app/api/knowledge/upload/route.js) |
| `/api/knowledge/upload/stream` | GET | [app/api/knowledge/upload/stream/route.js](../../app/api/knowledge/upload/stream/route.js) |
| `/api/leads/[id]` | GET, PATCH | [app/api/leads/[id]/route.js](../../app/api/leads/[id]/route.js) |
| `/api/media/whatsapp/[mediaId]` | GET | [app/api/media/whatsapp/[mediaId]/route.js](../../app/api/media/whatsapp/[mediaId]/route.js) |
| `/api/medici-simulator/send` | POST | [app/api/medici-simulator/send/route.js](../../app/api/medici-simulator/send/route.js) |
| `/api/meta/connect` | POST | [app/api/meta/connect/route.js](../../app/api/meta/connect/route.js) |
| `/api/meta/connect/preview` | POST | [app/api/meta/connect/preview/route.js](../../app/api/meta/connect/preview/route.js) |
| `/api/meta/connection` | GET | [app/api/meta/connection/route.js](../../app/api/meta/connection/route.js) |
| `/api/meta/disconnect` | POST | [app/api/meta/disconnect/route.js](../../app/api/meta/disconnect/route.js) |
| `/api/meta/page-id` | POST | [app/api/meta/page-id/route.js](../../app/api/meta/page-id/route.js) |
| `/api/meta/refresh` | POST | [app/api/meta/refresh/route.js](../../app/api/meta/refresh/route.js) |
| `/api/ogilvy/conversations` | GET, POST | [app/api/ogilvy/conversations/route.js](../../app/api/ogilvy/conversations/route.js) |
| `/api/ogilvy/conversations/[id]` | GET, DELETE | [app/api/ogilvy/conversations/[id]/route.js](../../app/api/ogilvy/conversations/[id]/route.js) |
| `/api/ogilvy/conversations/[id]/ad-status` | GET | [app/api/ogilvy/conversations/[id]/ad-status/route.js](../../app/api/ogilvy/conversations/[id]/ad-status/route.js) |
| `/api/ogilvy/conversations/[id]/launch` | POST | [app/api/ogilvy/conversations/[id]/launch/route.js](../../app/api/ogilvy/conversations/[id]/launch/route.js) |
| `/api/ogilvy/conversations/[id]/messages` | POST | [app/api/ogilvy/conversations/[id]/messages/route.js](../../app/api/ogilvy/conversations/[id]/messages/route.js) |
| `/api/ogilvy/conversations/[id]/pause` | POST | [app/api/ogilvy/conversations/[id]/pause/route.js](../../app/api/ogilvy/conversations/[id]/pause/route.js) |
| `/api/ogilvy/conversations/[id]/resume` | POST | [app/api/ogilvy/conversations/[id]/resume/route.js](../../app/api/ogilvy/conversations/[id]/resume/route.js) |
| `/api/ogilvy/conversations/[id]/usage` | GET | [app/api/ogilvy/conversations/[id]/usage/route.js](../../app/api/ogilvy/conversations/[id]/usage/route.js) |
| `/api/ogilvy/creatives` | GET | [app/api/ogilvy/creatives/route.js](../../app/api/ogilvy/creatives/route.js) |
| `/api/ogilvy/sessions/ad-status` | GET | [app/api/ogilvy/sessions/ad-status/route.js](../../app/api/ogilvy/sessions/ad-status/route.js) |
| `/api/ogilvy/sessions/metrics` | GET | [app/api/ogilvy/sessions/metrics/route.js](../../app/api/ogilvy/sessions/metrics/route.js) |
| `/api/ogilvy/upload` | POST | [app/api/ogilvy/upload/route.js](../../app/api/ogilvy/upload/route.js) |
| `/api/ogilvy/whatsapp-accounts` | GET | [app/api/ogilvy/whatsapp-accounts/route.js](../../app/api/ogilvy/whatsapp-accounts/route.js) |
| `/api/onboarding/progress` | GET, POST | [app/api/onboarding/progress/route.js](../../app/api/onboarding/progress/route.js) |
| `/api/product-lines` | GET, POST | [app/api/product-lines/route.js](../../app/api/product-lines/route.js) |
| `/api/product-lines/[id]` | GET, PUT | [app/api/product-lines/[id]/route.js](../../app/api/product-lines/[id]/route.js) |
| `/api/product-lines/[id]/cost-stats` | GET | [app/api/product-lines/[id]/cost-stats/route.js](../../app/api/product-lines/[id]/cost-stats/route.js) |
| `/api/product-lines/[id]/ogilvy-ad-spend` | GET | [app/api/product-lines/[id]/ogilvy-ad-spend/route.js](../../app/api/product-lines/[id]/ogilvy-ad-spend/route.js) |
| `/api/product-lines/stats` | GET | [app/api/product-lines/stats/route.js](../../app/api/product-lines/stats/route.js) |
| `/api/reports` | GET, POST | [app/api/reports/route.js](../../app/api/reports/route.js) |
| `/api/reports/[id]` | GET, POST | [app/api/reports/[id]/route.js](../../app/api/reports/[id]/route.js) |
| `/api/reports/export` | GET | [app/api/reports/export/route.js](../../app/api/reports/export/route.js) |
| `/api/send-message` | POST | [app/api/send-message/route.js](../../app/api/send-message/route.js) |
| `/api/settings/notifications` | GET, POST | [app/api/settings/notifications/route.js](../../app/api/settings/notifications/route.js) |
| `/api/settings/notifications/test` | POST | [app/api/settings/notifications/test/route.js](../../app/api/settings/notifications/test/route.js) |
| `/api/webhook` | GET, POST | [app/api/webhook/route.js](../../app/api/webhook/route.js) |

## UI Pages

Total: **17**

| URL | File |
| --- | --- |
| `/admin/invitations` | [app/(app)/admin/invitations/page.js](../../app/(app)/admin/invitations/page.js) |
| `/admin/llm-usage` | [app/(app)/admin/llm-usage/page.js](../../app/(app)/admin/llm-usage/page.js) |
| `/admin/skills` | [app/(app)/admin/skills/page.js](../../app/(app)/admin/skills/page.js) |
| `/admin/tenants` | [app/(app)/admin/tenants/page.js](../../app/(app)/admin/tenants/page.js) |
| `/analytics` | [app/(app)/analytics/page.js](../../app/(app)/analytics/page.js) |
| `/campaign-studio` | [app/(app)/campaign-studio/page.js](../../app/(app)/campaign-studio/page.js) |
| `/dev-tools` | [app/(app)/dev-tools/page.js](../../app/(app)/dev-tools/page.js) |
| `/dev-tools/sql` | [app/(app)/dev-tools/sql/page.js](../../app/(app)/dev-tools/sql/page.js) |
| `/leadhub` | [app/(app)/leadhub/page.js](../../app/(app)/leadhub/page.js) |
| `/ogilvy` | [app/(app)/ogilvy/page.js](../../app/(app)/ogilvy/page.js) |
| `/page.js` | [app/(app)/page.js](../../app/(app)/page.js) |
| `/product-lines` | [app/(app)/product-lines/page.js](../../app/(app)/product-lines/page.js) |
| `/product-lines/[id]` | [app/(app)/product-lines/[id]/page.js](../../app/(app)/product-lines/[id]/page.js) |
| `/reports` | [app/(app)/reports/page.js](../../app/(app)/reports/page.js) |
| `/reports/[id]` | [app/(app)/reports/[id]/page.js](../../app/(app)/reports/[id]/page.js) |
| `/settings/meta-connection` | [app/(app)/settings/meta-connection/page.js](../../app/(app)/settings/meta-connection/page.js) |
| `/settings/notifications` | [app/(app)/settings/notifications/page.js](../../app/(app)/settings/notifications/page.js) |

## Cron Jobs

- `/api/cron/generate-reports` → [app/api/cron/generate-reports/route.js](../../app/api/cron/generate-reports/route.js)
- `/api/cron/meta-health-check` → [app/api/cron/meta-health-check/route.js](../../app/api/cron/meta-health-check/route.js)
- `/api/cron/process-queue` → [app/api/cron/process-queue/route.js](../../app/api/cron/process-queue/route.js)
- `/api/cron/recover-stale-kb-docs` → [app/api/cron/recover-stale-kb-docs/route.js](../../app/api/cron/recover-stale-kb-docs/route.js)
