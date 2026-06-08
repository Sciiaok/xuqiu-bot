import supabase from '../supabase.js';
import { encryptToken, decryptToken } from '../meta-token-crypto.js';

const SECRET_FIELDS = [
  'feishu_app_secret_encrypted',
  'feishu_encrypt_key_encrypted',
  'feishu_verification_token_encrypted',
];

const SETTINGS_MUTABLE_FIELDS = [
  'feishu_app_id',
  'default_chat_id',
  'default_pm_feishu_user_id',
  'default_developer_feishu_user_id',
  'default_tester_feishu_user_id',
  'default_acceptor_feishu_user_id',
  'bitable_app_token',
  'bitable_table_id',
  'reminder_hour',
  'enabled',
];

const REQUIREMENT_MUTABLE_FIELDS = new Set([
  'title',
  'raw_description',
  'status',
  'requirement_type',
  'prd_template_type',
  'priority',
  'priority_reason',
  'submitter_feishu_user_id',
  'pm_owner_feishu_user_id',
  'developer_feishu_user_id',
  'tester_feishu_user_id',
  'acceptor_feishu_user_id',
  'current_owner_feishu_user_id',
  'feishu_root_message_id',
  'feishu_card_message_id',
  'feishu_message_url',
  'feishu_card_url',
  'bitable_record_id',
  'bitable_sync_status',
  'bitable_last_error',
  'ai_confidence',
  'ai_raw_output',
  'prd',
  'pm_due_at',
  'dev_due_at',
  'test_due_at',
  'acceptance_due_at',
  'planned_release_at',
  'actual_release_at',
  'closed_at',
  'blocked_reason',
  'latest_rejection_reason',
  'last_status_changed_at',
  'last_reminded_at',
]);

function requireTenantId(tenantId, caller) {
  if (!tenantId) throw new Error(`${caller}: tenantId required`);
}

function withoutEncryptedSecrets(row) {
  if (!row) return null;
  const copy = { ...row };
  for (const field of SECRET_FIELDS) delete copy[field];
  return copy;
}

function decryptSettingsSecrets(row) {
  if (!row) return null;
  return {
    ...row,
    feishu_app_secret: row.feishu_app_secret_encrypted
      ? decryptToken(row.feishu_app_secret_encrypted)
      : '',
    feishu_encrypt_key: row.feishu_encrypt_key_encrypted
      ? decryptToken(row.feishu_encrypt_key_encrypted)
      : '',
    feishu_verification_token: row.feishu_verification_token_encrypted
      ? decryptToken(row.feishu_verification_token_encrypted)
      : '',
  };
}

export async function getRequirementBotSettings(tenantId, { includeSecrets = false } = {}) {
  if (!tenantId) return null;
  const { data, error } = await supabase
    .from('requirement_bot_settings')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return includeSecrets ? decryptSettingsSecrets(data) : withoutEncryptedSecrets(data);
}

export async function saveRequirementBotSettings(tenantId, input = {}) {
  requireTenantId(tenantId, 'saveRequirementBotSettings');

  const { data: existing, error: existingError } = await supabase
    .from('requirement_bot_settings')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (existingError) throw existingError;

  const row = {
    ...(existing || {}),
    tenant_id: tenantId,
    updated_at: new Date().toISOString(),
  };

  for (const field of SETTINGS_MUTABLE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      if (field === 'reminder_hour') {
        row[field] = input[field] === '' ? existing?.reminder_hour ?? 10 : Number(input[field]);
      } else {
        row[field] = input[field] === '' ? null : input[field];
      }
    }
  }

  if (!existing && !Object.prototype.hasOwnProperty.call(input, 'reminder_hour')) {
    row.reminder_hour = 10;
  }
  if (!existing && !Object.prototype.hasOwnProperty.call(input, 'enabled')) {
    row.enabled = false;
  }

  if (input.feishu_app_secret) {
    row.feishu_app_secret_encrypted = encryptToken(input.feishu_app_secret);
  }
  if (input.feishu_encrypt_key) {
    row.feishu_encrypt_key_encrypted = encryptToken(input.feishu_encrypt_key);
  }
  if (input.feishu_verification_token) {
    row.feishu_verification_token_encrypted = encryptToken(input.feishu_verification_token);
  }

  if (row.reminder_hour != null) {
    row.reminder_hour = Number(row.reminder_hour);
  }
  if (Object.prototype.hasOwnProperty.call(row, 'enabled')) {
    row.enabled = Boolean(row.enabled);
  }

  const { data, error } = await supabase
    .from('requirement_bot_settings')
    .upsert(row, { onConflict: 'tenant_id' })
    .select('*')
    .single();
  if (error) throw error;
  return withoutEncryptedSecrets(data);
}

function pickRequirementPatch(patch) {
  const safePatch = {};
  for (const [key, value] of Object.entries(patch || {})) {
    if (REQUIREMENT_MUTABLE_FIELDS.has(key)) {
      safePatch[key] = value;
    }
  }
  return safePatch;
}

export async function nextRequirementNo() {
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const { data, error } = await supabase.rpc('next_requirement_req_no');
  if (error) throw error;
  return `REQ-${yyyymm}-${String(data).padStart(4, '0')}`;
}

export async function createRequirement(row) {
  requireTenantId(row?.tenant_id, 'createRequirement');
  const { data, error } = await supabase
    .from('requirements')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function createRequirementWithEvent({ tenantId, requirement, event }) {
  requireTenantId(tenantId, 'createRequirementWithEvent');
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

export async function getRequirementById({ tenantId, id }) {
  requireTenantId(tenantId, 'getRequirementById');
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
  requireTenantId(tenantId, 'listRequirements');
  let query = supabase
    .from('requirements')
    .select('*')
    .eq('tenant_id', tenantId);

  if (filters.status) query = query.eq('status', filters.status);
  if (filters.priority) query = query.eq('priority', filters.priority);
  if (filters.current_owner) {
    query = query.eq('current_owner_feishu_user_id', filters.current_owner);
  }
  if (filters.requirement_type) {
    query = query.eq('requirement_type', filters.requirement_type);
  }

  const { data, error } = await query
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function updateRequirement({ tenantId, id, patch }) {
  requireTenantId(tenantId, 'updateRequirement');
  const safePatch = pickRequirementPatch(patch);
  const { data, error } = await supabase
    .from('requirements')
    .update({ ...safePatch, updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function addRequirementEvent({
  tenantId,
  requirementId,
  actorFeishuUserId,
  action,
  fromStatus,
  toStatus,
  details = {},
}) {
  requireTenantId(tenantId, 'addRequirementEvent');
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
  requireTenantId(tenantId, 'listRequirementEvents');
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
  requireTenantId(row?.tenant_id, 'addRequirementAttachment');
  const { data, error } = await supabase
    .from('requirement_attachments')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function listRequirementAttachments({ tenantId, requirementId }) {
  requireTenantId(tenantId, 'listRequirementAttachments');
  const { data, error } = await supabase
    .from('requirement_attachments')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('requirement_id', requirementId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function listRequirementsForReminder({ tenantId }) {
  requireTenantId(tenantId, 'listRequirementsForReminder');
  const { data, error } = await supabase
    .from('requirements')
    .select('*')
    .eq('tenant_id', tenantId)
    .not('status', 'in', '(closed,rejected)')
    .order('priority', { ascending: true })
    .order('updated_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function recordRequirementReminder(row) {
  requireTenantId(row?.tenant_id, 'recordRequirementReminder');
  const { data, error } = await supabase
    .from('requirement_reminder_logs')
    .insert(row)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}
