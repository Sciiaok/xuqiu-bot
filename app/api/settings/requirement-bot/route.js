import { getTenantContext } from '@/lib/tenant-context';
import {
  getRequirementBotSettings,
  saveRequirementBotSettings,
} from '@/lib/repositories/requirement.repository';
import { recordAudit } from '@/lib/repositories/audit-log.repository';

function presentSettings(row) {
  if (!row) return null;
  return {
    enabled: Boolean(row.enabled),
    feishu_app_id: row.feishu_app_id || '',
    default_chat_id: row.default_chat_id || '',
    default_pm_feishu_user_id: row.default_pm_feishu_user_id || '',
    default_developer_feishu_user_id: row.default_developer_feishu_user_id || '',
    default_tester_feishu_user_id: row.default_tester_feishu_user_id || '',
    default_acceptor_feishu_user_id: row.default_acceptor_feishu_user_id || '',
    bitable_app_token: row.bitable_app_token || '',
    bitable_table_id: row.bitable_table_id || '',
    reminder_hour: row.reminder_hour ?? 10,
    has_secret: Boolean(row.feishu_app_secret_encrypted),
    has_encrypt_key: Boolean(row.feishu_encrypt_key_encrypted),
    has_verification_token: Boolean(row.feishu_verification_token_encrypted),
  };
}

export async function GET() {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const row = await getRequirementBotSettings(ctx.tenantId, { includeSecrets: true });
  return Response.json({ data: presentSettings(row) });
}

export async function POST(request) {
  const ctx = await getTenantContext();
  if (!ctx) return Response.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const reminderHour = Number(body.reminder_hour ?? 10);
  if (!Number.isInteger(reminderHour) || reminderHour < 0 || reminderHour > 23) {
    return Response.json({ error: 'reminder_hour must be an integer from 0 to 23' }, { status: 400 });
  }

  const saved = await saveRequirementBotSettings(ctx.tenantId, {
    feishu_app_id: String(body.feishu_app_id || '').trim(),
    feishu_app_secret: String(body.feishu_app_secret || '').trim(),
    feishu_encrypt_key: String(body.feishu_encrypt_key || '').trim(),
    feishu_verification_token: String(body.feishu_verification_token || '').trim(),
    default_chat_id: String(body.default_chat_id || '').trim(),
    default_pm_feishu_user_id: String(body.default_pm_feishu_user_id || '').trim(),
    default_developer_feishu_user_id: String(body.default_developer_feishu_user_id || '').trim(),
    default_tester_feishu_user_id: String(body.default_tester_feishu_user_id || '').trim(),
    default_acceptor_feishu_user_id: String(body.default_acceptor_feishu_user_id || '').trim(),
    bitable_app_token: String(body.bitable_app_token || '').trim(),
    bitable_table_id: String(body.bitable_table_id || '').trim(),
    reminder_hour: reminderHour,
    enabled: Boolean(body.enabled),
  });

  await recordAudit({
    tenantId: ctx.tenantId,
    actorUserId: ctx.user.id,
    actorEmail: ctx.user.email,
    action: 'requirement_bot.settings.saved',
    details: { enabled: Boolean(saved.enabled) },
  });

  const visible = await getRequirementBotSettings(ctx.tenantId, { includeSecrets: true });
  return Response.json({ success: true, data: presentSettings(visible || saved) });
}
