import { createClient } from '@supabase/supabase-js';
import { config } from '../src/config.js';

/**
 * 服务端管理 client：用 service-role key，绕过 RLS。
 *
 * 仅 server 端可用 —— 不要在 client component 引入。
 *
 * 用途：
 *   - 创建 auth 用户（admin.createUser）
 *   - 跨 tenant 数据迁移 / 后台维护
 *   - 任何需要绕 RLS 的管理动作
 */
let _adminClient = null;

export function getSupabaseAdmin() {
  if (!config.supabase.serviceRoleKey) {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY is not configured. Set the env var to use admin operations.'
    );
  }
  if (!_adminClient) {
    _adminClient = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });
  }
  return _adminClient;
}
