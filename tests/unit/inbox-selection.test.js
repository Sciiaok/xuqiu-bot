import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildInboxPathWithoutJumpParams,
  buildConversationSelection,
  buildJumpSelectionOptions,
  replaceInboxPathWithoutJumpParams,
  shouldApplyJumpSelection,
} from '../../app/dashboard/inbox/selection.js';

test('buildConversationSelection focuses the requested conversation for deep links', () => {
  const result = buildConversationSelection(
    ['conv-newest', 'conv-requested', 'conv-other'],
    {
      targetConversationId: 'conv-requested',
      focusConversation: true,
    }
  );

  assert.deepEqual(result.orderedConversationIds, [
    'conv-requested',
    'conv-newest',
    'conv-other',
  ]);
  assert.deepEqual(result.panelConversationIds, ['conv-requested']);
});

test('buildConversationSelection preserves the merged inbox view for normal contact selection', () => {
  const result = buildConversationSelection(
    ['conv-newest', 'conv-requested', 'conv-other'],
    {
      targetConversationId: 'conv-requested',
      focusConversation: false,
    }
  );

  assert.deepEqual(result.orderedConversationIds, [
    'conv-requested',
    'conv-newest',
    'conv-other',
  ]);
  assert.deepEqual(result.panelConversationIds, [
    'conv-requested',
    'conv-newest',
    'conv-other',
  ]);
});

test('buildJumpSelectionOptions keeps explicit conversation deep links pinned', () => {
  const result = buildJumpSelectionOptions({
    initialConversationId: 'conv-explicit',
    contact: {
      latestConversationId: 'conv-latest',
    },
  });

  assert.deepEqual(result, {
    conversationId: 'conv-explicit',
    focusConversation: true,
  });
});

test('buildJumpSelectionOptions carries the resolved conversation for wa_id-only jumps', () => {
  const result = buildJumpSelectionOptions({
    initialWaId: '8613800000001',
    resolvedFromParams: true,
    contact: {
      latestConversationId: 'conv-older-latest',
    },
  });

  assert.deepEqual(result, {
    conversationId: 'conv-older-latest',
    focusConversation: true,
  });
});

test('buildJumpSelectionOptions leaves list-selected wa_id contacts in merged mode', () => {
  const result = buildJumpSelectionOptions({
    initialWaId: '8613800000001',
    resolvedFromParams: false,
    contact: {
      latestConversationId: 'conv-recent',
    },
  });

  assert.deepEqual(result, {
    conversationId: null,
    focusConversation: false,
  });
});

test('shouldApplyJumpSelection blocks repeated handling for applied jumps', () => {
  assert.equal(shouldApplyJumpSelection({
    jumpSignature: '8613800000001:conv-001',
    appliedJumpSignature: '8613800000001:conv-001',
  }), false);
});

test('shouldApplyJumpSelection blocks repeated handling while a jump is already in flight', () => {
  assert.equal(shouldApplyJumpSelection({
    jumpSignature: '8613800000001:conv-001',
    pendingJumpSignature: '8613800000001:conv-001',
  }), false);
});

test('shouldApplyJumpSelection allows a fresh jump signature', () => {
  assert.equal(shouldApplyJumpSelection({
    jumpSignature: '8613800000001:conv-001',
    appliedJumpSignature: '8613800000001:conv-002',
    pendingJumpSignature: null,
  }), true);
});

test('buildInboxPathWithoutJumpParams removes deep-link params and preserves other filters', () => {
  assert.equal(
    buildInboxPathWithoutJumpParams('conversation_id=conv-001&agent=agent-2&wa_id=8613800000001'),
    '/dashboard/inbox?agent=agent-2'
  );
});

test('buildInboxPathWithoutJumpParams returns the base inbox path when no params remain', () => {
  assert.equal(
    buildInboxPathWithoutJumpParams('conversation_id=conv-001'),
    '/dashboard/inbox'
  );
});

test('replaceInboxPathWithoutJumpParams updates browser history in place', () => {
  const calls = [];
  const historyLike = {
    state: { as: '/dashboard/inbox?conversation_id=conv-001' },
    replaceState: (...args) => calls.push(args),
  };

  const nextPath = replaceInboxPathWithoutJumpParams(
    historyLike,
    '?conversation_id=conv-001&agent=agent-2&wa_id=8613800000001'
  );

  assert.equal(nextPath, '/dashboard/inbox?agent=agent-2');
  assert.deepEqual(calls, [[
    { as: '/dashboard/inbox?conversation_id=conv-001' },
    '',
    '/dashboard/inbox?agent=agent-2',
  ]]);
});
