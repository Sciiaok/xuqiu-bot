import supabase from '../supabase.js';

/**
 * Audit log writer — best-effort，写失败仅 console.warn 不抛错（不影响主路径）。
 */
export async function recordAudit({
  tenantId = null,
  actorUserId = null,
  actorEmail = null,
  action,
  details = {},
  ipAddress = null,
}) {
  if (!action) return;
  try {
    await supabase.from('audit_log').insert({
      tenant_id: tenantId,
      actor_user_id: actorUserId,
      actor_email: actorEmail,
      action,
      details,
      ip_address: ipAddress,
    });
  } catch (err) {
    console.warn('[audit-log] write failed:', err.message);
  }
}

export async function listAuditByTenant(tenantId, { limit = 100 } = {}) {
  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function listAuditAll({ limit = 200 } = {}) {
  const { data, error } = await supabase
    .from('audit_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}
