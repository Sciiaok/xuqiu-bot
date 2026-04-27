import supabase from '../supabase.js';

/**
 * Onboarding progress writer：仅在第一次发生时写入 timestamp。
 * 多次触发同一字段不覆盖（保留首次时间）。
 */
async function markFieldOnce(tenantId, field) {
  if (!tenantId || !field) return;
  // 先查 —— 避免并发场景下没必要的 update
  const { data: existing } = await supabase
    .from('onboarding_progress')
    .select(`tenant_id, ${field}`)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!existing) {
    // 第一次访问：upsert 行
    await supabase
      .from('onboarding_progress')
      .upsert({ tenant_id: tenantId, [field]: new Date().toISOString() },
        { onConflict: 'tenant_id', ignoreDuplicates: false });
    return;
  }

  if (!existing[field]) {
    await supabase
      .from('onboarding_progress')
      .update({ [field]: new Date().toISOString() })
      .eq('tenant_id', tenantId);
  }
}

export const markMetaConnected = (tenantId) => markFieldOnce(tenantId, 'meta_connected_at');
export const markFirstProductLine = (tenantId) => markFieldOnce(tenantId, 'first_product_line_at');
export const markFirstKbUpload = (tenantId) => markFieldOnce(tenantId, 'first_kb_uploaded_at');
export const markFirstMessageReceived = (tenantId) => markFieldOnce(tenantId, 'first_message_received_at');
export const markFirstAiReply = (tenantId) => markFieldOnce(tenantId, 'first_ai_reply_at');

export async function getProgress(tenantId) {
  if (!tenantId) return null;
  const { data, error } = await supabase
    .from('onboarding_progress')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function dismissOnboarding(tenantId) {
  await supabase
    .from('onboarding_progress')
    .upsert({ tenant_id: tenantId, dismissed_at: new Date().toISOString() },
      { onConflict: 'tenant_id', ignoreDuplicates: false });
}
