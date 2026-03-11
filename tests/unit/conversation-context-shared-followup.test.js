import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'lib/conversation-context.service.js')).href;
const contactRepositoryModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/contact.repository.js')).href;
const conversationRepositoryModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/conversation.repository.js')).href;

test.afterEach(() => {
  mock.restoreAll();
  mock.reset();
});

test('shared-number follow-up reuses the latest active routed conversation', async () => {
  mock.module(contactRepositoryModuleUrl, {
    namedExports: {
      findOrCreateContact: async () => ({
        id: 'contact-1',
        metadata: {},
      }),
    },
  });

  let getOrCreateCalled = false;
  let markIdleCalled = false;
  mock.module(conversationRepositoryModuleUrl, {
    namedExports: {
      findLatestActiveConversation: async () => ({
        id: 'conv-routed',
        contact_id: 'contact-1',
        agent_id: 'agent-1',
        wa_phone_number_id: 'shared-number',
        last_message_at: new Date().toISOString(),
      }),
      getOrCreateConversation: async () => {
        getOrCreateCalled = true;
        return { id: 'conv-new' };
      },
      linkConversationToAgent: async () => {},
      markConversationIdle: async () => {
        markIdleCalled = true;
      },
    },
  });

  const { getOrCreateRoutedConversationContext } = await import(`${moduleUrl}?test=${Date.now()}-${Math.random()}`);
  const result = await getOrCreateRoutedConversationContext({
    waId: '8613800000001',
    profileName: 'Alice',
    phoneNumberId: 'shared-number',
  });

  assert.equal(result.conversation_id, 'conv-routed');
  assert.equal(result.routing_mode, 'shared');
  assert.equal(getOrCreateCalled, false);
  assert.equal(markIdleCalled, false);
});

test('phone_number_id bindings do not force a direct agent at webhook ingest', async () => {
  mock.module(contactRepositoryModuleUrl, {
    namedExports: {
      findOrCreateContact: async () => ({
        id: 'contact-2',
        metadata: {},
      }),
    },
  });

  let requestedAgentId = 'unset';
  let requestedPhoneNumberId = 'unset';
  mock.module(conversationRepositoryModuleUrl, {
    namedExports: {
      findLatestActiveConversation: async () => null,
      getOrCreateConversation: async (_contactId, agentId, waPhoneNumberId) => {
        requestedAgentId = agentId;
        requestedPhoneNumberId = waPhoneNumberId;
        return {
          id: 'conv-shared-new',
          agent_id: null,
          wa_phone_number_id: waPhoneNumberId,
          last_message_at: new Date().toISOString(),
        };
      },
      linkConversationToAgent: async () => {
        throw new Error('webhook ingest should not link agent directly');
      },
      markConversationIdle: async () => {},
    },
  });

  const { getOrCreateRoutedConversationContext } = await import(`${moduleUrl}?test=${Date.now()}-${Math.random()}`);
  const result = await getOrCreateRoutedConversationContext({
    waId: '8613800000002',
    profileName: 'Bob',
    phoneNumberId: '1007317245789266',
  });

  assert.equal(requestedAgentId, null);
  assert.equal(requestedPhoneNumberId, '1007317245789266');
  assert.equal(result.routing_mode, 'shared');
  assert.equal(result.agent_id, null);
  assert.equal(result.conversation_id, 'conv-shared-new');
});

test('reused active conversations backfill wa_phone_number_id when missing', async () => {
  mock.module(contactRepositoryModuleUrl, {
    namedExports: {
      findOrCreateContact: async () => ({
        id: 'contact-3',
        metadata: {},
      }),
    },
  });

  let requestedArgs = null;
  mock.module(conversationRepositoryModuleUrl, {
    namedExports: {
      findLatestActiveConversation: async () => ({
        id: 'conv-existing',
        contact_id: 'contact-3',
        agent_id: null,
        wa_phone_number_id: null,
        last_message_at: new Date().toISOString(),
      }),
      getOrCreateConversation: async (...args) => {
        requestedArgs = args;
        return {
          id: 'conv-existing',
          agent_id: null,
          wa_phone_number_id: args[2],
          last_message_at: new Date().toISOString(),
        };
      },
      linkConversationToAgent: async () => {},
      markConversationIdle: async () => {},
    },
  });

  const { getOrCreateRoutedConversationContext } = await import(`${moduleUrl}?test=${Date.now()}-${Math.random()}`);
  const result = await getOrCreateRoutedConversationContext({
    waId: '8613800000003',
    profileName: 'Carol',
    phoneNumberId: 'pnid-backfill',
  });

  assert.deepEqual(requestedArgs, ['contact-3', null, 'pnid-backfill']);
  assert.equal(result.conversation_id, 'conv-existing');
});
