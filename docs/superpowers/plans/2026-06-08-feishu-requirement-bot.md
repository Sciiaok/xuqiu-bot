# Feishu Requirement Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Feishu-card-driven requirement workflow where team members submit issues in a Feishu group, AI generates a PRD, PM confirms it, owners advance delivery through Feishu card actions, and Feishu Bitable receives the global ledger.

**Architecture:** Add a focused `requirements` domain alongside existing LeadEngine modules. Feishu application events and card callbacks enter through new API routes, domain services handle AI drafting/state transitions/card rendering/reminders/Bitable sync, and Supabase stores the source of truth. Daily workflow stays in Feishu cards; the global view lives in Feishu Bitable. LeadEngine only exposes bot configuration and backend archival/API surfaces.

**Tech Stack:** Next.js App Router, Supabase/Postgres, existing `@larksuiteoapi/node-sdk`, existing `src/llm-client.js`, Feishu application bot event callbacks, Feishu interactive cards, Feishu Bitable API.

---

## Scope Notes

This plan implements the first-version design in `docs/superpowers/specs/2026-06-08-feishu-requirement-bot-design.md`.

Latest scope correction: the product does not include a LeadEngine "requirement workspace" page. The team works from Feishu cards and Feishu Bitable; LeadEngine keeps settings, storage, audit events, and integration APIs.

Repository instruction override: `CLAUDE.md` says not to write test files or run `npm test`. This plan therefore uses:

- migration syntax review,
- route-level smoke checks where possible,
- `npm run build`,
- one system test through Feishu callback fixtures and the settings UI,
- no new automated test files.

Feishu docs checked while writing this plan:

- Bot capability overview: https://open.feishu.cn/document/client-docs/bot-v3/bot-overview?lang=zh-CN
- Card callback: https://open.feishu.cn/document/feishu-cards/card-callback-communication?lang=zh-CN
- Card interaction config: https://open.feishu.cn/document/feishu-cards/configuring-card-interactions?lang=zh-CN
- Bitable documentation index: https://open.feishu.cn/document?lang=zh-CN

Before executing Task 2, re-open the official Feishu pages above and confirm the exact SDK method names and callback payload shape for the installed `@larksuiteoapi/node-sdk` version.

## File Structure

Create:

- `supabase/migrations/2026-06-08-requirement-bot.sql`  
  Tables, indexes, constraints, and RLS policies for requirement workflow data.

- `lib/repositories/requirement.repository.js`  
  All CRUD for requirements, events, attachments, Feishu users, settings, reminders, and Bitable sync state.

- `src/requirement-constants.js`  
  Status, action, priority, template, and role constants shared by services and routes.

- `src/requirement-state.service.js`  
  Pure transition logic: validate actor role, compute next status/current owner, write status history.

- `src/requirement-draft.service.js`  
  AI classification and PRD generation through `src/llm-client.js`.

- `src/feishu-app.service.js`  
  Feishu app client, token handling, signature/challenge verification, message/card send/update helpers, Bitable helpers.

- `src/requirement-card.service.js`  
  Card JSON builders for draft, PM confirmation, execution, reminder, and closed cards.

- `src/requirement-reminder.service.js`  
  Finds due/overdue/stale/P0/P1 requirements and sends reminder cards.

- `src/requirement-bitable.service.js`  
  One-way create/update sync to Feishu Bitable.

- `app/api/feishu/requirements/events/route.js`  
  Feishu message event receiver for @bot submissions and follow-up text changes.

- `app/api/feishu/requirements/cards/route.js`  
  Feishu card action callback receiver.

- `app/api/requirements/route.js`  
  Internal archive list endpoint.

- `app/api/requirements/[id]/route.js`  
  Internal archive detail endpoint.

- `app/api/requirements/[id]/sync-bitable/route.js`  
  Manual Bitable retry endpoint.

- `app/api/settings/requirement-bot/route.js`  
  Requirement bot settings endpoint.

- `app/api/cron/requirements-reminders/route.js`  
  Reminder cron entrypoint.

- `app/(app)/settings/requirement-bot/page.js` and `app/(app)/settings/requirement-bot/page.module.css`  
  Settings page for Feishu app and Bitable configuration.

Modify:

- `src/config.js`  
  Add Feishu app configuration values.

- `app/components/Sidebar/Sidebar.js` and `app/components/Sidebar/Sidebar.module.css`  
  Add the requirement bot settings link only.

- `lib/prefetch-keys.js`  
  Add fetchers/cache keys for requirement bot settings only.

- `.claude/index/MAP.md`, `.claude/index/glossary.md`, `.claude/index/routes.md`, `.claude/index/schema.md`  
  Refresh/update after routes and schema are implemented.

Do not modify:

- Existing webhook-only notification flow except where settings copy must distinguish “custom notification webhook” from “application requirement bot.”

---

### Task 1: Database Schema and Repository

**Files:**
- Create: `supabase/migrations/2026-06-08-requirement-bot.sql`
- Create: `src/requirement-constants.js`
- Create: `lib/repositories/requirement.repository.js`

- [ ] **Step 1: Create constants**

Create `src/requirement-constants.js`:

```js
export const REQUIREMENT_STATUSES = {
  NEEDS_PM: 'needs_pm',
  NEEDS_INFO: 'needs_info',
  READY_FOR_DEV: 'ready_for_dev',
  IN_DEV: 'in_dev',
  READY_FOR_TEST: 'ready_for_test',
  IN_TEST: 'in_test',
  READY_FOR_ACCEPTANCE: 'ready_for_acceptance',
  CLOSED: 'closed',
  REJECTED: 'rejected',
};

export const REQUIREMENT_PRIORITIES = {
  P0: 'P0',
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
};

export const REQUIREMENT_TYPES = {
  INCIDENT: 'incident',
  IMPROVEMENT: 'improvement',
  FEATURE: 'feature',
  DATA_REPORT: 'data_report',
  OTHER: 'other',
};

export const PRD_TEMPLATE_TYPES = {
  LIGHT: 'light',
  STANDARD: 'standard',
};

export const REQUIREMENT_ROLES = {
  SUBMITTER: 'submitter',
  PM: 'pm',
  DEVELOPER: 'developer',
  TESTER: 'tester',
  ACCEPTOR: 'acceptor',
  ADMIN: 'admin',
};

export const REQUIREMENT_ACTIONS = {
  CREATE_FROM_FEISHU: 'create_from_feishu',
  GENERATE_PLAN: 'generate_plan',
  CONFIRM_PLAN: 'confirm_plan',
  UPDATE_PLAN: 'update_plan',
  UPDATE_PRIORITY: 'update_priority',
  UPDATE_OWNERS: 'update_owners',
  UPDATE_SCHEDULE: 'update_schedule',
  REQUEST_INFO: 'request_info',
  START_DEV: 'start_dev',
  SUBMIT_TEST: 'submit_test',
  START_TEST: 'start_test',
  PASS_TEST: 'pass_test',
  REJECT_TEST: 'reject_test',
  ACCEPT_AND_CLOSE: 'accept_and_close',
  REJECT_ACCEPTANCE: 'reject_acceptance',
  BLOCK: 'block',
  EXTEND_DEADLINE: 'extend_deadline',
  REJECT_AS_INVALID: 'reject_as_invalid',
};

export const CURRENT_OWNER_BY_STATUS = {
  [REQUIREMENT_STATUSES.NEEDS_PM]: 'pm_owner_feishu_user_id',
  [REQUIREMENT_STATUSES.NEEDS_INFO]: 'submitter_feishu_user_id',
  [REQUIREMENT_STATUSES.READY_FOR_DEV]: 'developer_feishu_user_id',
  [REQUIREMENT_STATUSES.IN_DEV]: 'developer_feishu_user_id',
  [REQUIREMENT_STATUSES.READY_FOR_TEST]: 'tester_feishu_user_id',
  [REQUIREMENT_STATUSES.IN_TEST]: 'tester_feishu_user_id',
  [REQUIREMENT_STATUSES.READY_FOR_ACCEPTANCE]: 'acceptor_feishu_user_id',
};
```

- [ ] **Step 2: Create migration**

Create `supabase/migrations/2026-06-08-requirement-bot.sql`:

```sql
create table if not exists requirement_bot_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  feishu_app_id text,
  feishu_app_secret_encrypted text,
  feishu_encrypt_key_encrypted text,
  feishu_verification_token_encrypted text,
  default_chat_id text,
  default_pm_feishu_user_id text,
  default_developer_feishu_user_id text,
  default_tester_feishu_user_id text,
  default_acceptor_feishu_user_id text,
  bitable_app_token text,
  bitable_table_id text,
  reminder_hour integer not null default 10 check (reminder_hour between 0 and 23),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists requirement_feishu_users (
  tenant_id uuid not null references tenants(id) on delete cascade,
  feishu_user_id text not null,
  name text,
  email text,
  avatar_url text,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, feishu_user_id)
);

create table if not exists requirements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  req_no text not null,
  title text not null,
  raw_description text not null,
  status text not null default 'needs_pm',
  requirement_type text not null default 'other',
  prd_template_type text not null default 'light',
  priority text not null default 'P2',
  priority_reason text,
  submitter_feishu_user_id text not null,
  pm_owner_feishu_user_id text,
  developer_feishu_user_id text,
  tester_feishu_user_id text,
  acceptor_feishu_user_id text,
  current_owner_feishu_user_id text,
  feishu_chat_id text,
  feishu_root_message_id text,
  feishu_card_message_id text,
  feishu_message_url text,
  feishu_card_url text,
  bitable_record_id text,
  bitable_sync_status text not null default 'pending',
  bitable_last_error text,
  ai_confidence numeric(4,3),
  ai_raw_output jsonb not null default '{}'::jsonb,
  prd jsonb not null default '{}'::jsonb,
  pm_due_at timestamptz,
  dev_due_at timestamptz,
  test_due_at timestamptz,
  acceptance_due_at timestamptz,
  planned_release_at timestamptz,
  actual_release_at timestamptz,
  closed_at timestamptz,
  blocked_reason text,
  latest_rejection_reason text,
  last_status_changed_at timestamptz not null default now(),
  last_reminded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, req_no)
);

create table if not exists requirement_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  requirement_id uuid not null references requirements(id) on delete cascade,
  actor_feishu_user_id text,
  action text not null,
  from_status text,
  to_status text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists requirement_attachments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  requirement_id uuid not null references requirements(id) on delete cascade,
  event_id uuid references requirement_events(id) on delete set null,
  kind text not null,
  feishu_file_key text,
  url text,
  title text,
  created_by_feishu_user_id text,
  created_at timestamptz not null default now()
);

create table if not exists requirement_reminder_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  requirement_id uuid not null references requirements(id) on delete cascade,
  reminder_type text not null,
  target_feishu_user_id text,
  sent_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);

create sequence if not exists requirement_req_no_seq;

create index if not exists idx_requirements_tenant_status on requirements (tenant_id, status, updated_at desc);
create index if not exists idx_requirements_tenant_priority on requirements (tenant_id, priority, updated_at desc);
create index if not exists idx_requirements_current_owner on requirements (tenant_id, current_owner_feishu_user_id, status);
create index if not exists idx_requirements_due on requirements (tenant_id, status, dev_due_at, test_due_at, acceptance_due_at);
create index if not exists idx_requirement_events_requirement on requirement_events (tenant_id, requirement_id, created_at desc);
create index if not exists idx_requirement_attachments_requirement on requirement_attachments (tenant_id, requirement_id, created_at desc);

alter table requirement_bot_settings enable row level security;
alter table requirement_feishu_users enable row level security;
alter table requirements enable row level security;
alter table requirement_events enable row level security;
alter table requirement_attachments enable row level security;
alter table requirement_reminder_logs enable row level security;

create policy requirement_bot_settings_tenant_select on requirement_bot_settings
  for select using (tenant_id in (select tenant_id from users where id = auth.uid()));
create policy requirement_bot_settings_tenant_write on requirement_bot_settings
  for all using (tenant_id in (select tenant_id from users where id = auth.uid()))
  with check (tenant_id in (select tenant_id from users where id = auth.uid()));

create policy requirement_feishu_users_tenant_select on requirement_feishu_users
  for select using (tenant_id in (select tenant_id from users where id = auth.uid()));
create policy requirement_feishu_users_tenant_write on requirement_feishu_users
  for all using (tenant_id in (select tenant_id from users where id = auth.uid()))
  with check (tenant_id in (select tenant_id from users where id = auth.uid()));

create policy requirements_tenant_select on requirements
  for select using (tenant_id in (select tenant_id from users where id = auth.uid()));
create policy requirements_tenant_write on requirements
  for all using (tenant_id in (select tenant_id from users where id = auth.uid()))
  with check (tenant_id in (select tenant_id from users where id = auth.uid()));

create policy requirement_events_tenant_select on requirement_events
  for select using (tenant_id in (select tenant_id from users where id = auth.uid()));
create policy requirement_events_tenant_write on requirement_events
  for all using (tenant_id in (select tenant_id from users where id = auth.uid()))
  with check (tenant_id in (select tenant_id from users where id = auth.uid()));

create policy requirement_attachments_tenant_select on requirement_attachments
  for select using (tenant_id in (select tenant_id from users where id = auth.uid()));
create policy requirement_attachments_tenant_write on requirement_attachments
  for all using (tenant_id in (select tenant_id from users where id = auth.uid()))
  with check (tenant_id in (select tenant_id from users where id = auth.uid()));

create policy requirement_reminder_logs_tenant_select on requirement_reminder_logs
  for select using (tenant_id in (select tenant_id from users where id = auth.uid()));
create policy requirement_reminder_logs_tenant_write on requirement_reminder_logs
  for all using (tenant_id in (select tenant_id from users where id = auth.uid()))
  with check (tenant_id in (select tenant_id from users where id = auth.uid()));
```

- [ ] **Step 3: Create repository**

Create `lib/repositories/requirement.repository.js` with these exports:

```js
import supabase from '../supabase.js';
import { encryptToken, decryptToken } from '../meta-token-crypto.js';

export async function getRequirementBotSettings(tenantId, { includeSecrets = false } = {}) {
  const { data, error } = await supabase
    .from('requirement_bot_settings')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  if (!data || !includeSecrets) return data || null;
  return {
    ...data,
    feishu_app_secret: data.feishu_app_secret_encrypted ? decryptToken(data.feishu_app_secret_encrypted) : '',
    feishu_encrypt_key: data.feishu_encrypt_key_encrypted ? decryptToken(data.feishu_encrypt_key_encrypted) : '',
    feishu_verification_token: data.feishu_verification_token_encrypted ? decryptToken(data.feishu_verification_token_encrypted) : '',
  };
}

export async function saveRequirementBotSettings(tenantId, input) {
  const row = {
    tenant_id: tenantId,
    feishu_app_id: input.feishu_app_id || null,
    default_chat_id: input.default_chat_id || null,
    default_pm_feishu_user_id: input.default_pm_feishu_user_id || null,
    default_developer_feishu_user_id: input.default_developer_feishu_user_id || null,
    default_tester_feishu_user_id: input.default_tester_feishu_user_id || null,
    default_acceptor_feishu_user_id: input.default_acceptor_feishu_user_id || null,
    bitable_app_token: input.bitable_app_token || null,
    bitable_table_id: input.bitable_table_id || null,
    reminder_hour: Number.isInteger(input.reminder_hour) ? input.reminder_hour : 10,
    enabled: Boolean(input.enabled),
    updated_at: new Date().toISOString(),
  };
  if (input.feishu_app_secret) row.feishu_app_secret_encrypted = encryptToken(input.feishu_app_secret);
  if (input.feishu_encrypt_key) row.feishu_encrypt_key_encrypted = encryptToken(input.feishu_encrypt_key);
  if (input.feishu_verification_token) row.feishu_verification_token_encrypted = encryptToken(input.feishu_verification_token);
  const { data, error } = await supabase
    .from('requirement_bot_settings')
    .upsert(row, { onConflict: 'tenant_id' })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function nextRequirementNo() {
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const { data, error } = await supabase.rpc('nextval', { sequence_name: 'requirement_req_no_seq' });
  if (error) throw error;
  return `REQ-${yyyymm}-${String(data).padStart(4, '0')}`;
}

export async function createRequirement(row) {
  const { data, error } = await supabase.from('requirements').insert(row).select('*').single();
  if (error) throw error;
  return data;
}

export async function getRequirementById({ tenantId, id }) {
  const { data, error } = await supabase
    .from('requirements')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function listRequirements({ tenantId, filters = {}, limit = 100 }) {
  let query = supabase.from('requirements').select('*').eq('tenant_id', tenantId);
  if (filters.status) query = query.eq('status', filters.status);
  if (filters.priority) query = query.eq('priority', filters.priority);
  if (filters.current_owner) query = query.eq('current_owner_feishu_user_id', filters.current_owner);
  if (filters.requirement_type) query = query.eq('requirement_type', filters.requirement_type);
  const { data, error } = await query.order('updated_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return data || [];
}

export async function updateRequirement({ tenantId, id, patch }) {
  const { data, error } = await supabase
    .from('requirements')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function addRequirementEvent({ tenantId, requirementId, actorFeishuUserId, action, fromStatus, toStatus, details = {} }) {
  const { data, error } = await supabase
    .from('requirement_events')
    .insert({
      tenant_id: tenantId,
      requirement_id: requirementId,
      actor_feishu_user_id: actorFeishuUserId || null,
      action,
      from_status: fromStatus || null,
      to_status: toStatus || null,
      details,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function listRequirementEvents({ tenantId, requirementId }) {
  const { data, error } = await supabase
    .from('requirement_events')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('requirement_id', requirementId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function addRequirementAttachment(row) {
  const { data, error } = await supabase.from('requirement_attachments').insert(row).select('*').single();
  if (error) throw error;
  return data;
}

export async function listRequirementAttachments({ tenantId, requirementId }) {
  const { data, error } = await supabase
    .from('requirement_attachments')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('requirement_id', requirementId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function listRequirementsForReminder({ tenantId, nowIso }) {
  const { data, error } = await supabase
    .from('requirements')
    .select('*')
    .eq('tenant_id', tenantId)
    .not('status', 'in', '("closed","rejected")')
    .order('updated_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function recordRequirementReminder(row) {
  const { error } = await supabase.from('requirement_reminder_logs').insert(row);
  if (error) throw error;
}
```

During execution, if Supabase rejects `rpc('nextval')`, replace it with a SQL function in the migration:

```sql
create or replace function next_requirement_req_no()
returns bigint
language sql
as $$
  select nextval('requirement_req_no_seq');
$$;
```

and call `supabase.rpc('next_requirement_req_no')`.

- [ ] **Step 4: Verify migration and repository import**

Run:

```bash
npm run build
```

Expected: build may fail later due to unrelated environment requirements, but it must not fail with syntax errors in the new constants or repository files. If it fails on missing Supabase schema locally, note that migration must be applied before runtime testing.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-06-08-requirement-bot.sql src/requirement-constants.js lib/repositories/requirement.repository.js
git commit -m "feat(requirements): add workflow schema and repository"
```

---

### Task 2: Feishu App Client and Settings API

**Files:**
- Modify: `src/config.js`
- Create: `src/feishu-app.service.js`
- Create: `app/api/settings/requirement-bot/route.js`
- Create: `app/(app)/settings/requirement-bot/page.js`
- Create: `app/(app)/settings/requirement-bot/page.module.css`
- Modify: `lib/prefetch-keys.js`

- [ ] **Step 1: Add config keys**

Modify `src/config.js` so it exposes default Feishu callback values only from the config module. Follow the existing config style and add:

```js
feishu: {
  requirementBotCallbackTenantId: process.env.FEISHU_REQUIREMENT_BOT_CALLBACK_TENANT_ID || '',
}
```

This tenant id maps inbound Feishu events to the internal tenant for first version. Later versions can resolve by installed app tenant key.

- [ ] **Step 2: Create Feishu service shell**

Create `src/feishu-app.service.js`:

```js
import * as lark from '@larksuiteoapi/node-sdk';
import { getRequirementBotSettings } from '../lib/repositories/requirement.repository.js';
import { config } from './config.js';

export async function getRequirementBotClient(tenantId) {
  const settings = await getRequirementBotSettings(tenantId, { includeSecrets: true });
  if (!settings?.enabled || !settings.feishu_app_id || !settings.feishu_app_secret) {
    throw new Error('Requirement bot is not configured');
  }
  return new lark.Client({
    appId: settings.feishu_app_id,
    appSecret: settings.feishu_app_secret,
    disableTokenCache: false,
  });
}

export function resolveRequirementBotTenantId() {
  if (!config.feishu.requirementBotCallbackTenantId) {
    throw new Error('FEISHU_REQUIREMENT_BOT_CALLBACK_TENANT_ID is required');
  }
  return config.feishu.requirementBotCallbackTenantId;
}

export function normalizeFeishuUserId(eventUser = {}) {
  return eventUser.open_id || eventUser.user_id || eventUser.union_id || '';
}

export function parseFeishuTextMessage(message = {}) {
  const raw = message.content || '{}';
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  return String(parsed.text || '').replace(/@\S+\s*/g, '').trim();
}

export async function sendFeishuCard({ tenantId, receiveIdType = 'chat_id', receiveId, card }) {
  const client = await getRequirementBotClient(tenantId);
  const res = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  });
  return res?.data || res;
}

export async function replyFeishuText({ tenantId, messageId, content }) {
  const client = await getRequirementBotClient(tenantId);
  const res = await client.im.message.reply({
    path: { message_id: messageId },
    data: {
      msg_type: 'text',
      content: JSON.stringify({ text: content }),
    },
  });
  return res?.data || res;
}

export async function updateFeishuCard({ tenantId, messageId, card }) {
  const client = await getRequirementBotClient(tenantId);
  const res = await client.im.message.update({
    path: { message_id: messageId },
    data: {
      msg_type: 'interactive',
      content: JSON.stringify(card),
    },
  });
  return res?.data || res;
}
```

If SDK method names differ in the installed version, inspect `node_modules/@larksuiteoapi/node-sdk` and adjust while keeping these exported function names stable.

- [ ] **Step 3: Create settings API**

Create `app/api/settings/requirement-bot/route.js`:

```js
import { getTenantContext } from '@/lib/tenant-context';
import { getRequirementBotSettings, saveRequirementBotSettings } from '@/lib/repositories/requirement.repository';
import { recordAudit } from '@/lib/repositories/audit-log.repository';

export async function GET() {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const row = await getRequirementBotSettings(ctx.tenantId);
  return Response.json({
    data: row ? {
      enabled: row.enabled,
      feishu_app_id: row.feishu_app_id || '',
      default_chat_id: row.default_chat_id || '',
      default_pm_feishu_user_id: row.default_pm_feishu_user_id || '',
      default_developer_feishu_user_id: row.default_developer_feishu_user_id || '',
      default_tester_feishu_user_id: row.default_tester_feishu_user_id || '',
      default_acceptor_feishu_user_id: row.default_acceptor_feishu_user_id || '',
      bitable_app_token: row.bitable_app_token || '',
      bitable_table_id: row.bitable_table_id || '',
      reminder_hour: row.reminder_hour,
      has_secret: Boolean(row.feishu_app_secret_encrypted),
      has_encrypt_key: Boolean(row.feishu_encrypt_key_encrypted),
      has_verification_token: Boolean(row.feishu_verification_token_encrypted),
    } : null,
  });
}

export async function POST(request) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json();
  const reminderHour = Number(body.reminder_hour ?? 10);
  if (!Number.isInteger(reminderHour) || reminderHour < 0 || reminderHour > 23) {
    return Response.json({ error: 'reminder_hour must be an integer from 0 to 23' }, { status: 400 });
  }
  const saved = await saveRequirementBotSettings(ctx.tenantId, {
    feishu_app_id: String(body.feishu_app_id || '').trim(),
    feishu_app_secret: String(body.feishu_app_secret || '').trim(),
    feishu_encrypt_key: String(body.feishu_encrypt_key || '').trim(),
    feishu_verification_token: String(body.feishu_verification_token || '').trim(),
    default_chat_id: String(body.default_chat_id || '').trim(),
    default_pm_feishu_user_id: String(body.default_pm_feishu_user_id || '').trim(),
    default_developer_feishu_user_id: String(body.default_developer_feishu_user_id || '').trim(),
    default_tester_feishu_user_id: String(body.default_tester_feishu_user_id || '').trim(),
    default_acceptor_feishu_user_id: String(body.default_acceptor_feishu_user_id || '').trim(),
    bitable_app_token: String(body.bitable_app_token || '').trim(),
    bitable_table_id: String(body.bitable_table_id || '').trim(),
    reminder_hour: reminderHour,
    enabled: Boolean(body.enabled),
  });
  await recordAudit({
    tenantId: ctx.tenantId,
    actorUserId: ctx.user.id,
    actorEmail: ctx.user.email,
    action: 'requirement_bot.settings.saved',
    details: { enabled: saved.enabled },
  });
  return Response.json({ success: true });
}
```

- [ ] **Step 4: Create settings page**

Create a compact settings page with fields matching the API. Keep copy clear that this is a Feishu application bot, separate from the existing custom notification webhook.

Use `app/(app)/settings/notifications/page.js` as the style reference, but do not modify that page in this task.

- [ ] **Step 5: Add prefetch keys**

Modify `lib/prefetch-keys.js` to add:

```js
REQUIREMENT_BOT_SETTINGS: 'settings.requirementBot',
```

and a fetcher:

```js
[KEYS.REQUIREMENT_BOT_SETTINGS]: () => fetch('/api/settings/requirement-bot').then(r => r.json()),
```

Match the exact file's current object shape.

- [ ] **Step 6: Verify and commit**

Run:

```bash
npm run build
```

Expected: no syntax/import errors from new settings route/page/service.

Commit:

```bash
git add src/config.js src/feishu-app.service.js app/api/settings/requirement-bot/route.js 'app/(app)/settings/requirement-bot' lib/prefetch-keys.js
git commit -m "feat(requirements): add feishu app settings"
```

---

### Task 3: AI Draft Generation

**Files:**
- Create: `src/requirement-draft.service.js`
- Modify: `lib/repositories/requirement.repository.js`

- [ ] **Step 1: Add repository helper for creation from Feishu**

Add:

```js
export async function createRequirementWithEvent({ tenantId, requirement, event }) {
  const created = await createRequirement(requirement);
  await addRequirementEvent({
    tenantId,
    requirementId: created.id,
    actorFeishuUserId: event.actorFeishuUserId,
    action: event.action,
    fromStatus: null,
    toStatus: created.status,
    details: event.details || {},
  });
  return created;
}
```

- [ ] **Step 2: Create draft service**

Create `src/requirement-draft.service.js`:

```js
import { openrouter, MODELS } from './llm-client.js';
import {
  PRD_TEMPLATE_TYPES,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_STATUSES,
  REQUIREMENT_TYPES,
} from './requirement-constants.js';

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI did not return JSON');
  return JSON.parse(match[0]);
}

function normalizeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

export async function generateRequirementDraft({ tenantId, rawDescription, submitterName }) {
  const system = [
    '你是公司内部产品经理，负责把飞书群里的问题描述整理为可执行需求。',
    '只输出 JSON，不要输出 markdown。',
    '线上问题/小优化使用 light 模板；新功能/跨模块/复杂数据报表使用 standard 模板。',
  ].join('\n');
  const user = JSON.stringify({
    raw_description: rawDescription,
    submitter: submitterName || '',
    output_schema: {
      title: 'string',
      requirement_type: Object.values(REQUIREMENT_TYPES),
      prd_template_type: Object.values(PRD_TEMPLATE_TYPES),
      priority: Object.values(REQUIREMENT_PRIORITIES),
      priority_reason: 'string',
      ai_confidence: 'number 0-1',
      missing_info: ['string'],
      prd: {
        background_problem: 'string',
        user_impact: 'string',
        goal: 'string',
        solution: 'string',
        scope_boundary: 'string',
        acceptance_criteria: ['string'],
        risk_dependency: 'string',
        rollback_plan: 'string',
        observability: 'string',
      },
      suggested_schedule: {
        pm_hours: 'number',
        dev_hours: 'number',
        test_hours: 'number',
        acceptance_hours: 'number',
      },
    },
  });
  const started = Date.now();
  const response = await openrouter.chat.completions.create({
    model: MODELS.HAIKU,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
  }, {
    tenantId,
    callSite: 'requirement-draft.generate',
    startedAt: started,
  });
  const content = response?.choices?.[0]?.message?.content || '';
  const parsed = parseJsonObject(content);
  return {
    title: String(parsed.title || '未命名需求').slice(0, 120),
    requirement_type: normalizeEnum(parsed.requirement_type, Object.values(REQUIREMENT_TYPES), REQUIREMENT_TYPES.OTHER),
    prd_template_type: normalizeEnum(parsed.prd_template_type, Object.values(PRD_TEMPLATE_TYPES), PRD_TEMPLATE_TYPES.LIGHT),
    priority: normalizeEnum(parsed.priority, Object.values(REQUIREMENT_PRIORITIES), REQUIREMENT_PRIORITIES.P2),
    priority_reason: String(parsed.priority_reason || ''),
    ai_confidence: Math.max(0, Math.min(1, Number(parsed.ai_confidence ?? 0.5))),
    missing_info: Array.isArray(parsed.missing_info) ? parsed.missing_info.map(String).filter(Boolean) : [],
    prd: parsed.prd && typeof parsed.prd === 'object' ? parsed.prd : {},
    suggested_schedule: parsed.suggested_schedule && typeof parsed.suggested_schedule === 'object' ? parsed.suggested_schedule : {},
    ai_raw_output: parsed,
  };
}

export function computeDraftInitialStatus(draft) {
  if (draft.missing_info?.length || draft.ai_confidence < 0.45) return REQUIREMENT_STATUSES.NEEDS_INFO;
  return REQUIREMENT_STATUSES.NEEDS_PM;
}
```

If `openrouter.chat.completions.create` signature differs, inspect existing `src/agents/ogilvy` calls and adjust to the local `llm-client.js` API while preserving the exported function names.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm run build
```

Expected: no import or syntax errors in draft service.

Commit:

```bash
git add src/requirement-draft.service.js lib/repositories/requirement.repository.js
git commit -m "feat(requirements): generate ai requirement drafts"
```

---

### Task 4: Feishu Message Event Receiver

**Files:**
- Create: `app/api/feishu/requirements/events/route.js`
- Modify: `src/feishu-app.service.js`
- Create: `src/requirement-card.service.js`

- [ ] **Step 1: Build initial card service**

Create `src/requirement-card.service.js`:

```js
import { REQUIREMENT_STATUSES } from './requirement-constants.js';

function text(content) {
  return { tag: 'div', text: { tag: 'lark_md', content: String(content || '-') } };
}

function actionButton(textLabel, action, requirementId, type = 'default') {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: textLabel },
    type,
    value: { action, requirement_id: requirementId },
  };
}

export function buildRequirementDraftCard(requirement) {
  const missing = Array.isArray(requirement.ai_raw_output?.missing_info)
    ? requirement.ai_raw_output.missing_info
    : [];
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `${requirement.req_no} ${requirement.title}` },
      template: requirement.status === REQUIREMENT_STATUSES.NEEDS_INFO ? 'orange' : 'blue',
    },
    elements: [
      text(`**状态**：${requirement.status}`),
      text(`**优先级**：${requirement.priority}｜${requirement.priority_reason || '-'}`),
      text(`**原始描述**：${requirement.raw_description}`),
      text(`**AI 方案**：${requirement.prd?.solution || '-'}`),
      text(`**验收标准**：${Array.isArray(requirement.prd?.acceptance_criteria) ? requirement.prd.acceptance_criteria.join('\\n') : '-'}`),
      ...(missing.length ? [text(`**需补充**：${missing.join('；')}`)] : []),
      {
        tag: 'action',
        actions: [
          actionButton('生成/刷新方案', 'generate_plan', requirement.id),
          actionButton('确认方案', 'confirm_plan', requirement.id, 'primary'),
          actionButton('打回补充', 'request_info', requirement.id),
          actionButton('先不处理', 'reject_as_invalid', requirement.id, 'danger'),
        ],
      },
    ],
  };
}

export function buildSimpleNoticeCard({ title, lines = [] }) {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title }, template: 'blue' },
    elements: lines.map(line => text(line)),
  };
}
```

- [ ] **Step 2: Add callback verification helper**

Modify `src/feishu-app.service.js`:

```js
export function handleFeishuUrlVerification(body) {
  if (body?.type === 'url_verification' && body?.challenge) {
    return { challenge: body.challenge };
  }
  return null;
}
```

Keep encryption/signature verification minimal in first pass if Feishu app is configured without encrypted callbacks. If encrypted callbacks are enabled, add official SDK decrypt handling before parsing the event.

- [ ] **Step 3: Create event route**

Create `app/api/feishu/requirements/events/route.js`:

```js
import { resolveRequirementBotTenantId, handleFeishuUrlVerification, normalizeFeishuUserId, parseFeishuTextMessage, sendFeishuCard, replyFeishuText } from '@/src/feishu-app.service';
import { generateRequirementDraft, computeDraftInitialStatus } from '@/src/requirement-draft.service';
import { buildRequirementDraftCard } from '@/src/requirement-card.service';
import { REQUIREMENT_ACTIONS, CURRENT_OWNER_BY_STATUS } from '@/src/requirement-constants';
import { createRequirementWithEvent, getRequirementBotSettings, nextRequirementNo, updateRequirement } from '@/lib/repositories/requirement.repository';

function addHours(hours) {
  const d = new Date();
  d.setHours(d.getHours() + Number(hours || 0));
  return d.toISOString();
}

export async function POST(request) {
  const body = await request.json();
  const verification = handleFeishuUrlVerification(body);
  if (verification) return Response.json(verification);

  const tenantId = resolveRequirementBotTenantId();
  const event = body?.event || body?.event_callback?.event || {};
  const message = event.message || {};
  const sender = event.sender || {};
  const rawText = parseFeishuTextMessage(message);
  if (!rawText) return Response.json({ ok: true, skipped: 'empty_text' });

  const settings = await getRequirementBotSettings(tenantId);
  const submitter = normalizeFeishuUserId(sender.sender_id || sender);
  const draft = await generateRequirementDraft({ tenantId, rawDescription: rawText, submitterName: submitter });
  const status = computeDraftInitialStatus(draft);
  const reqNo = await nextRequirementNo();
  const currentOwnerField = CURRENT_OWNER_BY_STATUS[status];
  const currentOwner = currentOwnerField === 'submitter_feishu_user_id'
    ? submitter
    : settings?.default_pm_feishu_user_id || null;

  const requirement = await createRequirementWithEvent({
    tenantId,
    requirement: {
      tenant_id: tenantId,
      req_no: reqNo,
      title: draft.title,
      raw_description: rawText,
      status,
      requirement_type: draft.requirement_type,
      prd_template_type: draft.prd_template_type,
      priority: draft.priority,
      priority_reason: draft.priority_reason,
      submitter_feishu_user_id: submitter,
      pm_owner_feishu_user_id: settings?.default_pm_feishu_user_id || null,
      developer_feishu_user_id: settings?.default_developer_feishu_user_id || null,
      tester_feishu_user_id: settings?.default_tester_feishu_user_id || null,
      acceptor_feishu_user_id: settings?.default_acceptor_feishu_user_id || null,
      current_owner_feishu_user_id: currentOwner,
      feishu_chat_id: message.chat_id || settings?.default_chat_id || null,
      feishu_root_message_id: message.message_id || null,
      ai_confidence: draft.ai_confidence,
      ai_raw_output: draft.ai_raw_output,
      prd: draft.prd,
      pm_due_at: addHours(draft.suggested_schedule.pm_hours || 24),
      dev_due_at: addHours(draft.suggested_schedule.dev_hours || 72),
      test_due_at: addHours(draft.suggested_schedule.test_hours || 96),
      acceptance_due_at: addHours(draft.suggested_schedule.acceptance_hours || 120),
    },
    event: {
      actorFeishuUserId: submitter,
      action: REQUIREMENT_ACTIONS.CREATE_FROM_FEISHU,
      details: { message_id: message.message_id, chat_id: message.chat_id },
    },
  });

  const cardResult = await sendFeishuCard({
    tenantId,
    receiveId: requirement.feishu_chat_id,
    card: buildRequirementDraftCard(requirement),
  });
  const messageId = cardResult?.message_id || cardResult?.data?.message_id || null;
  if (messageId) {
    await updateRequirement({
      tenantId,
      id: requirement.id,
      patch: { feishu_card_message_id: messageId },
    });
  }
  if (status === 'needs_info') {
    await replyFeishuText({
      tenantId,
      messageId: message.message_id,
      content: `需求 ${requirement.req_no} 已记录，但信息还不够，请补充后 @机器人继续说明。`,
    });
  }
  return Response.json({ ok: true, requirement_id: requirement.id });
}
```

- [ ] **Step 4: Verify with URL verification fixture**

Run local server, then:

```bash
curl -s -X POST http://localhost:3000/api/feishu/requirements/events \
  -H 'Content-Type: application/json' \
  -d '{"type":"url_verification","challenge":"abc"}'
```

Expected:

```json
{"challenge":"abc"}
```

- [ ] **Step 5: Commit**

```bash
git add app/api/feishu/requirements/events/route.js src/feishu-app.service.js src/requirement-card.service.js
git commit -m "feat(requirements): receive feishu submissions"
```

---

### Task 5: State Machine and Card Callback Route

**Files:**
- Create: `src/requirement-state.service.js`
- Modify: `src/requirement-card.service.js`
- Create: `app/api/feishu/requirements/cards/route.js`

- [ ] **Step 1: Create state transition service**

Create `src/requirement-state.service.js`:

```js
import { CURRENT_OWNER_BY_STATUS, REQUIREMENT_ACTIONS, REQUIREMENT_STATUSES } from './requirement-constants.js';
import { addRequirementEvent, updateRequirement } from '../lib/repositories/requirement.repository.js';

const TRANSITIONS = {
  [REQUIREMENT_ACTIONS.CONFIRM_PLAN]: { from: [REQUIREMENT_STATUSES.NEEDS_PM], to: REQUIREMENT_STATUSES.READY_FOR_DEV, actorField: 'pm_owner_feishu_user_id' },
  [REQUIREMENT_ACTIONS.START_DEV]: { from: [REQUIREMENT_STATUSES.READY_FOR_DEV], to: REQUIREMENT_STATUSES.IN_DEV, actorField: 'developer_feishu_user_id' },
  [REQUIREMENT_ACTIONS.SUBMIT_TEST]: { from: [REQUIREMENT_STATUSES.IN_DEV, REQUIREMENT_STATUSES.READY_FOR_DEV], to: REQUIREMENT_STATUSES.READY_FOR_TEST, actorField: 'developer_feishu_user_id' },
  [REQUIREMENT_ACTIONS.START_TEST]: { from: [REQUIREMENT_STATUSES.READY_FOR_TEST], to: REQUIREMENT_STATUSES.IN_TEST, actorField: 'tester_feishu_user_id' },
  [REQUIREMENT_ACTIONS.PASS_TEST]: { from: [REQUIREMENT_STATUSES.IN_TEST], to: REQUIREMENT_STATUSES.READY_FOR_ACCEPTANCE, actorField: 'tester_feishu_user_id' },
  [REQUIREMENT_ACTIONS.REJECT_TEST]: { from: [REQUIREMENT_STATUSES.IN_TEST, REQUIREMENT_STATUSES.READY_FOR_TEST], to: REQUIREMENT_STATUSES.IN_DEV, actorField: 'tester_feishu_user_id' },
  [REQUIREMENT_ACTIONS.ACCEPT_AND_CLOSE]: { from: [REQUIREMENT_STATUSES.READY_FOR_ACCEPTANCE], to: REQUIREMENT_STATUSES.CLOSED, actorField: 'acceptor_feishu_user_id' },
  [REQUIREMENT_ACTIONS.REJECT_ACCEPTANCE]: { from: [REQUIREMENT_STATUSES.READY_FOR_ACCEPTANCE], to: REQUIREMENT_STATUSES.IN_DEV, actorField: 'acceptor_feishu_user_id' },
  [REQUIREMENT_ACTIONS.REQUEST_INFO]: { from: [REQUIREMENT_STATUSES.NEEDS_PM], to: REQUIREMENT_STATUSES.NEEDS_INFO, actorField: 'pm_owner_feishu_user_id' },
  [REQUIREMENT_ACTIONS.REJECT_AS_INVALID]: { from: [REQUIREMENT_STATUSES.NEEDS_PM, REQUIREMENT_STATUSES.NEEDS_INFO], to: REQUIREMENT_STATUSES.REJECTED, actorField: 'pm_owner_feishu_user_id' },
};

function assertCanAct(requirement, actorFeishuUserId, actorField) {
  if (!actorField) return;
  const expected = requirement[actorField];
  if (expected && expected !== actorFeishuUserId) {
    throw new Error('你不是当前阶段负责人，不能执行这个操作');
  }
}

function currentOwnerFor(nextStatus, requirement, patch = {}) {
  const field = CURRENT_OWNER_BY_STATUS[nextStatus];
  return field ? (patch[field] || requirement[field] || null) : null;
}

export async function applyRequirementAction({ tenantId, requirement, actorFeishuUserId, action, payload = {} }) {
  const transition = TRANSITIONS[action];
  if (!transition) throw new Error(`Unsupported requirement action: ${action}`);
  if (!transition.from.includes(requirement.status)) {
    throw new Error(`当前状态不能执行这个操作`);
  }
  assertCanAct(requirement, actorFeishuUserId, transition.actorField);

  const now = new Date().toISOString();
  const patch = {
    status: transition.to,
    current_owner_feishu_user_id: currentOwnerFor(transition.to, requirement),
    last_status_changed_at: now,
    blocked_reason: null,
    latest_rejection_reason: payload.reason || null,
    bitable_sync_status: 'pending',
  };
  if (transition.to === REQUIREMENT_STATUSES.CLOSED) {
    patch.closed_at = now;
    patch.actual_release_at = payload.actual_release_at || now;
  }
  if (action === REQUIREMENT_ACTIONS.PASS_TEST && payload.attachment) {
    patch.latest_rejection_reason = null;
  }

  const updated = await updateRequirement({ tenantId, id: requirement.id, patch });
  await addRequirementEvent({
    tenantId,
    requirementId: requirement.id,
    actorFeishuUserId,
    action,
    fromStatus: requirement.status,
    toStatus: transition.to,
    details: payload,
  });
  return updated;
}
```

- [ ] **Step 2: Expand card builder**

Add `buildRequirementExecutionCard(requirement)` to `src/requirement-card.service.js`. It must render action buttons based on `requirement.status`:

```js
export function buildRequirementExecutionCard(requirement) {
  const actionsByStatus = {
    ready_for_dev: [actionButton('开始开发', 'start_dev', requirement.id, 'primary')],
    in_dev: [actionButton('提交测试', 'submit_test', requirement.id, 'primary')],
    ready_for_test: [actionButton('开始测试', 'start_test', requirement.id, 'primary')],
    in_test: [
      actionButton('测试通过', 'pass_test', requirement.id, 'primary'),
      actionButton('测试打回', 'reject_test', requirement.id, 'danger'),
    ],
    ready_for_acceptance: [
      actionButton('验收通过并关闭', 'accept_and_close', requirement.id, 'primary'),
      actionButton('验收打回', 'reject_acceptance', requirement.id, 'danger'),
    ],
  };
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: `${requirement.req_no} ${requirement.title}` }, template: 'green' },
    elements: [
      text(`**状态**：${requirement.status}`),
      text(`**当前负责人**：<at id="${requirement.current_owner_feishu_user_id || ''}"></at>`),
      text(`**方案**：${requirement.prd?.solution || '-'}`),
      text(`**验收标准**：${Array.isArray(requirement.prd?.acceptance_criteria) ? requirement.prd.acceptance_criteria.join('\\n') : '-'}`),
      { tag: 'action', actions: [...(actionsByStatus[requirement.status] || []), actionButton('标记阻塞', 'block', requirement.id), actionButton('申请延期', 'extend_deadline', requirement.id)] },
    ],
  };
}
```

- [ ] **Step 3: Create card callback route**

Create `app/api/feishu/requirements/cards/route.js`:

```js
import { resolveRequirementBotTenantId, handleFeishuUrlVerification, normalizeFeishuUserId, updateFeishuCard } from '@/src/feishu-app.service';
import { buildRequirementExecutionCard, buildRequirementDraftCard } from '@/src/requirement-card.service';
import { applyRequirementAction } from '@/src/requirement-state.service';
import { REQUIREMENT_ACTIONS, REQUIREMENT_STATUSES } from '@/src/requirement-constants';
import { getRequirementById, updateRequirement } from '@/lib/repositories/requirement.repository';

function callbackValue(body) {
  return body?.event?.action?.value || body?.action?.value || {};
}

function callbackUser(body) {
  return normalizeFeishuUserId(body?.event?.operator || body?.operator || body?.event?.user || {});
}

export async function POST(request) {
  const body = await request.json();
  const verification = handleFeishuUrlVerification(body);
  if (verification) return Response.json(verification);

  const tenantId = resolveRequirementBotTenantId();
  const value = callbackValue(body);
  const actorFeishuUserId = callbackUser(body);
  const action = value.action;
  const requirementId = value.requirement_id;
  if (!action || !requirementId) {
    return Response.json({ toast: { type: 'error', content: '卡片参数缺失' } });
  }
  const requirement = await getRequirementById({ tenantId, id: requirementId });
  if (!requirement) {
    return Response.json({ toast: { type: 'error', content: '需求不存在' } });
  }

  try {
    let updated;
    if (action === REQUIREMENT_ACTIONS.BLOCK) {
      updated = await updateRequirement({
        tenantId,
        id: requirement.id,
        patch: { blocked_reason: value.reason || '未填写原因', bitable_sync_status: 'pending' },
      });
    } else if (action === REQUIREMENT_ACTIONS.EXTEND_DEADLINE) {
      updated = await updateRequirement({
        tenantId,
        id: requirement.id,
        patch: { dev_due_at: value.dev_due_at || requirement.dev_due_at, test_due_at: value.test_due_at || requirement.test_due_at, acceptance_due_at: value.acceptance_due_at || requirement.acceptance_due_at, bitable_sync_status: 'pending' },
      });
    } else {
      updated = await applyRequirementAction({
        tenantId,
        requirement,
        actorFeishuUserId,
        action,
        payload: value,
      });
    }

    const card = updated.status === REQUIREMENT_STATUSES.NEEDS_PM || updated.status === REQUIREMENT_STATUSES.NEEDS_INFO
      ? buildRequirementDraftCard(updated)
      : buildRequirementExecutionCard(updated);
    if (updated.feishu_card_message_id) {
      await updateFeishuCard({ tenantId, messageId: updated.feishu_card_message_id, card });
    }
    return Response.json({ toast: { type: 'success', content: '已更新' } });
  } catch (err) {
    return Response.json({ toast: { type: 'error', content: err.message } });
  }
}
```

- [ ] **Step 4: Verify URL challenge**

Run:

```bash
curl -s -X POST http://localhost:3000/api/feishu/requirements/cards \
  -H 'Content-Type: application/json' \
  -d '{"type":"url_verification","challenge":"card-ok"}'
```

Expected:

```json
{"challenge":"card-ok"}
```

- [ ] **Step 5: Commit**

```bash
git add src/requirement-state.service.js src/requirement-card.service.js app/api/feishu/requirements/cards/route.js
git commit -m "feat(requirements): handle feishu card actions"
```

---

### Task 6: Bitable Sync

**Files:**
- Create: `src/requirement-bitable.service.js`
- Create: `app/api/requirements/[id]/sync-bitable/route.js`
- Modify: `app/api/feishu/requirements/cards/route.js`
- Modify: `app/api/feishu/requirements/events/route.js`

- [ ] **Step 1: Create Bitable service**

Create `src/requirement-bitable.service.js`:

```js
import { getRequirementBotClient } from './feishu-app.service.js';
import { getRequirementBotSettings, updateRequirement } from '../lib/repositories/requirement.repository.js';

function requirementToBitableFields(requirement) {
  return {
    '需求编号': requirement.req_no,
    '标题': requirement.title,
    '状态': requirement.status,
    '优先级': requirement.priority,
    'PM': requirement.pm_owner_feishu_user_id || '',
    '开发': requirement.developer_feishu_user_id || '',
    '测试': requirement.tester_feishu_user_id || '',
    '验收人': requirement.acceptor_feishu_user_id || '',
    '当前负责人': requirement.current_owner_feishu_user_id || '',
    '开发截止': requirement.dev_due_at || '',
    '测试截止': requirement.test_due_at || '',
    '验收截止': requirement.acceptance_due_at || '',
    '上线时间': requirement.planned_release_at || '',
    '是否延期': isRequirementOverdue(requirement) ? '是' : '否',
    '当前阻塞': requirement.blocked_reason || '',
    '飞书卡片链接': requirement.feishu_card_url || '飞书卡片内处理',
    '归档ID': requirement.id,
  };
}

function isRequirementOverdue(requirement, now = new Date()) {
  const due = requirement.acceptance_due_at || requirement.test_due_at || requirement.dev_due_at || requirement.pm_due_at;
  return Boolean(due && new Date(due) < now && !['closed', 'rejected'].includes(requirement.status));
}

export async function syncRequirementToBitable({ tenantId, requirement }) {
  const settings = await getRequirementBotSettings(tenantId);
  if (!settings?.bitable_app_token || !settings?.bitable_table_id) {
    return { skipped: true, reason: 'bitable_not_configured' };
  }
  const client = await getRequirementBotClient(tenantId);
  const fields = requirementToBitableFields(requirement);
  try {
    let result;
    if (requirement.bitable_record_id) {
      result = await client.bitable.appTableRecord.update({
        path: {
          app_token: settings.bitable_app_token,
          table_id: settings.bitable_table_id,
          record_id: requirement.bitable_record_id,
        },
        data: { fields },
      });
    } else {
      result = await client.bitable.appTableRecord.create({
        path: {
          app_token: settings.bitable_app_token,
          table_id: settings.bitable_table_id,
        },
        data: { fields },
      });
    }
    const recordId = result?.data?.record?.record_id || result?.record?.record_id || requirement.bitable_record_id || null;
    await updateRequirement({
      tenantId,
      id: requirement.id,
      patch: {
        bitable_record_id: recordId,
        bitable_sync_status: 'synced',
        bitable_last_error: null,
      },
    });
    return { ok: true, recordId };
  } catch (err) {
    await updateRequirement({
      tenantId,
      id: requirement.id,
      patch: {
        bitable_sync_status: 'failed',
        bitable_last_error: err.message,
      },
    });
    return { ok: false, error: err.message };
  }
}
```

Inspect SDK method names before implementation and adjust `client.bitable.appTableRecord.*` if needed.

- [ ] **Step 2: Trigger sync after create and card action**

In `events/route.js`, after creating/sending the card, call:

```js
import { syncRequirementToBitable } from '@/src/requirement-bitable.service';
```

and:

```js
syncRequirementToBitable({ tenantId, requirement }).catch(err => {
  console.warn('[requirements] bitable sync after create failed:', err.message);
});
```

In `cards/route.js`, after `updateFeishuCard`, call the same fire-and-forget sync with `updated`.

- [ ] **Step 3: Manual retry route**

Create `app/api/requirements/[id]/sync-bitable/route.js`:

```js
import { getTenantContext } from '@/lib/tenant-context';
import { getRequirementById } from '@/lib/repositories/requirement.repository';
import { syncRequirementToBitable } from '@/src/requirement-bitable.service';

export async function POST(_request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const requirement = await getRequirementById({ tenantId: ctx.tenantId, id: params.id });
  if (!requirement) return Response.json({ error: 'Not found' }, { status: 404 });
  const result = await syncRequirementToBitable({ tenantId: ctx.tenantId, requirement });
  if (result.ok || result.skipped) return Response.json(result);
  return Response.json(result, { status: 500 });
}
```

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm run build
```

Expected: no import or syntax errors.

Commit:

```bash
git add src/requirement-bitable.service.js app/api/requirements app/api/feishu/requirements
git commit -m "feat(requirements): sync ledger to feishu bitable"
```

---

### Task 7: Reminder Cron

**Files:**
- Create: `src/requirement-reminder.service.js`
- Create: `app/api/cron/requirements-reminders/route.js`

- [ ] **Step 1: Create reminder service**

Create `src/requirement-reminder.service.js`:

```js
import { buildSimpleNoticeCard } from './requirement-card.service.js';
import { sendFeishuCard } from './feishu-app.service.js';
import { getRequirementBotSettings, listRequirementsForReminder, recordRequirementReminder, updateRequirement } from '../lib/repositories/requirement.repository.js';

function activeDueAt(requirement) {
  if (requirement.status === 'needs_pm' || requirement.status === 'needs_info') return requirement.pm_due_at;
  if (requirement.status === 'ready_for_dev' || requirement.status === 'in_dev') return requirement.dev_due_at;
  if (requirement.status === 'ready_for_test' || requirement.status === 'in_test') return requirement.test_due_at;
  if (requirement.status === 'ready_for_acceptance') return requirement.acceptance_due_at;
  return null;
}

function hoursUntil(iso, now) {
  if (!iso) return null;
  return (new Date(iso).getTime() - now.getTime()) / 36e5;
}

export function classifyRequirementReminder(requirement, now = new Date()) {
  if (['closed', 'rejected'].includes(requirement.status)) return null;
  const due = activeDueAt(requirement);
  const h = hoursUntil(due, now);
  if (h != null && h < 0) return 'overdue';
  if (h != null && h <= 24) return 'due_soon';
  const staleHours = (now.getTime() - new Date(requirement.last_status_changed_at || requirement.updated_at).getTime()) / 36e5;
  if (staleHours >= 72) return 'stale';
  if (requirement.priority === 'P0') {
    const last = requirement.last_reminded_at ? new Date(requirement.last_reminded_at) : null;
    if (!last || (now.getTime() - last.getTime()) / 36e5 >= 2) return 'p0_followup';
  }
  if (requirement.priority === 'P1') {
    const last = requirement.last_reminded_at ? new Date(requirement.last_reminded_at) : null;
    if (!last || (now.getTime() - last.getTime()) / 36e5 >= 24) return 'p1_followup';
  }
  return null;
}

export async function runRequirementReminders({ tenantId }) {
  const settings = await getRequirementBotSettings(tenantId);
  if (!settings?.enabled || !settings.default_chat_id) return { skipped: true, reason: 'not_configured' };
  const now = new Date();
  const requirements = await listRequirementsForReminder({ tenantId, nowIso: now.toISOString() });
  const selected = requirements
    .map(requirement => ({ requirement, reminderType: classifyRequirementReminder(requirement, now) }))
    .filter(item => item.reminderType);

  for (const item of selected) {
    const { requirement, reminderType } = item;
    const card = buildSimpleNoticeCard({
      title: `需求提醒：${requirement.req_no}`,
      lines: [
        `**标题**：${requirement.title}`,
        `**状态**：${requirement.status}`,
        `**负责人**：<at id="${requirement.current_owner_feishu_user_id || requirement.pm_owner_feishu_user_id || ''}"></at>`,
        `**提醒类型**：${reminderType}`,
      ],
    });
    await sendFeishuCard({ tenantId, receiveId: requirement.feishu_chat_id || settings.default_chat_id, card });
    await recordRequirementReminder({
      tenant_id: tenantId,
      requirement_id: requirement.id,
      reminder_type: reminderType,
      target_feishu_user_id: requirement.current_owner_feishu_user_id,
      details: {},
    });
    await updateRequirement({
      tenantId,
      id: requirement.id,
      patch: { last_reminded_at: now.toISOString() },
    });
  }
  return { ok: true, sent: selected.length };
}
```

- [ ] **Step 2: Create cron route**

Create `app/api/cron/requirements-reminders/route.js`:

```js
import { config } from '@/src/config';
import { runRequirementReminders } from '@/src/requirement-reminder.service';

export async function GET(request) {
  const auth = request.headers.get('authorization') || '';
  if (config.secrets.cron && auth !== `Bearer ${config.secrets.cron}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const tenantId = request.nextUrl.searchParams.get('tenant_id') || config.feishu.requirementBotCallbackTenantId;
  if (!tenantId) return Response.json({ error: 'tenant_id required' }, { status: 400 });
  const result = await runRequirementReminders({ tenantId });
  return Response.json(result);
}
```

The existing project stores the cron secret at `config.secrets.cron`; do not add a second cron secret key.

- [ ] **Step 3: Verify and commit**

Run:

```bash
npm run build
```

Expected: no syntax/import errors.

Commit:

```bash
git add src/requirement-reminder.service.js app/api/cron/requirements-reminders/route.js src/config.js
git commit -m "feat(requirements): send workflow reminders"
```

---

### Task 8: Settings Page, Internal Archive APIs, and Feishu-Only Workflow Surface

**Files:**
- Create: `app/api/requirements/route.js`
- Create: `app/api/requirements/[id]/route.js`
- Modify: `app/components/Sidebar/Sidebar.js`
- Modify: `app/components/Sidebar/Sidebar.module.css`
- Modify: `lib/prefetch-keys.js`

- [ ] **Step 1: Keep internal list endpoint**

Create `app/api/requirements/route.js`:

```js
import { getTenantContext } from '@/lib/tenant-context';
import { listRequirements } from '@/lib/repositories/requirement.repository';

export async function GET(request) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const p = request.nextUrl.searchParams;
  const rows = await listRequirements({
    tenantId: ctx.tenantId,
    filters: {
      status: p.get('status') || '',
      priority: p.get('priority') || '',
      current_owner: p.get('current_owner') || '',
      requirement_type: p.get('requirement_type') || '',
    },
    limit: Number(p.get('limit') || 100),
  });
  return Response.json({ data: rows });
}
```

- [ ] **Step 2: Keep internal detail endpoint**

Create `app/api/requirements/[id]/route.js`:

```js
import { getTenantContext } from '@/lib/tenant-context';
import { getRequirementById, listRequirementAttachments, listRequirementEvents } from '@/lib/repositories/requirement.repository';

export async function GET(_request, { params }) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const requirement = await getRequirementById({ tenantId: ctx.tenantId, id: params.id });
  if (!requirement) return Response.json({ error: 'Not found' }, { status: 404 });
  const [events, attachments] = await Promise.all([
    listRequirementEvents({ tenantId: ctx.tenantId, requirementId: params.id }),
    listRequirementAttachments({ tenantId: ctx.tenantId, requirementId: params.id }),
  ]);
  return Response.json({ data: requirement, events, attachments });
}
```

- [ ] **Step 3: Keep workflow out of LeadEngine pages**

Do not add a LeadEngine requirement list or detail page. Daily work happens in Feishu cards, and the global list lives in Feishu Bitable.

If a backend page was created during implementation, remove:

- `app/(app)/requirements/page.js`
- `app/(app)/requirements/page.module.css`
- `app/(app)/requirements/[id]/page.js`
- `app/(app)/requirements/[id]/page.module.css`

- [ ] **Step 4: Add settings link only**

Add:

- `/settings/requirement-bot` labeled `需求机器人`

Match existing sidebar icon/style patterns.

- [ ] **Step 5: Verify build and commit**

Run:

```bash
npm run build
```

Expected: pages compile, routes compile.

Commit:

```bash
git add app/api/requirements 'app/(app)/settings/requirement-bot' app/components/Sidebar lib/prefetch-keys.js
git commit -m "feat(requirements): add settings and archive APIs"
```

---

### Task 9: Index Refresh and System Verification

**Files:**
- Modify: `.claude/index/MAP.md`
- Modify: `.claude/index/glossary.md`
- Modify: `.claude/index/routes.md`
- Modify: `.claude/index/schema.md`

- [ ] **Step 1: Update hand-maintained index docs**

Update `.claude/index/MAP.md` with a new feature section:

```md
### Requirement Bot — Feishu-driven product requirement workflow
- **UI**: `app/(app)/settings/requirement-bot/page.js`
- **API**: `/api/feishu/requirements/events`, `/api/feishu/requirements/cards`, `/api/requirements`, `/api/requirements/[id]`, `/api/requirements/[id]/sync-bitable`, `/api/settings/requirement-bot`, `/api/cron/requirements-reminders`
- **Services**: `src/requirement-draft.service.js`, `src/requirement-state.service.js`, `src/requirement-card.service.js`, `src/requirement-reminder.service.js`, `src/requirement-bitable.service.js`, `src/feishu-app.service.js`
- **Repository**: `lib/repositories/requirement.repository.js`
- **Tables**: `requirement_bot_settings`, `requirement_feishu_users`, `requirements`, `requirement_events`, `requirement_attachments`, `requirement_reminder_logs`
- **Notes**: Feishu card is the primary workflow surface. Feishu Bitable is the global ledger. Backend only provides settings, archival APIs, and sync/retry surfaces. Bitable sync is one-way.
```

Update `.claude/index/glossary.md` with:

```md
## Requirement Bot

- **Requirement** — Internal product requirement created from Feishu group @bot messages. Stored in `requirements`.
- **Requirement card** — Feishu interactive card used as the main workflow UI.
- **Bitable sync** — One-way ledger sync from the system to Feishu Bitable. This is the global requirement list for the team; Bitable edits are not imported in v1.
```

- [ ] **Step 2: Refresh generated index docs**

Run:

```bash
npm run index
```

Expected: `.claude/index/routes.md` and `.claude/index/schema.md` reflect new routes/tables. If the command requires live DB migration that has not been applied, document the failure and update only hand-maintained docs in this commit.

- [ ] **Step 3: Full build**

Run:

```bash
npm run build
```

Expected: build passes. If it fails due to missing environment variables or unrelated current-main issues, capture the exact failure and verify all new files with targeted import/syntax checks.

- [ ] **Step 4: Local route smoke checks**

With dev server running:

```bash
curl -s -X POST http://localhost:3000/api/feishu/requirements/events \
  -H 'Content-Type: application/json' \
  -d '{"type":"url_verification","challenge":"event-smoke"}'
```

Expected:

```json
{"challenge":"event-smoke"}
```

```bash
curl -s -X POST http://localhost:3000/api/feishu/requirements/cards \
  -H 'Content-Type: application/json' \
  -d '{"type":"url_verification","challenge":"card-smoke"}'
```

Expected:

```json
{"challenge":"card-smoke"}
```

- [ ] **Step 5: Browser verification**

Open:

- `http://localhost:3000/settings/requirement-bot`

Check:

- no blank screen,
- no console errors from these routes,
- filters and empty states render,
- settings form saves validation errors correctly if required fields are empty,
- layout works on desktop and mobile widths.

- [ ] **Step 6: Commit**

```bash
git add .claude/index docs/superpowers/plans/2026-06-08-feishu-requirement-bot.md
git commit -m "docs(requirements): add implementation plan and index"
```

---

## Execution Order

1. Task 1 must run first because all later tasks need schema/constants/repository.
2. Task 2 must run before Tasks 4-7 because Feishu client/settings are shared.
3. Task 3 must run before Task 4 because event creation calls AI draft generation.
4. Tasks 5 and 6 can run after Task 4.
5. Tasks 7 and 8 can run in parallel after Task 2 and Task 1, but Task 8 is easier after Task 6 because it displays sync state.
6. Task 9 always runs last.

## Completion Criteria

- A Feishu @bot message can create a requirement record and send a draft card.
- PM confirmation and delivery actions move the requirement through the state machine.
- State history is recorded.
- Reminder cron can identify and send due/overdue/stale reminders.
- Bitable sync creates or updates one record per requirement and reports failures.
- Backend list/detail/settings pages compile and render.
- Index docs are updated or the reason they could not be refreshed is documented.
