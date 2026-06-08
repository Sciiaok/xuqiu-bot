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
