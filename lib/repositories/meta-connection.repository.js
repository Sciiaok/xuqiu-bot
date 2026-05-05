import supabase from '../supabase.js';
import { encryptToken, decryptToken } from '../meta-token-crypto.js';

/**
 * Meta connection / phone / ad account CRUD.
 *
 * Token 在仓储层做加解密，调用方拿到的是明文字符串。一律按 tenant 过滤，不
 * 跨租户查询。
 */

// ── meta_connections ────────────────────────────────────────────────────

export async function findActiveConnectionByTenant(tenantId) {
  if (!tenantId) return null;
  const { data, error } = await supabase
    .from('meta_connections')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getActiveTokenByTenant(tenantId) {
  const conn = await findActiveConnectionByTenant(tenantId);
  if (!conn) return null;
  return decryptToken(conn.system_user_token_encrypted);
}

/**
 * 通过一个 phoneNumberId 反查它属于哪个 tenant 的哪个 active connection，
 * 同时返回明文 token 给 outbound 路径用。
 */
export async function findConnectionByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const { data: phone, error: phoneErr } = await supabase
    .from('meta_phone_numbers')
    .select('tenant_id, meta_connection_id, waba_id, status')
    .eq('phone_number_id', phoneNumberId)
    .eq('status', 'active')
    .maybeSingle();
  if (phoneErr) throw phoneErr;
  if (!phone) return null;

  const { data: conn, error: connErr } = await supabase
    .from('meta_connections')
    .select('*')
    .eq('id', phone.meta_connection_id)
    .eq('status', 'active')
    .maybeSingle();
  if (connErr) throw connErr;
  if (!conn) return null;

  return {
    tenantId: phone.tenant_id,
    wabaId: phone.waba_id,
    connection: conn,
    token: decryptToken(conn.system_user_token_encrypted),
  };
}

/**
 * 创建 active connection。如果该 tenant 已有 active 连接，先把它标 disconnected
 * 防止 partial-unique 索引冲撞。
 */
export async function createConnection({
  tenantId,
  bmId,
  businessName = null,
  token,
  scopes = [],
  connectedByUserId = null,
  metadata = {},
}) {
  if (!tenantId || !bmId || !token) {
    throw new Error('createConnection: tenantId, bmId, token are required');
  }

  // 标记旧 active 为 disconnected
  await supabase
    .from('meta_connections')
    .update({ status: 'disconnected', disconnected_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('status', 'active');

  const encrypted = encryptToken(token);

  const { data, error } = await supabase
    .from('meta_connections')
    .insert({
      tenant_id: tenantId,
      bm_id: bmId,
      business_name: businessName,
      system_user_token_encrypted: encrypted,
      scopes,
      status: 'active',
      connected_by_user_id: connectedByUserId,
      metadata,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateConnectionMetadata(connectionId, patch) {
  const { data, error } = await supabase
    .from('meta_connections')
    .select('metadata')
    .eq('id', connectionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`meta_connection ${connectionId} not found`);

  const merged = { ...(data.metadata || {}), ...patch };
  const { error: upErr } = await supabase
    .from('meta_connections')
    .update({ metadata: merged })
    .eq('id', connectionId);
  if (upErr) throw upErr;
  return merged;
}

export async function markConnectionDisconnected(connectionId) {
  const { error } = await supabase
    .from('meta_connections')
    .update({ status: 'disconnected', disconnected_at: new Date().toISOString() })
    .eq('id', connectionId);
  if (error) throw error;
}

export async function markConnectionRevoked(connectionId) {
  const { error } = await supabase
    .from('meta_connections')
    .update({ status: 'revoked', disconnected_at: new Date().toISOString() })
    .eq('id', connectionId);
  if (error) throw error;
}

export async function recordHealthCheck(connectionId, { success, failedCount }) {
  const patch = {
    last_health_check_at: new Date().toISOString(),
    health_check_failed_count: failedCount,
  };
  if (!success && failedCount >= 3) {
    patch.status = 'revoked';
    patch.disconnected_at = new Date().toISOString();
  }
  const { error } = await supabase
    .from('meta_connections')
    .update(patch)
    .eq('id', connectionId);
  if (error) throw error;
}

// ── meta_phone_numbers ──────────────────────────────────────────────────

export async function listPhonesByTenant(tenantId) {
  if (!tenantId) return [];
  const { data, error } = await supabase
    .from('meta_phone_numbers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .order('display_number', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function upsertPhone({
  phoneNumberId,
  tenantId,
  metaConnectionId,
  wabaId,
  displayNumber,
  verifiedName = null,
  qualityRating = null,
  codeVerificationStatus = null,
  isRegistered = false,
}) {
  const { data, error } = await supabase
    .from('meta_phone_numbers')
    .upsert({
      phone_number_id: phoneNumberId,
      tenant_id: tenantId,
      meta_connection_id: metaConnectionId,
      waba_id: wabaId,
      display_number: displayNumber,
      verified_name: verifiedName,
      quality_rating: qualityRating,
      code_verification_status: codeVerificationStatus,
      is_registered: isRegistered,
      synced_at: new Date().toISOString(),
      status: 'active',
    }, { onConflict: 'phone_number_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function removePhonesByConnection(connectionId) {
  // 解绑用：硬删避免软删 + PK 撞（同号码再连时 upsert 会复活）
  const { error } = await supabase
    .from('meta_phone_numbers')
    .delete()
    .eq('meta_connection_id', connectionId);
  if (error) throw error;
}

// ── meta_ad_accounts ────────────────────────────────────────────────────

export async function listAdAccountsByTenant(tenantId) {
  if (!tenantId) return [];
  const { data, error } = await supabase
    .from('meta_ad_accounts')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'active')
    .order('name', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function upsertAdAccount({
  adAccountId,
  tenantId,
  metaConnectionId,
  name = null,
  currency = null,
  timezone = null,
  accountStatus = null,
}) {
  const { data, error } = await supabase
    .from('meta_ad_accounts')
    .upsert({
      ad_account_id: adAccountId,
      tenant_id: tenantId,
      meta_connection_id: metaConnectionId,
      name,
      currency,
      timezone,
      account_status: accountStatus,
      synced_at: new Date().toISOString(),
      status: 'active',
    }, { onConflict: 'ad_account_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function removeAdAccountsByConnection(connectionId) {
  const { error } = await supabase
    .from('meta_ad_accounts')
    .delete()
    .eq('meta_connection_id', connectionId);
  if (error) throw error;
}
