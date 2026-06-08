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
    raw_description: '登录页打不开',
    prd: { solution: '修复登录页超时' },
  });

  assert.match(card.elements[0].text.content, /需要产品确认/);
  assert.doesNotMatch(card.elements[0].text.content, /needs_pm/);
});

test('Bitable requirement sync writes status in Chinese', async () => {
  const { requirementToBitableFields } = await import('../src/requirement-bitable.service.js');

  const fields = requirementToBitableFields({
    id: 'req_1',
    req_no: 'REQ-20260608-001',
    title: '登录页异常',
    status: 'ready_for_dev',
    priority: 'P1',
  });

  assert.equal(fields['状态'], '需要开发');
});
