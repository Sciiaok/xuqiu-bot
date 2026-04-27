import {
  listAdAccountsByTenant,
  getActiveTokenByTenant,
} from './repositories/meta-connection.repository.js';

/**
 * Server-side helpers：把"当前 tenant 该用哪个 Meta token / ad account"封装起来。
 *
 * 单一路径：所有 tenant（含 founder）必须先通过 /settings/meta-connection 接入
 * BM。没接 → 返 null，路由层 409。无 env fallback。
 */

export async function resolveMetaContextForTenant(tenantId) {
  if (!tenantId) {
    return { accessToken: null, adAccountId: null };
  }
  const [token, adAccount] = await Promise.all([
    getActiveTokenByTenant(tenantId),
    listAdAccountsByTenant(tenantId).then(rows => rows[0] || null),
  ]);
  return {
    accessToken: token || null,
    adAccountId: adAccount?.ad_account_id || null,
  };
}

export async function resolveMetaTokenForTenant(tenantId) {
  if (!tenantId) return null;
  return (await getActiveTokenByTenant(tenantId)) || null;
}
