import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('requirement bot repository works without Supabase', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'requirement-bot-'));
  process.env.REQUIREMENT_BOT_STORE_PATH = path.join(dir, 'store.json');
  process.env.FEISHU_APP_ID = 'cli_xxx';
  process.env.FEISHU_APP_SECRET = 'secret_xxx';
  process.env.FEISHU_REQUIREMENT_BOT_CALLBACK_TENANT_ID = 'local';
  process.env.FEISHU_REQUIREMENT_BOT_ENABLED = 'true';

  const repo = await import('../lib/repositories/requirement.repository.js');

  try {
    const settings = await repo.getRequirementBotSettings('local', { includeSecrets: true });
    assert.equal(settings.enabled, true);
    assert.equal(settings.feishu_app_id, 'cli_xxx');
    assert.equal(settings.feishu_app_secret, 'secret_xxx');

    const reqNo = await repo.nextRequirementNo();
    const created = await repo.createRequirementWithEvent({
      tenantId: 'local',
      requirement: {
        tenant_id: 'local',
        req_no: reqNo,
        title: '修复线上按钮异常',
        status: 'needs_pm',
        priority: 'P1',
        raw_description: '按钮偶发点不动',
      },
      event: {
        actorFeishuUserId: 'ou_user',
        action: 'create_from_feishu',
      },
    });

    const updated = await repo.updateRequirement({
      tenantId: 'local',
      id: created.id,
      patch: {
        status: 'ready_for_dev',
        current_owner_feishu_user_id: 'ou_dev',
      },
    });
    await repo.addRequirementEvent({
      tenantId: 'local',
      requirementId: created.id,
      actorFeishuUserId: 'ou_pm',
      action: 'confirm_plan',
      fromStatus: 'needs_pm',
      toStatus: 'ready_for_dev',
    });

    const rows = await repo.listRequirements({ tenantId: 'local' });
    const events = await repo.listRequirementEvents({ tenantId: 'local', requirementId: created.id });
    const reminders = await repo.listRequirementsForReminder({ tenantId: 'local' });

    assert.equal(updated.status, 'ready_for_dev');
    assert.equal(rows.length, 1);
    assert.equal(events.length, 2);
    assert.equal(reminders.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
