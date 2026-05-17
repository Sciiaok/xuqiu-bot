# Schema Snapshot (auto-generated)

Generated: 2026-05-17T04:53:21.887Z

Live snapshot of `public` schema from Supabase. **Do not edit by hand** — run `node scripts/build-index.mjs` to refresh.

Tables: **51**. Listed alphabetically.

## Tables

- [`agents`](#agents)
- [`ai_reports`](#ai-reports)
- [`aigc_assets`](#aigc-assets)
- [`audit_log`](#audit-log)
- [`autopilot_messages`](#autopilot-messages)
- [`autopilot_sessions`](#autopilot-sessions)
- [`campaign_briefs`](#campaign-briefs)
- [`campaign_messages`](#campaign-messages)
- [`contact_notes`](#contact-notes)
- [`contacts`](#contacts)
- [`conversations`](#conversations)
- [`conversations_with_resolved_route`](#conversations-with-resolved-route)
- [`fix_knowledge`](#fix-knowledge)
- [`inquiry_dashboard_summaries`](#inquiry-dashboard-summaries)
- [`invitations`](#invitations)
- [`kb_assets`](#kb-assets)
- [`kb_corrections`](#kb-corrections)
- [`kb_documents`](#kb-documents)
- [`kb_glossary`](#kb-glossary)
- [`kb_knowledge_gaps`](#kb-knowledge-gaps)
- [`kb_knowledge_points`](#kb-knowledge-points)
- [`kb_pending_review`](#kb-pending-review)
- [`kb_pricing_rules`](#kb-pricing-rules)
- [`kb_product_assets`](#kb-product-assets)
- [`kb_products`](#kb-products)
- [`kb_qa_snippets`](#kb-qa-snippets)
- [`kb_shipping_routes`](#kb-shipping-routes)
- [`kb_test_messages`](#kb-test-messages)
- [`kb_test_sessions`](#kb-test-sessions)
- [`lead_sync_logs`](#lead-sync-logs)
- [`leads`](#leads)
- [`llm_usage_logs`](#llm-usage-logs)
- [`message_queue`](#message-queue)
- [`messages`](#messages)
- [`meta_ad_accounts`](#meta-ad-accounts)
- [`meta_connections`](#meta-connections)
- [`meta_phone_numbers`](#meta-phone-numbers)
- [`notification_settings`](#notification-settings)
- [`onboarding_progress`](#onboarding-progress)
- [`orchestrator_messages`](#orchestrator-messages)
- [`orchestrator_sessions`](#orchestrator-sessions)
- [`product_assets`](#product-assets)
- [`product_doc_operations`](#product-doc-operations)
- [`product_documents`](#product-documents)
- [`product_embeddings`](#product-embeddings)
- [`product_lines`](#product-lines)
- [`product_specs`](#product-specs)
- [`sessions`](#sessions)
- [`tenants`](#tenants)
- [`users`](#users)
- [`webhook_dumps`](#webhook-dumps)

### `agents`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `name` | text | N |  |
| `product_line` | text | N |  |
| `system_prompt` | text | N |  |
| `output_schema` | jsonb | N |  |
| `wa_phone_number_id` | text | Y |  |
| `is_active` | boolean | N | `true` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |
| `ad_context_map` | jsonb | N | `'{}'::jsonb` |
| `qualification_config` | jsonb | N | `'{}'::jsonb` |
| `display_label` | text | Y |  |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `tenant_id` → `tenants.id`

**Indexes:**
- `agents_product_line_key` USING btree (product_line)
- `idx_agents_tenant` USING btree (tenant_id)

### `ai_reports`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `type` | text | N |  |
| `status` | text | N | `'generating'::text` |
| `agent_ids` | ARRAY | N | `'{}'::text[]` |
| `period_start` | date | N |  |
| `period_end` | date | N |  |
| `content` | jsonb | Y |  |
| `summary_line` | text | Y |  |
| `kpi_snapshot` | jsonb | Y |  |
| `retry_count` | integer | N | `0` |
| `error_message` | text | Y |  |
| `generated_at` | timestamp with time zone | Y |  |
| `created_at` | timestamp with time zone | N | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_ai_reports_status` USING btree (status) WHERE (status = 'failed'::text)
- `idx_ai_reports_tenant` USING btree (tenant_id)
- `idx_ai_reports_type_created` USING btree (type, created_at DESC)
- `idx_ai_reports_unique_auto` USING btree (type, period_start, period_end) WHERE ((type = ANY (ARRAY['daily'::text, 'weekly'::text, 'monthly'::text])) AND (agent_ids = '{}'::text[]))

### `aigc_assets`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `prompt` | text | N |  |
| `model` | text | N |  |
| `source_filename` | text | Y |  |
| `product_info` | jsonb | Y |  |
| `storage_path` | text | N |  |
| `metadata` | jsonb | Y | `'{}'::jsonb` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `conversation_id` | uuid | Y |  |
| `user_id` | uuid | Y |  |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `conversation_id` → `conversations.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_aigc_assets_conversation` USING btree (conversation_id) WHERE (conversation_id IS NOT NULL)
- `idx_aigc_assets_tenant` USING btree (tenant_id)
- `idx_aigc_assets_user` USING btree (user_id) WHERE (user_id IS NOT NULL)

### `audit_log`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `tenant_id` | uuid | Y |  |
| `actor_user_id` | uuid | Y |  |
| `actor_email` | text | Y |  |
| `action` | text | N |  |
| `details` | jsonb | N | `'{}'::jsonb` |
| `ip_address` | text | Y |  |
| `created_at` | timestamp with time zone | N | `now()` |

**Foreign keys:**
- `actor_user_id` → `users.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_audit_action` USING btree (action, created_at DESC)
- `idx_audit_tenant` USING btree (tenant_id, created_at DESC)

### `autopilot_messages`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `session_id` | uuid | N |  |
| `message_index` | integer | N |  |
| `role` | text | N |  |
| `content` | text | Y |  |
| `tool_name` | text | Y |  |
| `tool_use_id` | text | Y |  |
| `tool_input` | jsonb | Y |  |
| `tool_result` | jsonb | Y |  |
| `attachments` | jsonb | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `session_id` → `autopilot_sessions.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_autopilot_messages_order` USING btree (session_id, message_index)
- `idx_autopilot_messages_tenant` USING btree (tenant_id)

### `autopilot_sessions`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `user_id` | uuid | Y |  |
| `title` | text | Y |  |
| `status` | text | N | `'active'::text` |
| `plan_json` | jsonb | Y |  |
| `meta_campaign_ids` | ARRAY | Y | `'{}'::text[]` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |
| `deleted_at` | timestamp with time zone | Y |  |
| `stage_outputs` | jsonb | N | `'[]'::jsonb` |
| `product_line` | text | Y |  |

**Foreign keys:**
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_autopilot_sessions_active` USING btree (tenant_id, user_id, updated_at DESC) WHERE (deleted_at IS NULL)
- `idx_autopilot_sessions_pl` USING btree (tenant_id, product_line) WHERE (deleted_at IS NULL)
- `idx_autopilot_sessions_status` USING btree (status) WHERE (status <> 'archived'::text)
- `idx_autopilot_sessions_tenant` USING btree (tenant_id)
- `idx_autopilot_sessions_user` USING btree (user_id, created_at DESC)

### `campaign_briefs`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `status` | text | N | `'draft'::text` |
| `brief` | jsonb | N | `'{}'::jsonb` |
| `completion` | jsonb | N | `'{}'::jsonb` |
| `expires_at` | timestamp with time zone | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |
| `current_phase` | text | Y |  |
| `phase_results` | jsonb | N | `'{}'::jsonb` |
| `approval_payload` | jsonb | Y |  |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_campaign_briefs_status` USING btree (status) WHERE (status = ANY (ARRAY['draft'::text, 'collecting'::text]))
- `idx_campaign_briefs_tenant` USING btree (tenant_id)

### `campaign_messages`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `brief_id` | uuid | N |  |
| `role` | text | N |  |
| `content` | text | Y |  |
| `tool_name` | text | Y |  |
| `tool_use_id` | text | Y |  |
| `tool_input` | jsonb | Y |  |
| `tool_result` | jsonb | Y |  |
| `message_index` | integer | N |  |
| `created_at` | timestamp with time zone | Y | `now()` |

**Foreign keys:**
- `brief_id` → `campaign_briefs.id`

**Indexes:**
- `idx_campaign_messages_brief_id` USING btree (brief_id)
- `idx_campaign_messages_order` USING btree (brief_id, message_index)

### `contact_notes`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `contact_id` | uuid | N |  |
| `content` | text | N |  |
| `type` | text | Y | `'note'::text` |
| `created_by` | text | N |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |

**Foreign keys:**
- `contact_id` → `contacts.id`

**Indexes:**
- `idx_contact_notes_contact` USING btree (contact_id)

### `contacts`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `wa_id` | text | Y |  |
| `name` | text | Y |  |
| `company_name` | text | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |
| `metadata` | jsonb | Y | `'{}'::jsonb` |
| `bsuid` | text | Y |  |
| `username` | text | Y |  |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `tenant_id` → `tenants.id`

**Indexes:**
- `contacts_bsuid_key` USING btree (bsuid)
- `contacts_wa_id_key` USING btree (wa_id)
- `idx_contacts_bsuid` USING btree (bsuid) WHERE (bsuid IS NOT NULL)
- `idx_contacts_tenant` USING btree (tenant_id)
- `idx_contacts_wa_id` USING btree (wa_id)

### `conversations`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `contact_id` | uuid | N |  |
| `status` | text | Y | `'active'::text` |
| `started_at` | timestamp with time zone | Y | `now()` |
| `ended_at` | timestamp with time zone | Y |  |
| `last_message_at` | timestamp with time zone | Y | `now()` |
| `message_count` | integer | Y | `0` |
| `closed_reason` | text | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `is_human_takeover` | boolean | N | `false` |
| `human_takeover_at` | timestamp with time zone | Y |  |
| `agent_id` | uuid | Y |  |
| `wa_phone_number_id` | text | Y |  |
| `meta_ad_id` | text | Y |  |
| `product_line` | text | Y |  |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |
| `feishu_notified_at` | timestamp with time zone | Y |  |

**Foreign keys:**
- `agent_id` → `agents.id`
- `contact_id` → `contacts.id`
- `product_line` → `product_lines.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_conversations_agent` USING btree (agent_id)
- `idx_conversations_contact_id` USING btree (contact_id)
- `idx_conversations_human_takeover` USING btree (human_takeover_at) WHERE (is_human_takeover = true)
- `idx_conversations_last_message` USING btree (last_message_at)
- `idx_conversations_meta_ad_id` USING btree (meta_ad_id) WHERE (meta_ad_id IS NOT NULL)
- `idx_conversations_product_line` USING btree (product_line)
- `idx_conversations_status` USING btree (status) WHERE (status = 'active'::text)
- `idx_conversations_tenant` USING btree (tenant_id)
- `idx_conversations_wa_phone_number_id` USING btree (wa_phone_number_id) WHERE (wa_phone_number_id IS NOT NULL)
- `idx_unique_active_conversation` USING btree (contact_id, COALESCE(agent_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (status = 'active'::text)

### `conversations_with_resolved_route`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | Y |  |
| `contact_id` | uuid | Y |  |
| `status` | text | Y |  |
| `started_at` | timestamp with time zone | Y |  |
| `ended_at` | timestamp with time zone | Y |  |
| `last_message_at` | timestamp with time zone | Y |  |
| `message_count` | integer | Y |  |
| `closed_reason` | text | Y |  |
| `created_at` | timestamp with time zone | Y |  |
| `is_human_takeover` | boolean | Y |  |
| `human_takeover_at` | timestamp with time zone | Y |  |
| `agent_id` | uuid | Y |  |
| `wa_phone_number_id` | text | Y |  |
| `meta_ad_id` | text | Y |  |
| `product_line` | text | Y |  |
| `tenant_id` | uuid | Y |  |
| `feishu_notified_at` | timestamp with time zone | Y |  |
| `resolved_route` | text | Y |  |

### `fix_knowledge`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `error_pattern` | text | N |  |
| `error_context` | text | Y |  |
| `solution` | text | N |  |
| `solution_action` | jsonb | Y |  |
| `solution_type` | text | N | `'auto'::text` |
| `embedding` | vector | Y |  |
| `success_count` | integer | N | `1` |
| `fail_count` | integer | N | `0` |
| `last_used_at` | timestamp with time zone | Y | `now()` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_fix_knowledge_embedding` USING ivfflat (embedding vector_cosine_ops) WITH (lists='10')
- `idx_fix_knowledge_tenant` USING btree (tenant_id)

### `inquiry_dashboard_summaries`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `product_lines` | text | N |  |
| `period_key` | text | N |  |
| `date_from` | date | N |  |
| `date_to` | date | N |  |
| `content` | text | N |  |
| `generated_at` | timestamp with time zone | N | `now()` |
| `created_at` | timestamp with time zone | Y | `now()` |

**Indexes:**
- `idx_inquiry_summary_lookup` USING btree (product_lines, period_key)

### `invitations`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `email` | text | N |  |
| `invited_by_user_id` | uuid | Y |  |
| `token` | text | N |  |
| `expires_at` | timestamp with time zone | N |  |
| `status` | text | N | `'pending'::text` |
| `accepted_at` | timestamp with time zone | Y |  |
| `accepted_by_user_id` | uuid | Y |  |
| `created_at` | timestamp with time zone | N | `now()` |

**Foreign keys:**
- `accepted_by_user_id` → `users.id`
- `invited_by_user_id` → `users.id`

**Indexes:**
- `idx_invitations_email` USING btree (lower(email))
- `idx_invitations_token` USING btree (token)
- `invitations_token_key` USING btree (token)

### `kb_assets`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `agent_id` | uuid | N |  |
| `asset_type` | text | N |  |
| `filename` | text | N |  |
| `storage_path` | text | N |  |
| `mime_type` | text | Y |  |
| `file_size_bytes` | integer | Y |  |
| `description` | text | Y |  |
| `description_en` | text | Y |  |
| `layer` | text | Y |  |
| `linked_skus` | ARRAY | Y |  |
| `tags` | ARRAY | Y |  |
| `is_sendable` | boolean | Y | `true` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |
| `product_line_id` | text | Y |  |
| `view` | text | Y |  |
| `color` | text | Y |  |
| `scenario` | text | Y |  |
| `language` | text | Y |  |
| `expiry_date` | date | Y |  |
| `caption_embedding` | vector | Y |  |
| `source_doc_id` | uuid | Y |  |
| `content_sha256` | text | Y |  |

**Foreign keys:**
- `agent_id` → `agents.id`
- `source_doc_id` → `kb_documents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_assets_agent` USING btree (agent_id)
- `idx_kb_assets_content_sha` USING btree (content_sha256) WHERE (content_sha256 IS NOT NULL)
- `idx_kb_assets_scenario` USING btree (tenant_id, product_line_id, scenario)
- `idx_kb_assets_skus` USING gin (linked_skus)
- `idx_kb_assets_source_doc` USING btree (source_doc_id)
- `idx_kb_assets_tenant` USING btree (tenant_id)
- `idx_kb_assets_tenant_pl` USING btree (tenant_id, product_line_id)
- `idx_kb_assets_type` USING btree (asset_type)
- `idx_kb_assets_view` USING btree (tenant_id, product_line_id, view)
- `uq_kb_assets_doc_content` USING btree (tenant_id, source_doc_id, content_sha256) WHERE ((source_doc_id IS NOT NULL) AND (content_sha256 IS NOT NULL))

### `kb_corrections`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `tenant_id` | uuid | N |  |
| `product_line_id` | text | N |  |
| `conversation_id` | uuid | N |  |
| `message_id` | uuid | Y |  |
| `customer_question` | text | Y |  |
| `medici_original_answer` | text | N |  |
| `human_corrected_answer` | text | N |  |
| `diff_summary` | text | Y |  |
| `suggested_kb_action` | text | Y |  |
| `suggested_payload` | jsonb | Y |  |
| `status` | text | N | `'pending'::text` |
| `adopted_target_id` | uuid | Y |  |
| `created_by` | uuid | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `resolved_by` | uuid | Y |  |
| `resolved_at` | timestamp with time zone | Y |  |

**Foreign keys:**
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_corrections_conversation` USING btree (conversation_id)
- `idx_kb_corrections_tenant_pl` USING btree (tenant_id, product_line_id, status, created_at DESC)

### `kb_documents`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `agent_id` | uuid | N |  |
| `filename` | text | N |  |
| `storage_path` | text | Y |  |
| `layer` | text | N |  |
| `source_type` | text | N | `'file'::text` |
| `external_id` | text | Y |  |
| `sync_enabled` | boolean | Y | `false` |
| `last_synced_at` | timestamp with time zone | Y |  |
| `description` | text | Y |  |
| `status` | text | N | `'pending'::text` |
| `error_message` | text | Y |  |
| `knowledge_points_count` | integer | Y | `0` |
| `authority_level` | integer | Y | `3` |
| `is_authoritative` | boolean | Y | `false` |
| `is_outdated` | boolean | Y | `false` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |
| `file_size` | bigint | Y |  |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |
| `product_line_id` | text | Y |  |
| `content_sha256` | text | Y |  |
| `partial_reason` | text | Y |  |

**Foreign keys:**
- `agent_id` → `agents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_documents_agent` USING btree (agent_id)
- `idx_kb_documents_layer` USING btree (layer)
- `idx_kb_documents_status` USING btree (status)
- `idx_kb_documents_tenant` USING btree (tenant_id)
- `idx_kb_documents_tenant_pl` USING btree (tenant_id, product_line_id)
- `uniq_kb_documents_agent_content` USING btree (agent_id, content_sha256) WHERE (content_sha256 IS NOT NULL)

### `kb_glossary`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `agent_id` | uuid | N |  |
| `term_zh` | text | N |  |
| `term_en` | text | N |  |
| `context` | text | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |
| `product_line_id` | text | Y |  |

**Foreign keys:**
- `agent_id` → `agents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_glossary_agent` USING btree (agent_id)
- `idx_kb_glossary_tenant` USING btree (tenant_id)
- `idx_kb_glossary_tenant_pl` USING btree (tenant_id, product_line_id)

### `kb_knowledge_gaps`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `agent_id` | uuid | Y |  |
| `query` | text | N |  |
| `layer` | text | Y |  |
| `gap_type` | text | Y | `'no_result'::text` |
| `occurrence_count` | integer | Y | `1` |
| `last_occurred_at` | timestamp with time zone | Y | `now()` |
| `status` | text | Y | `'open'::text` |
| `resolved_by` | uuid | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |
| `product_line_id` | text | Y |  |
| `question_signature` | text | Y |  |
| `question_examples` | ARRAY | Y |  |
| `example_message_ids` | ARRAY | Y |  |
| `suggested_resolution` | text | Y |  |
| `addressed_by_ref` | jsonb | Y |  |
| `tool_name` | text | Y |  |

**Foreign keys:**
- `agent_id` → `agents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_knowledge_gaps_agent` USING btree (agent_id, status, last_occurred_at DESC)
- `idx_kb_knowledge_gaps_signature` USING btree (tenant_id, product_line_id, question_signature) WHERE (question_signature IS NOT NULL)
- `idx_kb_knowledge_gaps_tenant` USING btree (tenant_id)
- `idx_kb_knowledge_gaps_tenant_pl` USING btree (tenant_id, product_line_id)

### `kb_knowledge_points`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `doc_id` | uuid | Y |  |
| `agent_id` | uuid | N |  |
| `layer` | text | N |  |
| `content_original` | text | N |  |
| `content_en` | text | Y |  |
| `source_lang` | text | Y | `'zh'::text` |
| `metadata_json` | jsonb | Y | `'{}'::jsonb` |
| `source_location` | text | Y |  |
| `authority_level` | integer | Y | `3` |
| `effective_date` | date | Y | `CURRENT_DATE` |
| `expires_at` | date | Y |  |
| `superseded_by` | uuid | Y |  |
| `status` | text | N | `'active'::text` |
| `embedding_original` | vector | Y |  |
| `embedding_en` | vector | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |
| `product_line_id` | text | Y |  |
| `confidence` | text | N | `'extracted_high'::text` |

**Foreign keys:**
- `agent_id` → `agents.id`
- `doc_id` → `kb_documents.id`
- `superseded_by` → `kb_knowledge_points.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_knowledge_points_tenant` USING btree (tenant_id)
- `idx_kb_knowledge_points_tenant_pl` USING btree (tenant_id, product_line_id)
- `idx_kb_kp_agent` USING btree (agent_id)
- `idx_kb_kp_doc` USING btree (doc_id)
- `idx_kb_kp_embedding_en` USING ivfflat (embedding_en vector_cosine_ops) WITH (lists='50')
- `idx_kb_kp_embedding_original` USING ivfflat (embedding_original vector_cosine_ops) WITH (lists='50')
- `idx_kb_kp_layer` USING btree (layer)
- `idx_kb_kp_status` USING btree (status)

### `kb_pending_review`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `tenant_id` | uuid | N |  |
| `product_line_id` | text | N |  |
| `target_table` | text | N |  |
| `target_payload` | jsonb | N |  |
| `reason` | text | N |  |
| `conflict_with` | uuid | Y |  |
| `source_doc_id` | uuid | Y |  |
| `extracted_confidence` | numeric | Y |  |
| `status` | text | N | `'pending'::text` |
| `resolved_by` | uuid | Y |  |
| `resolved_at` | timestamp with time zone | Y |  |
| `resolved_note` | text | Y |  |
| `resolved_target_id` | uuid | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |

**Foreign keys:**
- `source_doc_id` → `kb_documents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_pending_review_doc` USING btree (source_doc_id)
- `idx_kb_pending_review_tenant_pl` USING btree (tenant_id, product_line_id, status, created_at DESC)

### `kb_pricing_rules`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `agent_id` | uuid | N |  |
| `doc_id` | uuid | Y |  |
| `rule_name` | text | N |  |
| `rule_type` | text | N |  |
| `priority` | integer | Y | `0` |
| `conditions` | jsonb | Y | `'{}'::jsonb` |
| `calculation` | jsonb | N |  |
| `requires_approval` | boolean | Y | `false` |
| `is_active` | boolean | Y | `true` |
| `effective_from` | date | Y |  |
| `effective_until` | date | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |
| `product_line_id` | text | Y |  |

**Foreign keys:**
- `agent_id` → `agents.id`
- `doc_id` → `kb_documents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_pricing_agent` USING btree (agent_id)
- `idx_kb_pricing_rules_tenant` USING btree (tenant_id)
- `idx_kb_pricing_rules_tenant_pl` USING btree (tenant_id, product_line_id)
- `idx_kb_pricing_type` USING btree (rule_type)

### `kb_product_assets`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `product_id` | uuid | N |  |
| `asset_id` | uuid | N |  |
| `is_primary` | boolean | Y | `false` |
| `sort_order` | integer | Y | `0` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `asset_id` → `kb_assets.id`
- `product_id` → `kb_products.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_product_assets_tenant` USING btree (tenant_id)

### `kb_products`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `doc_id` | uuid | Y |  |
| `agent_id` | uuid | N |  |
| `sku` | text | Y |  |
| `product_name` | text | Y |  |
| `product_name_en` | text | Y |  |
| `model` | text | Y |  |
| `category` | text | Y |  |
| `specs` | jsonb | Y | `'{}'::jsonb` |
| `fob_price_usd` | numeric | Y |  |
| `moq` | integer | Y |  |
| `lead_time_days` | text | Y |  |
| `source_row` | integer | Y |  |
| `is_active` | boolean | Y | `true` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |
| `product_line_id` | text | Y |  |
| `effective_date` | date | N | `CURRENT_DATE` |
| `expiry_date` | date | Y |  |
| `confidence` | text | N | `'verified'::text` |
| `source_doc_id` | uuid | Y |  |

**Foreign keys:**
- `agent_id` → `agents.id`
- `doc_id` → `kb_documents.id`
- `source_doc_id` → `kb_documents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_products_agent` USING btree (agent_id)
- `idx_kb_products_category` USING btree (category)
- `idx_kb_products_expiry` USING btree (tenant_id, product_line_id, expiry_date)
- `idx_kb_products_sku` USING btree (sku)
- `idx_kb_products_specs` USING gin (specs)
- `idx_kb_products_tenant` USING btree (tenant_id)
- `idx_kb_products_tenant_pl` USING btree (tenant_id, product_line_id)

### `kb_qa_snippets`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `tenant_id` | uuid | N |  |
| `product_line_id` | text | N |  |
| `questions` | ARRAY | N |  |
| `questions_embedding` | vector | Y |  |
| `answer` | text | N |  |
| `applicable_when` | jsonb | Y | `'{}'::jsonb` |
| `priority` | integer | Y | `5` |
| `is_active` | boolean | Y | `true` |
| `created_by` | uuid | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |

**Foreign keys:**
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_qa_snippets_embedding` USING ivfflat (questions_embedding vector_cosine_ops) WITH (lists='50')
- `idx_kb_qa_snippets_tenant_pl` USING btree (tenant_id, product_line_id, is_active)

### `kb_shipping_routes`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `doc_id` | uuid | Y |  |
| `agent_id` | uuid | N |  |
| `origin_port` | text | Y |  |
| `destination_port` | text | Y |  |
| `destination_country` | text | Y |  |
| `shipping_method` | text | Y |  |
| `cost_per_unit_usd` | numeric | Y |  |
| `transit_days` | text | Y |  |
| `notes` | text | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |
| `product_line_id` | text | Y |  |
| `effective_date` | date | N | `CURRENT_DATE` |
| `expiry_date` | date | Y |  |
| `confidence` | text | N | `'verified'::text` |
| `source_doc_id` | uuid | Y |  |

**Foreign keys:**
- `agent_id` → `agents.id`
- `doc_id` → `kb_documents.id`
- `source_doc_id` → `kb_documents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_shipping_agent` USING btree (agent_id)
- `idx_kb_shipping_country` USING btree (destination_country)
- `idx_kb_shipping_routes_expiry` USING btree (tenant_id, product_line_id, expiry_date)
- `idx_kb_shipping_routes_tenant` USING btree (tenant_id)
- `idx_kb_shipping_routes_tenant_pl` USING btree (tenant_id, product_line_id)

### `kb_test_messages`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `session_id` | uuid | N |  |
| `role` | text | N |  |
| `content` | text | N |  |
| `sources` | jsonb | Y |  |
| `search_meta` | jsonb | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `session_id` → `kb_test_sessions.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_test_messages_session` USING btree (session_id, created_at)
- `idx_kb_test_messages_tenant` USING btree (tenant_id)

### `kb_test_sessions`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `agent_id` | uuid | N |  |
| `title` | text | Y |  |
| `message_count` | integer | Y | `0` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |
| `product_line_id` | text | Y |  |

**Foreign keys:**
- `agent_id` → `agents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_kb_test_sessions_agent` USING btree (agent_id, updated_at DESC)
- `idx_kb_test_sessions_tenant` USING btree (tenant_id)
- `idx_kb_test_sessions_tenant_pl` USING btree (tenant_id, product_line_id)

### `lead_sync_logs`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `lead_id` | uuid | N |  |
| `external_id` | text | Y |  |
| `external_no` | text | Y |  |
| `status` | text | N | `'pending'::text` |
| `request_payload` | jsonb | Y |  |
| `response_payload` | jsonb | Y |  |
| `error_message` | text | Y |  |
| `retry_count` | integer | Y | `0` |
| `synced_at` | timestamp with time zone | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `lead_id` → `leads.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_lead_sync_logs_tenant` USING btree (tenant_id)
- `idx_sync_logs_created_at` USING btree (created_at)
- `idx_sync_logs_lead_id` USING btree (lead_id)
- `idx_sync_logs_status` USING btree (status)

### `leads`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `conversation_id` | uuid | N |  |
| `contact_id` | uuid | N |  |
| `score` | integer | Y | `0` |
| `route` | text | Y |  |
| `destination_country` | text | Y |  |
| `destination_port` | text | Y |  |
| `car_model` | text | Y |  |
| `qty_bucket` | text | Y |  |
| `buyer_type` | text | Y |  |
| `timeline` | text | Y |  |
| `incoterm` | text | Y |  |
| `loading_port` | text | Y |  |
| `extra_data` | jsonb | Y | `'{}'::jsonb` |
| `handoff_summary` | text | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |
| `approved` | boolean | Y | `false` |
| `brand` | text | Y |  |
| `approved_at` | timestamp with time zone | Y |  |
| `approved_by` | text | Y |  |
| `lead_key` | text | Y |  |
| `color_quantity` | jsonb | Y | `'[]'::jsonb` |
| `conversation_intent` | text | Y |  |
| `inquiry_quality` | text | Y | `'GOOD'::text` |
| `business_value` | text | Y | `'LOW'::text` |
| `conversation_intent_summary` | text | Y |  |
| `company_name` | text | Y |  |
| `agent_id` | uuid | Y |  |
| `product_name` | text | Y |  |
| `sku_description` | text | Y |  |
| `details` | jsonb | Y | `'{}'::jsonb` |
| `meta_ad_id` | text | Y |  |
| `product_line` | text | Y |  |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `agent_id` → `agents.id`
- `contact_id` → `contacts.id`
- `conversation_id` → `conversations.id`
- `product_line` → `product_lines.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_leads_agent` USING btree (agent_id)
- `idx_leads_approved` USING btree (approved) WHERE (approved = true)
- `idx_leads_approved_at` USING btree (approved_at)
- `idx_leads_business_value` USING btree (business_value)
- `idx_leads_car_model` USING btree (car_model)
- `idx_leads_contact_id` USING btree (contact_id)
- `idx_leads_conv_updated` USING btree (conversation_id, updated_at DESC NULLS LAST)
- `idx_leads_conversation_id` USING btree (conversation_id)
- `idx_leads_destination` USING btree (destination_country)
- `idx_leads_details_brand` USING btree (((details ->> 'brand'::text)))
- `idx_leads_details_buyer_type` USING btree (((details ->> 'buyer_type'::text)))
- `idx_leads_details_car_model` USING btree (((details ->> 'car_model'::text)))
- `idx_leads_details_destination_country` USING btree (((details ->> 'destination_country'::text)))
- `idx_leads_inquiry_quality` USING btree (inquiry_quality)
- `idx_leads_meta_ad_id` USING btree (meta_ad_id) WHERE (meta_ad_id IS NOT NULL)
- `idx_leads_product_line` USING btree (product_line)
- `idx_leads_score` USING btree (score)
- `idx_leads_tenant` USING btree (tenant_id)
- `idx_unique_lead_key` USING btree (conversation_id, lead_key) WHERE ((route = 'CONTINUE'::text) AND (lead_key IS NOT NULL))

### `llm_usage_logs`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `tenant_id` | uuid | Y |  |
| `call_site` | text | N |  |
| `provider` | text | N |  |
| `model` | text | Y |  |
| `prompt_tokens` | integer | N | `0` |
| `completion_tokens` | integer | N | `0` |
| `cost_usd` | numeric | N | `0` |
| `duration_ms` | integer | Y |  |
| `finish_reason` | text | Y |  |
| `created_at` | timestamp with time zone | N | `now()` |
| `cache_creation_input_tokens` | integer | N | `0` |
| `cache_read_input_tokens` | integer | N | `0` |
| `session_id` | uuid | Y |  |
| `product_line` | text | Y |  |

**Foreign keys:**
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_llm_usage_callsite_created` USING btree (call_site, created_at DESC)
- `idx_llm_usage_created` USING btree (created_at DESC)
- `idx_llm_usage_product_line_created` USING btree (tenant_id, product_line, created_at DESC) WHERE (product_line IS NOT NULL)
- `idx_llm_usage_session_created` USING btree (session_id, created_at DESC) WHERE (session_id IS NOT NULL)
- `idx_llm_usage_tenant_created` USING btree (tenant_id, created_at DESC)

### `message_queue`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `conversation_id` | uuid | N |  |
| `contact_id` | uuid | N |  |
| `wa_id` | text | N |  |
| `content` | text | N |  |
| `message_type` | text | N | `'text'::text` |
| `wa_message_id` | text | Y |  |
| `status` | text | N | `'pending'::text` |
| `process_after` | timestamp with time zone | N |  |
| `locked_at` | timestamp with time zone | Y |  |
| `locked_by` | text | Y |  |
| `processed_at` | timestamp with time zone | Y |  |
| `error_message` | text | Y |  |
| `retry_count` | integer | Y | `0` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `metadata` | jsonb | N | `'{}'::jsonb` |

**Foreign keys:**
- `contact_id` → `contacts.id`
- `conversation_id` → `conversations.id`

**Indexes:**
- `idx_queue_conversation` USING btree (conversation_id, status)
- `idx_queue_pending` USING btree (status, process_after) WHERE (status = 'pending'::text)
- `unique_wa_message` USING btree (wa_message_id)

### `messages`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `conversation_id` | uuid | N |  |
| `role` | text | N |  |
| `content` | text | N |  |
| `score_delta` | integer | Y | `0` |
| `risk_flags` | ARRAY | Y | `'{}'::text[]` |
| `sent_at` | timestamp with time zone | Y | `now()` |
| `sent_by` | text | Y |  |
| `metadata` | jsonb | Y | `'{}'::jsonb` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `conversation_id` → `conversations.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_messages_conversation_id` USING btree (conversation_id)
- `idx_messages_sent_at` USING btree (sent_at)
- `idx_messages_tenant` USING btree (tenant_id)

### `meta_ad_accounts`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `ad_account_id` | text | N |  |
| `tenant_id` | uuid | N |  |
| `meta_connection_id` | uuid | N |  |
| `name` | text | Y |  |
| `currency` | text | Y |  |
| `timezone` | text | Y |  |
| `account_status` | integer | Y |  |
| `synced_at` | timestamp with time zone | N | `now()` |
| `status` | text | N | `'active'::text` |

**Foreign keys:**
- `meta_connection_id` → `meta_connections.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_ad_tenant` USING btree (tenant_id)

### `meta_connections`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `tenant_id` | uuid | N |  |
| `bm_id` | text | N |  |
| `business_name` | text | Y |  |
| `system_user_token_encrypted` | bytea | N |  |
| `scopes` | ARRAY | N | `ARRAY[]::text[]` |
| `status` | text | N | `'active'::text` |
| `connected_at` | timestamp with time zone | N | `now()` |
| `connected_by_user_id` | uuid | Y |  |
| `last_health_check_at` | timestamp with time zone | Y |  |
| `health_check_failed_count` | integer | N | `0` |
| `disconnected_at` | timestamp with time zone | Y |  |
| `metadata` | jsonb | N | `'{}'::jsonb` |

**Foreign keys:**
- `connected_by_user_id` → `users.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_meta_conn_active_per_tenant` USING btree (tenant_id) WHERE (status = 'active'::text)
- `idx_meta_conn_tenant` USING btree (tenant_id, status)
- `idx_meta_connections_bm_active_global` USING btree (bm_id) WHERE (status = 'active'::text)

### `meta_phone_numbers`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `phone_number_id` | text | N |  |
| `tenant_id` | uuid | N |  |
| `meta_connection_id` | uuid | N |  |
| `waba_id` | text | N |  |
| `display_number` | text | N |  |
| `verified_name` | text | Y |  |
| `quality_rating` | text | Y |  |
| `code_verification_status` | text | Y |  |
| `is_registered` | boolean | N | `false` |
| `synced_at` | timestamp with time zone | N | `now()` |
| `status` | text | N | `'active'::text` |

**Foreign keys:**
- `meta_connection_id` → `meta_connections.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_phone_tenant` USING btree (tenant_id)
- `idx_phone_waba` USING btree (waba_id)

### `notification_settings`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `tenant_id` | uuid | N |  |
| `feishu_webhook_url_encrypted` | bytea | Y |  |
| `feishu_enabled` | boolean | N | `false` |
| `feishu_last_test_at` | timestamp with time zone | Y |  |
| `feishu_last_test_ok` | boolean | Y |  |
| `feishu_last_test_error` | text | Y |  |
| `created_at` | timestamp with time zone | N | `now()` |
| `updated_at` | timestamp with time zone | N | `now()` |

**Foreign keys:**
- `tenant_id` → `tenants.id`

### `onboarding_progress`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `tenant_id` | uuid | N |  |
| `account_created_at` | timestamp with time zone | Y |  |
| `meta_connected_at` | timestamp with time zone | Y |  |
| `first_product_line_at` | timestamp with time zone | Y |  |
| `first_kb_uploaded_at` | timestamp with time zone | Y |  |
| `first_message_received_at` | timestamp with time zone | Y |  |
| `first_ai_reply_at` | timestamp with time zone | Y |  |
| `completed_at` | timestamp with time zone | Y |  |
| `dismissed_at` | timestamp with time zone | Y |  |

**Foreign keys:**
- `tenant_id` → `tenants.id`

### `orchestrator_messages`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `session_id` | uuid | N |  |
| `phase` | text | Y |  |
| `role` | text | N |  |
| `content` | text | Y |  |
| `tool_name` | text | Y |  |
| `tool_use_id` | text | Y |  |
| `tool_input` | jsonb | Y |  |
| `tool_result` | jsonb | Y |  |
| `message_index` | integer | N |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `attachments` | jsonb | Y |  |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `session_id` → `orchestrator_sessions.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_orchestrator_messages_order` USING btree (session_id, message_index)
- `idx_orchestrator_messages_phase` USING btree (session_id, phase) WHERE (phase IS NOT NULL)
- `idx_orchestrator_messages_session` USING btree (session_id)
- `idx_orchestrator_messages_tenant` USING btree (tenant_id)

### `orchestrator_sessions`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `brief_id` | uuid | N |  |
| `status` | text | N | `'draft'::text` |
| `current_phase` | text | Y |  |
| `phase_results` | jsonb | N | `'{}'::jsonb` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |
| `orchestrator_state` | jsonb | Y |  |
| `fix_log` | jsonb | N | `'[]'::jsonb` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `brief_id` → `campaign_briefs.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_orchestrator_sessions_brief` USING btree (brief_id)
- `idx_orchestrator_sessions_status` USING btree (status) WHERE (status = ANY (ARRAY['running'::text, 'awaiting_approval'::text]))
- `idx_orchestrator_sessions_tenant` USING btree (tenant_id)

### `product_assets`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `agent_id` | uuid | N |  |
| `model` | text | N |  |
| `filename` | text | N |  |
| `storage_path` | text | N |  |
| `content_type` | text | N |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `agent_id` → `agents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_product_assets_agent` USING btree (agent_id)
- `idx_product_assets_agent_model` USING btree (agent_id, model)
- `idx_product_assets_model` USING btree (model)
- `idx_product_assets_tenant` USING btree (tenant_id)

### `product_doc_operations`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `document_id` | uuid | Y |  |
| `agent_id` | uuid | N |  |
| `operation` | text | N |  |
| `operator` | text | Y |  |
| `details` | jsonb | Y | `'{}'::jsonb` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `agent_id` → `agents.id`
- `document_id` → `product_documents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_product_doc_operations_tenant` USING btree (tenant_id)
- `idx_product_doc_ops_agent` USING btree (agent_id)
- `idx_product_doc_ops_created` USING btree (created_at DESC)

### `product_documents`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `agent_id` | uuid | N |  |
| `filename` | text | N |  |
| `storage_path` | text | N |  |
| `doc_type` | text | N | `'general'::text` |
| `status` | text | N | `'pending'::text` |
| `error_message` | text | Y |  |
| `page_count` | integer | Y |  |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `agent_id` → `agents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_product_documents_agent` USING btree (agent_id)
- `idx_product_documents_status` USING btree (status)
- `idx_product_documents_tenant` USING btree (tenant_id)

### `product_embeddings`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `document_id` | uuid | N |  |
| `agent_id` | uuid | N |  |
| `chunk_text` | text | N |  |
| `chunk_index` | integer | N |  |
| `embedding` | vector | N |  |
| `metadata` | jsonb | Y | `'{}'::jsonb` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `agent_id` → `agents.id`
- `document_id` → `product_documents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_product_embeddings_agent` USING btree (agent_id)
- `idx_product_embeddings_embedding` USING ivfflat (embedding vector_cosine_ops) WITH (lists='100')
- `idx_product_embeddings_tenant` USING btree (tenant_id)

### `product_lines`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | text | N |  |
| `name` | text | N |  |
| `catalog_description` | text | Y |  |
| `domain_glossary` | text | Y |  |
| `lead_fields` | jsonb | N | `'[]'::jsonb` |
| `wa_phone_number_id` | text | Y |  |
| `is_active` | boolean | N | `true` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |
| `business_value_guidance` | text | Y |  |
| `message_style_examples` | text | Y |  |
| `faq_message` | text | Y |  |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_product_lines_tenant` USING btree (tenant_id)
- `idx_product_lines_wa_phone` USING btree (wa_phone_number_id) WHERE (wa_phone_number_id IS NOT NULL)
- `product_lines_wa_phone_number_id_key` USING btree (wa_phone_number_id)

### `product_specs`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `document_id` | uuid | N |  |
| `agent_id` | uuid | N |  |
| `model` | text | N |  |
| `brand` | text | Y |  |
| `product_line` | text | N |  |
| `specs` | jsonb | N | `'{}'::jsonb` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `tenant_id` | uuid | N | `'00000000-0000-0000-0000-000000000001':…` |

**Foreign keys:**
- `agent_id` → `agents.id`
- `document_id` → `product_documents.id`
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_product_specs_agent` USING btree (agent_id)
- `idx_product_specs_model` USING btree (model)
- `idx_product_specs_product_line` USING btree (product_line)
- `idx_product_specs_specs` USING gin (specs)
- `idx_product_specs_tenant` USING btree (tenant_id)

### `sessions`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `wa_id` | text | N |  |
| `messages` | jsonb | Y | `'[]'::jsonb` |
| `stage` | text | Y | `'GREET'::text` |
| `stage_turn_count` | integer | Y | `0` |
| `score` | integer | Y | `0` |
| `score_history` | jsonb | Y | `'[]'::jsonb` |
| `risk_flags` | jsonb | Y | `'[]'::jsonb` |
| `lead_data` | jsonb | Y | `'{"timeline": "", "car_model": "", "buy…` |
| `created_at` | timestamp with time zone | Y | `now()` |
| `updated_at` | timestamp with time zone | Y | `now()` |

**Indexes:**
- `idx_sessions_score` USING btree (score)
- `idx_sessions_stage` USING btree (stage)
- `idx_sessions_wa_id` USING btree (wa_id)
- `sessions_wa_id_key` USING btree (wa_id)

### `tenants`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `name` | text | N |  |
| `slug` | text | N |  |
| `status` | text | N | `'active'::text` |
| `created_at` | timestamp with time zone | N | `now()` |
| `created_by` | uuid | Y |  |
| `metadata` | jsonb | N | `'{}'::jsonb` |

**Indexes:**
- `tenants_slug_key` USING btree (slug)

### `users`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N |  |
| `tenant_id` | uuid | N |  |
| `email` | text | N |  |
| `display_name` | text | Y |  |
| `role` | text | N | `'owner'::text` |
| `created_at` | timestamp with time zone | N | `now()` |

**Foreign keys:**
- `tenant_id` → `tenants.id`

**Indexes:**
- `idx_users_tenant` USING btree (tenant_id)

### `webhook_dumps`

| Column | Type | Nullable | Default |
| --- | --- | --- | --- |
| `id` | uuid | N | `gen_random_uuid()` |
| `received_at` | timestamp with time zone | N | `now()` |
| `payload` | jsonb | N |  |

**Indexes:**
- `idx_webhook_dumps_received_at` USING btree (received_at DESC)
