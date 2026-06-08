import supabase from '../supabase.js';
import { encryptToken, decryptToken } from '../meta-token-crypto.js';

const SECRET_FIELDS = [
  'feishu_app_secret_encrypted',
  'feishu_encrypt_key_encrypted',
  'feishu_verification_token_encrypted',
];

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

export async function saveRequirementBotSettings(tenantId, input) {
  requireTenantId(tenantId, 'saveRequirementBotSettings');

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

  if (Object.prototype.hasOwnProperty.call(input, 'feishu_app_secret')) {
    row.feishu_app_secret_encrypted = input.feishu_app_secret
      ? encryptToken(input.feishu_app_secret)
      : null;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'feishu_encrypt_key')) {
    row.feishu_encrypt_key_encrypted = input.feishu_encrypt_key
      ? encryptToken(input.feishu_encrypt_key)
      : null;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'feishu_verification_token')) {
    row.feishu_verification_token_encrypted = input.feishu_verification_token
      ? encryptToken(input.feishu_verification_token)
      : null;
  }

  const { data, error } = await supabase
    .from('requirement_bot_settings')
    .upsert(row, { onConflict: 'tenant_id' })
    .select('*')
    .single();
  if (error) throw error;
  return withoutEncryptedSecrets(data);
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
