import { config } from '@/src/config';
import { runRequirementReminders } from '@/src/requirement-reminder.service';

export async function GET(request) {
  const auth = request.headers.get('authorization') || '';
  if (config.secrets.cron && auth !== `Bearer ${config.secrets.cron}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const tenantId = request.nextUrl.searchParams.get('tenant_id') ||
    config.feishu.requirementBotCallbackTenantId;
  if (!tenantId) return Response.json({ error: 'tenant_id required' }, { status: 400 });

  const result = await runRequirementReminders({ tenantId });
  return Response.json(result);
}
