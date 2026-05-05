/**
 * WhatsApp Accounts Service — lists Click-to-WhatsApp-eligible phone numbers
 * for the current tenant.
 *
 * 数据源：meta_phone_numbers 表（connect 时同步好的，已按 isPhoneUsable 过滤过）。
 * 不再每次去 Meta Graph API 重拉 —— 那条老路径依赖全局 env (META_SYSTEM_TOKEN/
 * META_AD_ACCOUNT_ID/META_PAGE_ID)，多租户改造后已经废弃。
 *
 * 单一路径：租户必须先通过 /settings/meta-connection 接入 Meta，否则返
 * not_configured；没号码返 no_phone。
 */
import supabase from '../../../lib/supabase.js';
import {
  listAdAccountsByTenant,
  listPhonesByTenant,
  findActiveConnectionByTenant,
} from '../../../lib/repositories/meta-connection.repository.js';
import { decryptToken } from '../../../lib/meta-token-crypto.js';

async function tenantIdForUser(userId) {
  if (!userId) return null;
  const { data } = await supabase
    .from('users')
    .select('tenant_id')
    .eq('id', userId)
    .maybeSingle();
  return data?.tenant_id || null;
}

export async function getMetaAccountForUser(userId) {
  const tenantId = await tenantIdForUser(userId);
  if (!tenantId) return null;

  const [conn, ads] = await Promise.all([
    findActiveConnectionByTenant(tenantId),
    listAdAccountsByTenant(tenantId),
  ]);
  if (!conn || ads.length === 0) return null;

  return {
    access_token: decryptToken(conn.system_user_token_encrypted),
    ad_account_id: ads[0].ad_account_id,
    page_id: conn.metadata?.page_id || null,
  };
}

/**
 * E.164 normalization: strip "+" and whitespace/dashes. Meta's
 * promoted_object.whatsapp_phone_number wants digits only.
 *   "+86 185 8855 7892" → "8618588557892"
 */
export function normalizePhoneNumber(display) {
  if (!display) return null;
  return String(display).replace(/[^\d]/g, '') || null;
}

/**
 * A number is usable for Click-to-WhatsApp ads when it has a real verified
 * business name (i.e. not Meta's "Test Number" placeholder) and its quality
 * rating isn't RED (Meta blocks CTWA on red-rated numbers).
 */
function isUsable(phone) {
  if (!phone.verified_name) return false;
  if (phone.verified_name === 'Test Number') return false;
  if (phone.quality_rating === 'RED') return false;
  return true;
}

function normalize(phone) {
  // 兼容两种来源：meta_phone_numbers 行（display_number 列名）
  // 和 Graph API 返回（display_phone_number 字段）。
  const display = phone.display_number || phone.display_phone_number;
  return {
    phone_number_id: phone.phone_number_id,
    phone_normalized: normalizePhoneNumber(display),
    display_number: display,
    verified_name: phone.verified_name || null,
    quality_rating: phone.quality_rating || 'UNKNOWN',
    waba_id: phone.waba_id,
    waba_name: phone.waba_name || null,
  };
}

/**
 * Gate status：
 *   ok                      ：至少一个可用号
 *   only_test_or_unverified ：有号但都是测试号 / RED / 未认证
 *   no_phone                ：已绑 Meta，但当前 BM 下没号
 *   not_configured          ：还没绑 Meta
 */

// ── Process-local cache ─────────────────────────────────────────────────
// 改成查 DB 后单次查询 ~10ms，理论上 cache 也可以删。先留着压低 autopilot
// 高频调用 DB 的次数（每次 Agent 工具调用都会进来一次）。
const CACHE_TTL_MS = 60_000;        // 60s for OK results
const NEGATIVE_TTL_MS = 10_000;     // 10s for errors (so recovery is quick)
const cache = new Map();            // userId-or-'anon' → { expiresAt, value }

function cacheKey(userId) { return userId || 'anon'; }

function getCached(userId) {
  const entry = cache.get(cacheKey(userId));
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(cacheKey(userId));
    return null;
  }
  return entry.value;
}

function setCached(userId, value) {
  const ttl = value.status === 'ok' ? CACHE_TTL_MS : NEGATIVE_TTL_MS;
  cache.set(cacheKey(userId), { expiresAt: Date.now() + ttl, value });
}

/**
 * Main entry：列当前租户已绑定的 WhatsApp 号码。
 * 直接读 meta_phone_numbers 表 —— connect / refresh 时已经把可用号码同步进来了。
 *
 * Options:
 *   - force: 跳过 cache（UI "我已完成绑定，重新检查" 按钮用）
 */
export async function listWhatsAppAccountsForUser(userId, { force = false } = {}) {
  if (!force) {
    const cached = getCached(userId);
    if (cached) return cached;
  }

  const tenantId = await tenantIdForUser(userId);
  if (!tenantId) {
    const v = { status: 'not_configured', numbers: [], all_numbers: [],
                error: '当前账号尚未关联租户' };
    setCached(userId, v);
    return v;
  }

  const phones = await listPhonesByTenant(tenantId);

  if (phones.length === 0) {
    const conn = await findActiveConnectionByTenant(tenantId);
    const v = conn
      ? { status: 'no_phone', numbers: [], all_numbers: [],
          error: '已绑定 Meta，但当前 BM 下没有可用 WhatsApp 号码' }
      : { status: 'not_configured', numbers: [], all_numbers: [],
          error: '当前账号尚未连接 Meta Business —— 进入「设置 / Meta 连接」完成接入' };
    setCached(userId, v);
    return v;
  }

  const allNormalized = phones.map(normalize);
  // connect 时已经按 isPhoneUsable 过滤过，DB 里基本都是可用的；
  // 这里再跑一遍兜底（quality_rating 等字段可能事后被 cron 刷成 RED）
  const usableNormalized = phones.filter(isUsable).map(normalize);

  const v = {
    status: usableNormalized.length > 0 ? 'ok' : 'only_test_or_unverified',
    numbers: usableNormalized,
    all_numbers: allNormalized,
  };
  setCached(userId, v);
  return v;
}

/**
 * Fire-and-forget prewarm. Called when a user creates a new conversation so
 * the first message doesn't wait 4-6s on Graph API. Safe to call repeatedly;
 * if the cache is warm this is a no-op.
 */
export function prewarmWhatsAppAccountsForUser(userId) {
  if (getCached(userId)) return;
  listWhatsAppAccountsForUser(userId).catch(err => {
    console.warn('[autopilot/whatsapp-accounts] prewarm failed:', err.message);
  });
}

/**
 * Lookup a specific number within the usable list — used by stage_campaigns
 * to validate the Agent-selected phone_number_id is real before calling Meta.
 */
export async function getWhatsAppNumberById(userId, phoneNumberId) {
  const { numbers } = await listWhatsAppAccountsForUser(userId);
  return numbers.find(n => n.phone_number_id === phoneNumberId) || null;
}
