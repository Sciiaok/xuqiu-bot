import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../../src/config.js';

const TERMINAL_STATUSES = new Set(['closed', 'rejected']);

function storePath() {
  return config.requirementBot.storePath;
}

function defaultState() {
  return {
    meta: { version: 1 },
    settings: {},
    requirements: [],
    events: [],
    attachments: [],
    reminderLogs: [],
    counters: {},
  };
}

async function loadState() {
  try {
    const raw = await readFile(storePath(), 'utf8');
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn('[requirement-bot] store read failed, recreating:', err.message);
    }
    return defaultState();
  }
}

async function saveState(state) {
  const target = storePath();
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await rename(tmp, target);
}

async function mutateState(mutator) {
  const state = await loadState();
  const result = await mutator(state);
  await saveState(state);
  return result;
}

function nowIso() {
  return new Date().toISOString();
}

function requireTenantId(tenantId, caller) {
  if (!tenantId) throw new Error(`${caller}: tenantId required`);
}

function normalizeTenantId(tenantId) {
  return tenantId || config.feishu.requirementBotCallbackTenantId || 'local';
}

function envSettings() {
  return {
    tenant_id: normalizeTenantId(),
    enabled: config.requirementBot.enabled,
    feishu_app_id: config.requirementBot.feishuAppId,
    feishu_app_secret: config.requirementBot.feishuAppSecret,
    feishu_encrypt_key: config.requirementBot.feishuEncryptKey,
    feishu_verification_token: config.requirementBot.feishuVerificationToken,
    default_chat_id: config.requirementBot.defaultChatId,
    default_pm_feishu_user_id: config.requirementBot.defaultPmFeishuUserId,
    default_developer_feishu_user_id: config.requirementBot.defaultDeveloperFeishuUserId,
    default_tester_feishu_user_id: config.requirementBot.defaultTesterFeishuUserId,
    default_acceptor_feishu_user_id: config.requirementBot.defaultAcceptorFeishuUserId,
    bitable_app_token: config.requirementBot.bitableAppToken,
    bitable_table_id: config.requirementBot.bitableTableId,
    reminder_hour: config.requirementBot.reminderHour,
  };
}

function publicSettings(row) {
  if (!row) return null;
  const copy = { ...row };
  copy.has_secret = Boolean(copy.feishu_app_secret);
  copy.has_encrypt_key = Boolean(copy.feishu_encrypt_key);
  copy.has_verification_token = Boolean(copy.feishu_verification_token);
  delete copy.feishu_app_secret;
  delete copy.feishu_encrypt_key;
  delete copy.feishu_verification_token;
  return copy;
}

function mergeSettings(tenantId, stored = {}) {
  const env = envSettings();
  return {
    ...stored,
    ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '' && value != null)),
    tenant_id: tenantId,
    enabled: stored.enabled ?? env.enabled,
    reminder_hour: Number(stored.reminder_hour ?? env.reminder_hour ?? 10),
  };
}

export async function getRequirementBotSettings(tenantId, { includeSecrets = false } = {}) {
  const resolvedTenantId = normalizeTenantId(tenantId);
  const state = await loadState();
  const settings = mergeSettings(resolvedTenantId, state.settings[resolvedTenantId] || {});
  return includeSecrets ? settings : publicSettings(settings);
}

export async function saveRequirementBotSettings(tenantId, input = {}) {
  requireTenantId(tenantId, 'saveRequirementBotSettings');
  return mutateState(state => {
    const existing = state.settings[tenantId] || {};
    const next = {
      ...existing,
      tenant_id: tenantId,
      updated_at: nowIso(),
      enabled: Boolean(input.enabled),
      reminder_hour: Number(input.reminder_hour ?? existing.reminder_hour ?? 10),
    };

    for (const field of [
      'feishu_app_id',
      'feishu_app_secret',
      'feishu_encrypt_key',
      'feishu_verification_token',
      'default_chat_id',
      'default_pm_feishu_user_id',
      'default_developer_feishu_user_id',
      'default_tester_feishu_user_id',
      'default_acceptor_feishu_user_id',
      'bitable_app_token',
      'bitable_table_id',
    ]) {
      if (Object.prototype.hasOwnProperty.call(input, field)) {
        next[field] = input[field] || '';
      }
    }

    state.settings[tenantId] = next;
    return publicSettings(mergeSettings(tenantId, next));
  });
}

export async function nextRequirementNo() {
  return mutateState(state => {
    const d = new Date();
    const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    state.counters[yyyymmdd] = Number(state.counters[yyyymmdd] || 0) + 1;
    return `REQ-${yyyymmdd}-${String(state.counters[yyyymmdd]).padStart(3, '0')}`;
  });
}

export async function createRequirement(row) {
  requireTenantId(row?.tenant_id, 'createRequirement');
  return mutateState(state => {
    const now = nowIso();
    const item = {
      id: row.id || randomUUID(),
      created_at: now,
      updated_at: now,
      last_status_changed_at: now,
      bitable_sync_status: 'pending',
      ...row,
    };
    state.requirements.push(item);
    return item;
  });
}

export async function createRequirementWithEvent({ tenantId, requirement, event }) {
  requireTenantId(tenantId, 'createRequirementWithEvent');
  return mutateState(state => {
    const now = nowIso();
    const created = {
      id: requirement.id || randomUUID(),
      created_at: now,
      updated_at: now,
      last_status_changed_at: now,
      bitable_sync_status: 'pending',
      ...requirement,
      tenant_id: tenantId,
    };
    state.requirements.push(created);
    state.events.push({
      id: randomUUID(),
      tenant_id: tenantId,
      requirement_id: created.id,
      actor_feishu_user_id: event?.actorFeishuUserId || null,
      action: event?.action || 'create_from_feishu',
      from_status: null,
      to_status: created.status || null,
      details: event?.details || {},
      created_at: now,
    });
    return created;
  });
}

export async function getRequirementById({ tenantId, id }) {
  requireTenantId(tenantId, 'getRequirementById');
  const state = await loadState();
  return state.requirements.find(item => item.tenant_id === tenantId && item.id === id) || null;
}

export async function listRequirements({ tenantId, filters = {}, limit = 100 }) {
  requireTenantId(tenantId, 'listRequirements');
  const state = await loadState();
  return state.requirements
    .filter(item => item.tenant_id === tenantId)
    .filter(item => !filters.status || item.status === filters.status)
    .filter(item => !filters.priority || item.priority === filters.priority)
    .filter(item => !filters.current_owner || item.current_owner_feishu_user_id === filters.current_owner)
    .filter(item => !filters.requirement_type || item.requirement_type === filters.requirement_type)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, Number(limit || 100));
}

export async function updateRequirement({ tenantId, id, patch }) {
  requireTenantId(tenantId, 'updateRequirement');
  return mutateState(state => {
    const index = state.requirements.findIndex(item => item.tenant_id === tenantId && item.id === id);
    if (index < 0) throw new Error('Requirement not found');
    const existing = state.requirements[index];
    const next = {
      ...existing,
      ...patch,
      updated_at: nowIso(),
    };
    state.requirements[index] = next;
    return next;
  });
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
  return mutateState(state => {
    const event = {
      id: randomUUID(),
      tenant_id: tenantId,
      requirement_id: requirementId,
      actor_feishu_user_id: actorFeishuUserId || null,
      action,
      from_status: fromStatus || null,
      to_status: toStatus || null,
      details,
      created_at: nowIso(),
    };
    state.events.push(event);
    return event;
  });
}

export async function listRequirementEvents({ tenantId, requirementId }) {
  requireTenantId(tenantId, 'listRequirementEvents');
  const state = await loadState();
  return state.events
    .filter(item => item.tenant_id === tenantId && item.requirement_id === requirementId)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

export async function addRequirementAttachment(row) {
  requireTenantId(row?.tenant_id, 'addRequirementAttachment');
  return mutateState(state => {
    const attachment = {
      id: row.id || randomUUID(),
      created_at: nowIso(),
      ...row,
    };
    state.attachments.push(attachment);
    return attachment;
  });
}

export async function listRequirementAttachments({ tenantId, requirementId }) {
  requireTenantId(tenantId, 'listRequirementAttachments');
  const state = await loadState();
  return state.attachments
    .filter(item => item.tenant_id === tenantId && item.requirement_id === requirementId)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

export async function listRequirementsForReminder({ tenantId }) {
  requireTenantId(tenantId, 'listRequirementsForReminder');
  const state = await loadState();
  return state.requirements
    .filter(item => item.tenant_id === tenantId && !TERMINAL_STATUSES.has(item.status))
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')));
}

export async function recordRequirementReminder(row) {
  requireTenantId(row?.tenant_id, 'recordRequirementReminder');
  return mutateState(state => {
    const log = {
      id: row.id || randomUUID(),
      created_at: nowIso(),
      ...row,
    };
    state.reminderLogs.push(log);
    return log;
  });
}
