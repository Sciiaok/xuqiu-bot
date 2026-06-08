import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('confirm plan is idempotent after the requirement has already moved forward', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'requirement-state-'));
  process.env.REQUIREMENT_BOT_STORE_PATH = path.join(dir, 'store.json');

  const repo = await import('../lib/repositories/requirement.repository.js');
  const { applyRequirementAction } = await import('../src/requirement-state.service.js');

  try {
    const requirement = await repo.createRequirement({
      tenant_id: 'local',
      req_no: 'REQ-20260608-009',
      title: '登录页异常',
      status: 'ready_for_dev',
      priority: 'P1',
      pm_owner_feishu_user_id: 'ou_pm',
      developer_feishu_user_id: 'ou_dev',
      current_owner_feishu_user_id: 'ou_dev',
    });

    const result = await applyRequirementAction({
      tenantId: 'local',
      requirement,
      actorFeishuUserId: 'ou_pm',
      action: 'confirm_plan',
    });

    assert.equal(result.id, requirement.id);
    assert.equal(result.status, 'ready_for_dev');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
