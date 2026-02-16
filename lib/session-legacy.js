import supabase from './supabase.js';

/**
 * Get or create a session for a WhatsApp user
 * @param {string} waId - WhatsApp user ID
 * @returns {Promise<Object>} - Session object
 */
export async function getSession(waId) {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('wa_id', waId)
    .single();

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = row not found; any other error is real
    console.error('Supabase getSession error:', error);
    throw error;
  }

  if (data) {
    console.log(`Loaded existing session for ${waId}`);
    return data;
  }

  // Create new session
  const newSession = {
    wa_id: waId,
    messages: [],
    stage: 'GREET',
    stage_turn_count: 0,
    score: 0,
    score_history: [],
    risk_flags: [],
    lead_data: {
      destination_country: '',
      destination_port: '',
      qty_bucket: '',
      car_model: '',
      company_name: '',
      loading_port: '',
      buyer_type: '',
      timeline: '',
      budget_indication: '',
      international_commercial_term: '',
    },
  };

  const { data: created, error: createError } = await supabase
    .from('sessions')
    .insert(newSession)
    .select()
    .single();

  if (createError) {
    console.error('Supabase createSession error:', createError);
    throw createError;
  }

  console.log(`Created new session for ${waId}`);
  return created;
}

/**
 * Update a session after processing a message
 * @param {string} waId - WhatsApp user ID
 * @param {Object} updates - Fields to update on the session
 * @returns {Promise<Object>} - Updated session object
 */
export async function updateSession(waId, updates) {
  const { data, error } = await supabase
    .from('sessions')
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq('wa_id', waId)
    .select()
    .single();

  if (error) {
    console.error('Supabase updateSession error:', error);
    throw error;
  }

  console.log(`Session updated for ${waId}`);
  return data;
}
