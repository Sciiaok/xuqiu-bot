import supabase from '../supabase.js';

/**
 * 按 (tenantId, id) 查 product_line。
 *
 * tenantId 必填：product_lines.id 是用户起的 slug（"vehicle" / "agri_machinery"
 * 等），跨 tenant 一定会冲撞，必须先按 tenant 过滤。
 */
export async function findProductLineById({ tenantId, id }) {
  if (!tenantId) throw new Error('findProductLineById: tenantId required');
  if (!id) return null;
  const { data, error } = await supabase
    .from('product_lines')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * 按 phoneNumberId 反查 product_line（webhook 路由用）。
 *
 * phoneNumberId 是 Meta 全局唯一 ID，不跨 tenant 冲撞。返回行带 tenant_id，
 * 调用方据此推导后续所有查询的上下文。
 */
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

/**
 * 在已有 conversation 上回写 product_line（一次性写入）。
 * conversation.id 是 UUID 全局唯一，写入只动这一行的字段，无跨 tenant 风险。
 */
export async function setConversationProductLine(conversationId, productLine) {
  if (!conversationId || !productLine) return;
  const { error } = await supabase
    .from('conversations')
    .update({ product_line: productLine })
    .eq('id', conversationId);
  if (error) throw error;
}

/**
 * KB bridge: product_lines.id (slug) → agents.id (uuid)。
 * KB 行 (kb_*) 仍按 agent_id 主键，不动 schema；这里用 product_line slug
 * 反查绑定的 agent。tenantId 必填。
 */
export async function findAgentIdByProductLine({ tenantId, slug }) {
  if (!tenantId) throw new Error('findAgentIdByProductLine: tenantId required');
  if (!slug) return null;
  const { data, error } = await supabase
    .from('agents')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('product_line', slug)
    .maybeSingle();
  if (error) throw error;
  return data?.id || null;
}

export async function getAllProductLines({ tenantId, activeOnly = false }) {
  if (!tenantId) throw new Error('getAllProductLines: tenantId required');
  let q = supabase
    .from('product_lines')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });
  if (activeOnly) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function createProductLine({ tenantId, id, name }) {
  if (!tenantId) throw new Error('createProductLine: tenantId required');
  const { data, error } = await supabase
    .from('product_lines')
    .insert({
      tenant_id: tenantId,
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
export async function updateProductLine({ tenantId, id, updates }) {
  if (!tenantId) throw new Error('updateProductLine: tenantId required');
  const patch = { updated_at: new Date().toISOString() };
  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.catalog_description !== undefined) patch.catalog_description = updates.catalog_description;
  if (updates.domain_glossary !== undefined) patch.domain_glossary = updates.domain_glossary;
  if (updates.business_value_guidance !== undefined) patch.business_value_guidance = updates.business_value_guidance;
  if (updates.message_style_examples !== undefined) patch.message_style_examples = updates.message_style_examples;
  if (updates.faq_message !== undefined) patch.faq_message = updates.faq_message;
  if (updates.lead_fields !== undefined) patch.lead_fields = updates.lead_fields;
  if (updates.wa_phone_number_id !== undefined) patch.wa_phone_number_id = updates.wa_phone_number_id || null;
  if (updates.is_active !== undefined) patch.is_active = updates.is_active;

  const { data, error } = await supabase
    .from('product_lines')
    .update(patch)
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

