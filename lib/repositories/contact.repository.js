import supabase from '../supabase.js';

/**
 * Find contact by WhatsApp ID (phone number)
 * @param {string} waId - WhatsApp user ID (E.164 phone number)
 * @returns {Promise<Object|null>} - Contact object or null
 */
export async function findContactByWaId(waId) {
  if (!waId) return null;
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('wa_id', waId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data;
}

/**
 * Find contact by BSUID (Business Scoped User ID)
 * @param {string} bsuid - WhatsApp BSUID (e.g. "US.13491208655302741918")
 * @returns {Promise<Object|null>} - Contact object or null
 */
export async function findContactByBsuid(bsuid) {
  if (!bsuid) return null;
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('bsuid', bsuid)
    .single();

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
  const { data, error } = await supabase
    .from('contacts')
    .insert({
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
    return { waId: input, profileName: null, bsuid: null, username: null };
  }

  return {
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
  const { waId, profileName, bsuid, username } = normalizeFindOrCreateArgs(input);

  // 1. Try BSUID first (authoritative once available)
  let existing = await findContactByBsuid(bsuid);

  // 2. Fallback: try wa_id (phone number)
  if (!existing && waId) {
    existing = await findContactByWaId(waId);
  }

  // 3. Found — backfill any missing identifiers and return
  if (existing) {
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
      const retry = (await findContactByBsuid(bsuid)) || (await findContactByWaId(waId));
      if (retry) {
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
