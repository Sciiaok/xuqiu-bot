import assert from 'node:assert/strict';
import test from 'node:test';

test('card callback response can return a toast and replacement card', async () => {
  const { cardCallbackResponseBody } = await import('../src/requirement-card-callback.service.js');

  const card = {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'ok' } }],
  };

  assert.deepEqual(cardCallbackResponseBody('success', '已更新', card), {
    toast: { type: 'success', content: '已更新' },
    card,
  });
});

test('card callback toast includes Bitable sync result', async () => {
  const { requirementActionToastMessage } = await import('../src/requirement-card-callback.service.js');

  assert.equal(
    requirementActionToastMessage({ action: 'confirm_plan', syncResult: { ok: true, recordId: 'rec_1' } }),
    '已更新，已同步多维表格',
  );
  assert.equal(
    requirementActionToastMessage({ action: 'confirm_plan', syncResult: { ok: false, error: '没有权限' } }),
    '已更新，但同步多维表格失败：没有权限',
  );
  assert.equal(
    requirementActionToastMessage({ action: 'confirm_plan', syncResult: { skipped: true, reason: 'bitable_not_configured' } }),
    '已更新，但没有同步多维表格：bitable_not_configured',
  );
});
