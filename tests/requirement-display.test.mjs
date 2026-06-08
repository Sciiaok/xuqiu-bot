import assert from 'node:assert/strict';
import test from 'node:test';

test('Feishu requirement cards display status in Chinese', async () => {
  const { buildRequirementDraftCard } = await import('../src/requirement-card.service.js');

  const card = buildRequirementDraftCard({
    id: 'req_1',
    req_no: 'REQ-20260608-001',
    title: '登录页异常',
    status: 'needs_pm',
    priority: 'P1',
    current_owner_name: '张三',
    raw_description: '登录页打不开',
    prd: { solution: '修复登录页超时' },
  });

  assert.match(card.elements[0].text.content, /需要产品确认/);
  assert.doesNotMatch(card.elements[0].text.content, /needs_pm/);
  assert.match(JSON.stringify(card), /当前负责人/);
  assert.match(JSON.stringify(card), /张三/);
  assert.doesNotMatch(JSON.stringify(card), /打回补充/);
  assert.doesNotMatch(JSON.stringify(card), /先不处理/);
});

test('Bitable requirement sync writes status in Chinese', async () => {
  const {
    pickExistingBitableFields,
    requirementToBitableFields,
  } = await import('../src/requirement-bitable.service.js');

  const fields = requirementToBitableFields({
    id: 'req_1',
    req_no: 'REQ-20260608-001',
    title: '登录页异常',
    status: 'ready_for_dev',
    priority: 'P1',
    raw_description: '登录页打不开',
    submitter_feishu_user_id: 'ou_submitter',
    submitter_feishu_name: '张三',
    pm_owner_name: '李四',
    developer_name: '王五',
    tester_name: '赵六',
    acceptor_name: '钱七',
    current_owner_name: '李四',
    prd: {
      solution: '登录页超时后展示重试按钮',
      acceptance_criteria: ['超时后出现重试按钮', '点击重试能重新请求'],
    },
  });

  assert.equal(fields['状态'], '需要开发');
  assert.equal(fields['原始描述'], '登录页打不开');
  assert.equal(fields['提出人'], '张三');
  assert.equal(fields['具体方案'], '登录页超时后展示重试按钮');
  assert.equal(fields['验收标准'], '1. 超时后出现重试按钮\n2. 点击重试能重新请求');
  assert.equal(fields['PM'], '李四');
  assert.equal(fields['开发'], '王五');
  assert.equal(fields['测试'], '赵六');
  assert.equal(fields['验收人'], '钱七');
  assert.equal(fields['当前负责人'], '李四');

  assert.deepEqual(
    pickExistingBitableFields(fields, new Set(['需求编号', '标题', '状态', '具体方案'])),
    {
      '需求编号': 'REQ-20260608-001',
      '标题': '登录页异常',
      '状态': '需要开发',
      '具体方案': '登录页超时后展示重试按钮',
    },
  );
});
