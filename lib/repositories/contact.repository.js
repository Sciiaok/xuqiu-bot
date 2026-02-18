import supabase from '../supabase.js';

/**
 * Find contact by WhatsApp ID
 * @param {string} waId - WhatsApp user ID
 * @returns {Promise<Object|null>} - Contact object or null
 */
export async function findContactByWaId(waId) {
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
 * Create a new contact
 * @param {Object} contactData - Contact data
 * @returns {Promise<Object>} - Created contact
 */
export async function createContact(contactData) {
  const { data, error } = await supabase
    .from('contacts')
    .insert({
      wa_id: contactData.waId,
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

/**
 * Find or create contact by WhatsApp ID
 * Uses find-first pattern to avoid upsert + ignoreDuplicates issues
 * @param {string} waId - WhatsApp user ID
 * @returns {Promise<Object>} - Contact object
 */
export async function findOrCreateContact(waId) {
  // First, try to find existing contact
  const existing = await findContactByWaId(waId);
  if (existing) {
    return existing;
  }

  // Not found, create new contact
  const { data, error } = await supabase
    .from('contacts')
    .insert({
      wa_id: waId,
      metadata: {},
    })
    .select()
    .single();

  if (error) {
    // Race condition: another request may have created the contact
    if (error.code === '23505') { // unique_violation
      const existing2 = await findContactByWaId(waId);
      if (existing2) return existing2;
    }
    throw error;
  }

  return data;
}
