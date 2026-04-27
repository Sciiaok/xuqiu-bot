import { createClient } from './supabase-server.js';
import supabase from './supabase.js';

// 常量从 ./founder-id.js re-export —— 这样 client 组件可以直接 import 那个
// 纯常量文件，不会把 supabase-server.js（server-only）拖进客户端 bundle。
export { FOUNDER_TENANT_ID } from './founder-id.js';

/**
 * 解析当前请求的 tenant 上下文。
 *
 * 返回 { user, tenantId } 或 null。null 的情况：
 *   - 未登录
 *   - public.users 没该 user 行（系统的合法入口只有 invitation signup）
 *   - 该 user 所属 tenant 被 superadmin 暂停
 *
 * 单一路径，无自愈 fallback。
 */
export async function getTenantContext() {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) return null;

  const { data: profile, error } = await client
    .from('users')
    .select('tenant_id, tenants(status)')
    .eq('id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (!profile) return null;

  if (profile.tenants?.status === 'suspended') {
    console.warn('[tenant-context] tenant suspended', {
      user_id: user.id,
      tenant_id: profile.tenant_id,
    });
    return null;
  }
  return { user, tenantId: profile.tenant_id };
}

/**
 * 验 agent 是否属于当前 tenant。返回 agent 行（含 tenant_id）或 null。
 *
 * KB 数据全部按 agent_id 主键，没有显式 tenant_id 列；多租户隔离的方式是
 * 在路由层先验"这个 agent 是不是你的"，过了再放行 kb_* 操作。
 */
export async function findAgentInTenant({ tenantId, agentId }) {
  if (!tenantId || !agentId) return null;
  const { data, error } = await supabase
    .from('agents')
    .select('id, tenant_id, product_line')
    .eq('id', agentId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Webhook 用：根据 phoneNumberId 反查 tenant。
 *
 * 唯一路径：meta_phone_numbers。找不到返 null —— webhook 调用方应该 log 并
 * 返 200（Meta 不重投），让对方先在 /settings/meta-connection 完成接入。
 */
export async function resolveTenantByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  const { data, error } = await supabase
    .from('meta_phone_numbers')
    .select('tenant_id')
    .eq('phone_number_id', phoneNumberId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  return data?.tenant_id || null;
}
