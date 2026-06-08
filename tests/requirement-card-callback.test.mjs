import assert from 'node:assert/strict';
import test from 'node:test';

test('card callback response returns only a toast', async () => {
  const { cardCallbackResponseBody } = await import('../src/requirement-card-callback.service.js');

  const card = {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'ok' } }],
  };

  assert.deepEqual(cardCallbackResponseBody('success', '已更新', card), {
    toast: { type: 'success', content: '已更新' },
  });
});

test('card callback toast says Bitable sync is queued', async () => {
  const { requirementActionToastMessage } = await import('../src/requirement-card-callback.service.js');

  assert.equal(
    requirementActionToastMessage({ action: 'confirm_plan' }),
    '已更新，多维表格后台同步中',
  );
});
