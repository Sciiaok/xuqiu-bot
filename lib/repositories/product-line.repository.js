import supabase from '../supabase.js';

/** Raw row fetch by product_line id (e.g. 'vehicle'). Returns null if missing. */
export async function findProductLineById(id) {
  if (!id) return null;
  const { data, error } = await supabase
    .from('product_lines')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/** Reverse lookup for phone→product_line deterministic routing. */
export async function findProductLineByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const { data, error } = await supabase
    .from('product_lines')
    .select('*')
    .eq('wa_phone_number_id', phoneNumberId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/** Persist the resolved product_line on a conversation (one-time write). */
export async function setConversationProductLine(conversationId, productLine) {
  if (!conversationId || !productLine) return;
  const { error } = await supabase
    .from('conversations')
    .update({ product_line: productLine })
    .eq('id', conversationId);
  if (error) throw error;
}

/**
 * KB bridge: product_lines.id (slug) → agents.id (uuid).
 *
 * Knowledge base rows (kb_*) are keyed on agent_id in the legacy schema, which
 * we don't touch. To serve KB from the product-lines detail page we resolve
 * the linked agent by matching the slug stored on agents.product_line.
 * Returns null if no agent is bound to this slug.
 */
export async function findAgentIdByProductLine(slug) {
  if (!slug) return null;
  const { data, error } = await supabase
    .from('agents')
    .select('id')
    .eq('product_line', slug)
    .maybeSingle();
  if (error) throw error;
  return data?.id || null;
}

export async function getAllProductLines(activeOnly = false) {
  let q = supabase.from('product_lines').select('*').order('created_at', { ascending: true });
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function createProductLine({ id, name }) {
  const { data, error } = await supabase
    .from('product_lines')
    .insert({
      id,
      name,
      lead_fields: [],
      is_active: true,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

/**
 * Partial update. Accepts any subset of the content / metadata fields.
 * wa_phone_number_id: pass `null` explicitly to unbind.
 */
export async function updateProductLine(id, updates) {
  const patch = { updated_at: new Date().toISOString() };
  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.catalog_description !== undefined) patch.catalog_description = updates.catalog_description;
  if (updates.domain_glossary !== undefined) patch.domain_glossary = updates.domain_glossary;
  if (updates.business_value_guidance !== undefined) patch.business_value_guidance = updates.business_value_guidance;
  if (updates.message_style_examples !== undefined) patch.message_style_examples = updates.message_style_examples;
  if (updates.lead_fields !== undefined) patch.lead_fields = updates.lead_fields;
  if (updates.wa_phone_number_id !== undefined) patch.wa_phone_number_id = updates.wa_phone_number_id || null;
  if (updates.is_active !== undefined) patch.is_active = updates.is_active;

  const { data, error } = await supabase
    .from('product_lines')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function deactivateProductLine(id) {
  const { data: active } = await supabase.from('product_lines').select('id').eq('is_active', true);
  if (active && active.length <= 1) {
    throw new Error('Cannot deactivate the last active product line');
  }
  return updateProductLine(id, { is_active: false });
}
