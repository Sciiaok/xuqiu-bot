/**
 * 用一个 token 反查它绑定的 Business Manager。
 *
 * Token 类型差异：
 *   - USER token：/me/businesses 返回该 user 名下所有 BM 数组
 *   - SYSTEM_USER token：/me/businesses 返回 { data: [] }（system user 不属于 user）
 *     —— 必须走 /debug_token 看 granular_scopes[business_management].target_ids
 *
 * 返回 { bm: { id, name } | null, attempts: [{ source, ok, msg, data? }] }
 * attempts 给 caller 记日志披露。
 */

const META_API_VERSION = 'v21.0';

async function graphGet(path, token, params = {}) {
  const qs = new URLSearchParams({ access_token: token, ...params });
  const res = await fetch(`https://graph.facebook.com/${META_API_VERSION}${path}?${qs}`);
  const data = await res.json();
  if (!res.ok || data?.error) {
    throw new Error(data?.error?.message || `Meta API ${path} failed (${res.status})`);
  }
  return data;
}

/**
 * @param {string} token
 * @param {Object} [opts]
 * @param {string} [opts.hintBmId]  用户在前端手动粘的 BM ID，有就直接用，跳过所有探测
 */
export async function resolveBusinessManager(token, { hintBmId = null } = {}) {
  const attempts = [];

  // 0. 用户手动粘了 BM ID → 直接用，跳过所有自动探测路径
  if (hintBmId) {
    try {
      const info = await graphGet(`/${hintBmId}`, token, { fields: 'id,name' });
      attempts.push({
        source: `/${hintBmId} (用户提供)`,
        ok: true,
        msg: `BM 验证通过：${info.name || '-'}`,
        data: info,
      });
      return { bm: { id: info.id, name: info.name || null }, attempts };
    } catch (err) {
      attempts.push({
        source: `/${hintBmId} (用户提供)`,
        ok: false,
        msg: `用户提供的 BM ID 验证失败：${err.message}`,
      });
      return { bm: null, attempts };
    }
  }

  // 1. /me/businesses（user token 路径）
  try {
    const businesses = await graphGet('/me/businesses', token, { fields: 'id,name' });
    const list = businesses.data || [];
    attempts.push({
      source: '/me/businesses',
      ok: true,
      msg: `返回 ${list.length} 个 BM`,
      data: list.map(b => ({ id: b.id, name: b.name || null })),
    });
    if (list.length > 0) {
      // 多个 BM 时取第 0 个 —— Phase 4 多 BM 支持时让用户选
      return { bm: { id: list[0].id, name: list[0].name || null }, attempts };
    }
  } catch (err) {
    attempts.push({ source: '/me/businesses', ok: false, msg: err.message });
  }

  // 2. /debug_token granular_scopes[business_management].target_ids
  let bizIds = [];
  let tokenAppId = null;
  try {
    const dbg = await graphGet('/debug_token', token, { input_token: token });
    const data = dbg?.data || {};
    const granular = Array.isArray(data.granular_scopes) ? data.granular_scopes : [];
    const bm = granular.find(s => s.scope === 'business_management');
    bizIds = (bm?.target_ids || []).filter(Boolean);
    tokenAppId = data.app_id || null;
    attempts.push({
      source: '/debug_token',
      ok: true,
      msg: `type=${data.type || '-'}, app_id=${tokenAppId || '-'}, scopes=${(data.scopes || []).length}, granular=${granular.length}, business_management.target_ids=${bizIds.length}`,
      data: {
        type: data.type,
        app_id: tokenAppId,
        scopes: data.scopes,
        granular_scopes: granular,
      },
    });
  } catch (err) {
    attempts.push({ source: '/debug_token', ok: false, msg: err.message });
  }

  // 3. 拿 target_ids[0] 调 /{bm_id} 取 name
  if (bizIds.length > 0) {
    const bizId = bizIds[0];
    try {
      const info = await graphGet(`/${bizId}`, token, { fields: 'id,name' });
      attempts.push({ source: `/${bizId}`, ok: true, msg: `BM 名称解析：${info.name || '-'}`, data: info });
      return { bm: { id: info.id, name: info.name || null }, attempts };
    } catch (err) {
      attempts.push({ source: `/${bizId}`, ok: false, msg: `BM 名称解析失败：${err.message}（仍按 id 继续）` });
      return { bm: { id: bizId, name: null }, attempts };
    }
  }

  // 全失败 —— 让 caller 提示用户手动粘 BM ID
  return { bm: null, attempts };
}

/**
 * 单独导出：从 /debug_token 拿 token 所属的 App ID。
 * 校验"租户给的 token 是不是在我们 LeadEngine App 下生成的"用。
 */
export async function getTokenAppId(token) {
  try {
    const dbg = await graphGet('/debug_token', token, { input_token: token });
    return dbg?.data?.app_id || null;
  } catch {
    return null;
  }
}
