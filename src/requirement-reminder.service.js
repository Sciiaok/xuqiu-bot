import { buildSimpleNoticeCard } from './requirement-card.service.js';
import { sendFeishuCard } from './feishu-app.service.js';
import {
  getRequirementBotSettings,
  listRequirementsForReminder,
  recordRequirementReminder,
  updateRequirement,
} from '../lib/repositories/requirement.repository.js';

function activeDueAt(requirement) {
  if (requirement.status === 'needs_pm' || requirement.status === 'needs_info') return requirement.pm_due_at;
  if (requirement.status === 'ready_for_dev' || requirement.status === 'in_dev') return requirement.dev_due_at;
  if (requirement.status === 'ready_for_test' || requirement.status === 'in_test') return requirement.test_due_at;
  if (requirement.status === 'ready_for_acceptance') return requirement.acceptance_due_at;
  return null;
}

function hoursUntil(iso, now) {
  if (!iso) return null;
  return (new Date(iso).getTime() - now.getTime()) / 36e5;
}

function hoursSince(iso, now) {
  if (!iso) return 0;
  return (now.getTime() - new Date(iso).getTime()) / 36e5;
}

export function classifyRequirementReminder(requirement, now = new Date()) {
  if (['closed', 'rejected'].includes(requirement.status)) return null;

  const due = activeDueAt(requirement);
  const dueHours = hoursUntil(due, now);
  if (dueHours != null && dueHours < 0) return 'overdue';
  if (dueHours != null && dueHours <= 24) return 'due_soon';

  const staleHours = hoursSince(requirement.last_status_changed_at || requirement.updated_at, now);
  if (staleHours >= 72) return 'stale';

  const remindedHours = requirement.last_reminded_at
    ? hoursSince(requirement.last_reminded_at, now)
    : Infinity;
  if (requirement.priority === 'P0' && remindedHours >= 2) return 'p0_followup';
  if (requirement.priority === 'P1' && remindedHours >= 24) return 'p1_followup';

  return null;
}

function reminderLines(requirement, reminderType) {
  return [
    `**标题**：${requirement.title}`,
    `**状态**：${requirement.status}`,
    `**优先级**：${requirement.priority}`,
    `**负责人**：${requirement.current_owner_feishu_user_id ? `<at id="${requirement.current_owner_feishu_user_id}"></at>` : '-'}`,
    `**提醒类型**：${reminderType}`,
  ];
}

export async function runRequirementReminders({ tenantId }) {
  const settings = await getRequirementBotSettings(tenantId);
  if (!settings?.enabled || !settings.default_chat_id) {
    return { skipped: true, reason: 'not_configured' };
  }

  const now = new Date();
  const requirements = await listRequirementsForReminder({ tenantId });
  const selected = requirements
    .map(requirement => ({ requirement, reminderType: classifyRequirementReminder(requirement, now) }))
    .filter(item => item.reminderType);

  for (const { requirement, reminderType } of selected) {
    const card = buildSimpleNoticeCard({
      title: `需求提醒：${requirement.req_no}`,
      lines: reminderLines(requirement, reminderType),
      template: reminderType === 'overdue' ? 'red' : 'orange',
    });
    await sendFeishuCard({
      tenantId,
      receiveId: requirement.feishu_chat_id || settings.default_chat_id,
      card,
    });
    await recordRequirementReminder({
      tenant_id: tenantId,
      requirement_id: requirement.id,
      reminder_type: reminderType,
      target_feishu_user_id: requirement.current_owner_feishu_user_id,
      details: {},
    });
    await updateRequirement({
      tenantId,
      id: requirement.id,
      patch: { last_reminded_at: now.toISOString() },
    });
  }

  return { ok: true, sent: selected.length };
}
