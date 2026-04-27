import supabase from '../supabase.js';
import { encryptToken, decryptToken } from '../meta-token-crypto.js';

/**
 * Tenant 通知设置 CRUD。V1 仅飞书 webhook。
 *
 * 加密复用 META_TOKEN_ENCRYPTION_KEY —— 同一个 server-side key 加密任意 secret。
 */

export async function getSettings(tenantId) {
  if (!tenantId) return null;
  const { data, error } = await supabase
    .from('notification_settings')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function getFeishuWebhookUrl(tenantId) {
  const row = await getSettings(tenantId);
  if (!row?.feishu_enabled || !row.feishu_webhook_url_encrypted) return null;
  return decryptToken(row.feishu_webhook_url_encrypted);
}

export async function saveFeishuWebhook(tenantId, webhookUrl) {
  if (!tenantId) throw new Error('saveFeishuWebhook: tenantId required');
  const url = String(webhookUrl || '').trim();
  if (!url) {
    // 清空 → 关闭通知
    const { error } = await supabase
      .from('notification_settings')
      .upsert({
        tenant_id: tenantId,
        feishu_webhook_url_encrypted: null,
        feishu_enabled: false,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'tenant_id' });
    if (error) throw error;
    return;
  }
  const encrypted = encryptToken(url);
  const { error } = await supabase
    .from('notification_settings')
    .upsert({
      tenant_id: tenantId,
      feishu_webhook_url_encrypted: encrypted,
      feishu_enabled: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id' });
  if (error) throw error;
}

export async function recordTestResult(tenantId, { ok, error: errMsg }) {
  await supabase
    .from('notification_settings')
    .update({
      feishu_last_test_at: new Date().toISOString(),
      feishu_last_test_ok: ok,
      feishu_last_test_error: ok ? null : (errMsg || null),
    })
    .eq('tenant_id', tenantId);
}
