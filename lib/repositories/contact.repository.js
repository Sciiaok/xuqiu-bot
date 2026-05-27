import supabase from '../supabase.js';
import { recordAudit } from './audit-log.repository.js';

/**
 * Find contact by (tenantId, waId).
 *
 * 同一个 wa_id（手机号）可能同时是 tenant A 和 tenant B 的客户（同一个人
 * 联系了两家公司的 WA 号），所以查询必须按 tenant 过滤；不传 tenantId 时
 * 走全局查（兼容老调用方，但仅用于 V1 founder-only 单租户场景）。
 */
export async function findContactByWaId(waId, { tenantId } = {}) {
  if (!waId) return null;
  let q = supabase.from('contacts').select('*').eq('wa_id', waId);
  if (tenantId) q = q.eq('tenant_id', tenantId);
  const { data, error } = await q.single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data;
}

/**
 * Find contact by BSUID. 同 waId 一样，BSUID 也是 per-tenant 的，传 tenantId
 * 严格隔离；老调用方不传则全局查。
 */
export async function findContactByBsuid(bsuid, { tenantId } = {}) {
  if (!bsuid) return null;
  let q = supabase.from('contacts').select('*').eq('bsuid', bsuid);
  if (tenantId) q = q.eq('tenant_id', tenantId);
  const { data, error } = await q.single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data;
}

/**
 * Find contact by ID
 * @param {string} contactId - Contact UUID
 * @returns {Promise<Object|null>} - Contact object or null
 */
export async function findContactById(contactId) {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', contactId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data;
}

/**
 * Create a new contact
 * @param {Object} contactData - Contact data
 * @returns {Promise<Object>} - Created contact
 */
export async function createContact(contactData) {
  if (!contactData.tenantId) {
    throw new Error('createContact: tenantId required');
  }
  const { data, error } = await supabase
    .from('contacts')
    .insert({
      tenant_id: contactData.tenantId,
      wa_id: contactData.waId || null,
      bsuid: contactData.bsuid || null,
      username: contactData.username || null,
      name: contactData.name || null,
      company_name: contactData.companyName || null,
      metadata: contactData.metadata || {},
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

/**
 * Update contact
 * @param {string} contactId - Contact UUID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Updated contact
 */
export async function updateContact(contactId, updates) {
  const { data, error } = await supabase
    .from('contacts')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('id', contactId)
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

export async function updateContactMetadata(contactId, metadata) {
  return updateContact(contactId, { metadata: metadata || {} });
}

function normalizeFindOrCreateArgs(input) {
  if (typeof input === 'string') {
    return { tenantId: null, waId: input, profileName: null, bsuid: null, username: null };
  }

  return {
    tenantId: input?.tenantId || null,
    waId: input?.waId || null,
    profileName: input?.profileName?.trim() || null,
    bsuid: input?.bsuid || null,
    username: input?.username || null,
  };
}

/**
 * Build the update payload for backfilling new fields on an existing contact.
 * Returns null if nothing needs updating.
 */
function buildBackfillUpdates(existing, { profileName, bsuid, username, waId }) {
  const updates = {};

  if (profileName && existing.name !== profileName) {
    updates.name = profileName;
  }
  // Backfill BSUID onto a contact originally created with phone number only
  if (bsuid && !existing.bsuid) {
    updates.bsuid = bsuid;
  }
  // Backfill phone number onto a contact originally created with BSUID only
  if (waId && !existing.wa_id) {
    updates.wa_id = waId;
  }
  // Update username if changed
  if (username && existing.username !== username) {
    updates.username = username;
  }

  return Object.keys(updates).length > 0 ? updates : null;
}

/**
 * 检测进入的 (bsuid, waId) 跟现有 contact 的标识不一致，写一条 audit_log。
 *
 * 两种 case 都是"罕见但值得观测"：
 *   - bsuid_changed: 命中是按 wa_id 匹的，但现有 bsuid 跟新 bsuid 不同 ——
 *     同一个号码挂到了另一个 WhatsApp 账号，可能账号被回收、号段被转售
 *   - wa_id_changed: 命中是按 bsuid 匹的，但现有 wa_id 跟新 waId 不同 ——
 *     真人换号（保留 WA 账号），跨国搬家、SIM 换号
 *
 * 当前不做任何自动合并 / 覆写，只把现场记到 audit_log 让后续工具决定。
 * fire-and-forget，failure 不阻断主流程。
 */
function detectIdentifierMismatch(existing, { bsuid, waId }) {
  if (existing.bsuid && bsuid && existing.bsuid !== bsuid) {
    return {
      action: 'contact.bsuid_changed',
      details: {
        contact_id: existing.id,
        wa_id: existing.wa_id,
        old_bsuid: existing.bsuid,
        new_bsuid: bsuid,
      },
    };
  }
  if (existing.wa_id && waId && existing.wa_id !== waId) {
    return {
      action: 'contact.wa_id_changed',
      details: {
        contact_id: existing.id,
        bsuid: existing.bsuid,
        old_wa_id: existing.wa_id,
        new_wa_id: waId,
      },
    };
  }
  return null;
}

function flagIdentifierMismatch(existing, { bsuid, waId }) {
  const mismatch = detectIdentifierMismatch(existing, { bsuid, waId });
  if (!mismatch) return;
  recordAudit({
    tenantId: existing.tenant_id,
    action: mismatch.action,
    details: mismatch.details,
  }).catch((err) => {
    console.warn('[contact] audit_log identifier_mismatch failed:', err.message);
  });
}

/**
 * Find or create contact — dual-key lookup supporting both wa_id and BSUID.
 *
 * Lookup order:
 *   1. BSUID (most reliable, always present once rolled out)
 *   2. wa_id / phone number (legacy, may be absent for username-initiated contacts)
 *
 * When an existing contact is found via one key and the other key is newly available,
 * it is backfilled to link the two identifiers together (prevents duplicate contacts).
 *
 * @param {string|Object} input - WhatsApp user ID or { waId, profileName, bsuid, username }
 * @returns {Promise<Object>} - Contact object
 */
export async function findOrCreateContact(input) {
  const { tenantId, waId, profileName, bsuid, username } = normalizeFindOrCreateArgs(input);
  if (!tenantId) {
    throw new Error('findOrCreateContact: tenantId required');
  }

  // 1. Try BSUID first (authoritative once available)
  let existing = await findContactByBsuid(bsuid, { tenantId });

  // 2. Fallback: try wa_id (phone number)
  if (!existing && waId) {
    existing = await findContactByWaId(waId, { tenantId });
  }

  // 3. Found — backfill any missing identifiers and return
  if (existing) {
    flagIdentifierMismatch(existing, { bsuid, waId });
    const updates = buildBackfillUpdates(existing, { profileName, bsuid, username, waId });
    if (updates) {
      return await updateContact(existing.id, updates);
    }
    return existing;
  }

  // 4. Not found — create new contact
  const { data, error } = await supabase
    .from('contacts')
    .insert({
      tenant_id: tenantId,
      wa_id: waId || null,
      bsuid: bsuid || null,
      username: username || null,
      name: profileName,
      metadata: {},
    })
    .select()
    .single();

  if (error) {
    // Race condition: another request may have created the contact
    if (error.code === '23505') { // unique_violation
      // Could be duplicate on wa_id OR bsuid — try both lookups again
      const retry = (await findContactByBsuid(bsuid, { tenantId }))
        || (await findContactByWaId(waId, { tenantId }));
      if (retry) {
        flagIdentifierMismatch(retry, { bsuid, waId });
        const updates = buildBackfillUpdates(retry, { profileName, bsuid, username, waId });
        if (updates) {
          return await updateContact(retry.id, updates);
        }
        return retry;
      }
    }
    throw error;
  }

  return data;
}
