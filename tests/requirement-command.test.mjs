import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

test('parses requirement edit commands from Feishu text', async () => {
  const { parseRequirementEditCommand } = await import('../src/requirement-command.service.js');

  assert.deepEqual(
    parseRequirementEditCommand('修改 REQ-20260608-001 优先级为高'),
    {
      handled: true,
      reqNo: 'REQ-20260608-001',
      field: 'priority',
      value: 'P1',
      rawField: '优先级',
      rawValue: '高',
    },
  );

  assert.deepEqual(
    parseRequirementEditCommand('更新 REQ-20260608-001 开发截止为2026-06-09 18:00'),
    {
      handled: true,
      reqNo: 'REQ-20260608-001',
      field: 'dev_due_at',
      value: '2026-06-09T10:00:00.000Z',
      rawField: '开发截止',
      rawValue: '2026-06-09 18:00',
    },
  );

  assert.deepEqual(parseRequirementEditCommand('登录页打不开'), { handled: false });
});

test('applies requirement edit commands and records an event', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'requirement-command-'));
  process.env.REQUIREMENT_BOT_STORE_PATH = path.join(dir, 'store.json');
  process.env.FEISHU_REQUIREMENT_BOT_ENABLED = 'true';

  const repo = await import('../lib/repositories/requirement.repository.js');
  const { handleRequirementEditCommand } = await import('../src/requirement-command.service.js');

  try {
    const requirement = await repo.createRequirement({
      tenant_id: 'local',
      req_no: 'REQ-20260608-001',
      title: '旧标题',
      status: 'needs_pm',
      priority: 'P2',
      submitter_feishu_user_id: 'ou_submitter',
      pm_owner_feishu_user_id: 'ou_pm',
      current_owner_feishu_user_id: 'ou_pm',
    });

    const result = await handleRequirementEditCommand({
      tenantId: 'local',
      text: '修改 REQ-20260608-001 优先级为P0',
      actorFeishuUserId: 'ou_pm',
    });

    assert.equal(result.handled, true);
    assert.equal(result.ok, true);
    assert.equal(result.requirement.id, requirement.id);
    assert.equal(result.requirement.priority, 'P0');
    assert.equal(result.message, '已修改 REQ-20260608-001：优先级 = P0');

    const events = await repo.listRequirementEvents({
      tenantId: 'local',
      requirementId: requirement.id,
    });
    assert.equal(events[0].action, 'update_priority');
    assert.deepEqual(events[0].details, {
      field: 'priority',
      from: 'P2',
      to: 'P0',
      raw_field: '优先级',
      raw_value: 'P0',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('applies product plan edits inside the requirement PRD', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'requirement-command-'));
  process.env.REQUIREMENT_BOT_STORE_PATH = path.join(dir, 'store.json');
  process.env.FEISHU_REQUIREMENT_BOT_ENABLED = 'true';

  const repo = await import('../lib/repositories/requirement.repository.js');
  const { handleRequirementEditCommand } = await import('../src/requirement-command.service.js');

  try {
    const requirement = await repo.createRequirement({
      tenant_id: 'local',
      req_no: 'REQ-20260608-002',
      title: '登录页异常',
      status: 'needs_pm',
      priority: 'P1',
      prd: {
        solution: '旧方案',
        acceptance_criteria: ['旧验收标准'],
      },
    });

    const result = await handleRequirementEditCommand({
      tenantId: 'local',
      text: '修改 REQ-20260608-002 具体方案为登录页接口超时后展示重试按钮，并记录错误日志',
      actorFeishuUserId: 'ou_pm',
    });

    assert.equal(result.handled, true);
    assert.equal(result.ok, true);
    assert.equal(
      result.requirement.prd.solution,
      '登录页接口超时后展示重试按钮，并记录错误日志',
    );
    assert.equal(result.requirement.prd.acceptance_criteria[0], '旧验收标准');
    assert.equal(result.message, '已修改 REQ-20260608-002：具体方案 = 登录页接口超时后展示重试按钮，并记录错误日志');

    const criteriaResult = await handleRequirementEditCommand({
      tenantId: 'local',
      text: '修改 REQ-20260608-002 验收标准为1. 超时后出现重试按钮；2. 点击重试能重新请求；3. 日志里有错误码',
      actorFeishuUserId: 'ou_pm',
    });

    assert.deepEqual(criteriaResult.requirement.prd.acceptance_criteria, [
      '超时后出现重试按钮',
      '点击重试能重新请求',
      '日志里有错误码',
    ]);

    const events = await repo.listRequirementEvents({
      tenantId: 'local',
      requirementId: requirement.id,
    });
    assert.equal(events[0].action, 'update_plan');
    assert.equal(events[1].action, 'update_plan');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('requires a requirement id for follow-up text', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'requirement-command-'));
  process.env.REQUIREMENT_BOT_STORE_PATH = path.join(dir, 'store.json');
  process.env.FEISHU_REQUIREMENT_BOT_ENABLED = 'true';

  const repo = await import('../lib/repositories/requirement.repository.js');
  const { handleRequirementFollowUp } = await import('../src/requirement-command.service.js');
  const tenantId = `follow-${Date.now()}`;
  const chatId = `oc_chat_${Date.now()}`;

  try {
    const requirement = await repo.createRequirement({
      tenant_id: tenantId,
      req_no: 'REQ-20260608-003',
      title: '登录页异常',
      status: 'needs_pm',
      priority: 'P1',
      raw_description: '登录页打不开',
      feishu_chat_id: chatId,
      prd: { solution: '旧方案' },
    });

    const result = await handleRequirementFollowUp({
      tenantId,
      chatId,
      text: '补充一下：只在移动端微信内打开会失败',
      actorFeishuUserId: 'ou_submitter',
    });

    assert.equal(result.handled, true);
    assert.equal(result.ok, false);
    assert.match(result.error, /请带上需求编号/);

    const rows = await repo.listRequirements({ tenantId, limit: 10 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, requirement.id);
    assert.equal(rows[0].raw_description, '登录页打不开');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('updates follow-up text only when it mentions a requirement id', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'requirement-command-'));
  process.env.REQUIREMENT_BOT_STORE_PATH = path.join(dir, 'store.json');
  process.env.FEISHU_REQUIREMENT_BOT_ENABLED = 'true';

  const repo = await import('../lib/repositories/requirement.repository.js');
  const { handleRequirementFollowUp } = await import('../src/requirement-command.service.js');
  const tenantId = `follow-id-${Date.now()}`;
  const chatId = `oc_chat_${Date.now()}`;

  try {
    const requirement = await repo.createRequirement({
      tenant_id: tenantId,
      req_no: 'REQ-20260608-004',
      title: '登录页异常',
      status: 'needs_pm',
      priority: 'P1',
      raw_description: '登录页打不开',
      feishu_chat_id: chatId,
    });

    const result = await handleRequirementFollowUp({
      tenantId,
      chatId,
      text: 'REQ-20260608-004 补充一下：只在移动端微信内打开会失败',
      actorFeishuUserId: 'ou_submitter',
    });

    assert.equal(result.handled, true);
    assert.equal(result.ok, true);
    assert.equal(result.requirement.id, requirement.id);
    assert.match(result.requirement.raw_description, /登录页打不开/);
    assert.match(result.requirement.raw_description, /只在移动端微信内打开会失败/);
    assert.equal(result.message, '已补充到 REQ-20260608-004，不会新建需求。');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('allows only bracketed new requirement text to create a requirement', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'requirement-command-'));
  process.env.REQUIREMENT_BOT_STORE_PATH = path.join(dir, 'store.json');
  process.env.FEISHU_REQUIREMENT_BOT_ENABLED = 'true';

  const repo = await import('../lib/repositories/requirement.repository.js');
  const {
    handleRequirementFollowUp,
    isExplicitNewRequirement,
    stripNewRequirementMarker,
  } = await import('../src/requirement-command.service.js');
  const tenantId = `explicit-${Date.now()}`;
  const chatId = `oc_chat_${Date.now()}`;

  try {
    await repo.createRequirement({
      tenant_id: tenantId,
      req_no: 'REQ-20260608-004',
      title: '登录页异常',
      status: 'needs_pm',
      priority: 'P1',
      feishu_chat_id: chatId,
    });

    assert.equal(isExplicitNewRequirement('新需求：导出报表增加金额字段'), false);
    assert.equal(isExplicitNewRequirement('【新需求】导出报表增加金额字段'), true);
    assert.equal(stripNewRequirementMarker('【新需求】导出报表增加金额字段'), '导出报表增加金额字段');

    const result = await handleRequirementFollowUp({
      tenantId,
      chatId,
      text: '【新需求】导出报表增加金额字段',
      actorFeishuUserId: 'ou_submitter',
    });

    assert.deepEqual(result, { handled: false, reason: 'explicit_new_requirement' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('extracts sender display name from Feishu event payloads', async () => {
  const { extractSenderName } = await import('../src/feishu-app.service.js');

  assert.equal(extractSenderName({ name: '张三' }), '张三');
  assert.equal(extractSenderName({ sender_name: '李四' }), '李四');
  assert.equal(extractSenderName({ sender_id: { name: '王五' } }), '王五');
  assert.equal(extractSenderName({ sender_id: { open_id: 'ou_xxx' } }), '');
});

test('parses manual bitable sync commands', async () => {
  const { parseRequirementSyncCommand } = await import('../src/requirement-command.service.js');

  assert.deepEqual(
    parseRequirementSyncCommand('同步 REQ-20260608-001'),
    { handled: true, reqNo: 'REQ-20260608-001' },
  );
  assert.deepEqual(
    parseRequirementSyncCommand('同步多维表格 req-20260608-001'),
    { handled: true, reqNo: 'REQ-20260608-001' },
  );
  assert.deepEqual(parseRequirementSyncCommand('REQ-20260608-001 补充一下'), { handled: false });
});
