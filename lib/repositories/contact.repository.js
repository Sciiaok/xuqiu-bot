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
 * @param {string} waId - WhatsApp user ID
 * @returns {Promise<Object>} - Contact object
 */
export async function findOrCreateContact(waId) {
  let contact = await findContactByWaId(waId);

  if (!contact) {
    contact = await createContact({ waId });
    console.log(`Created new contact for ${waId}`);
  }

  return contact;
}
