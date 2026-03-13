import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'lib/session.js')).href;
const contactRepositoryModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/contact.repository.js')).href;
const conversationRepositoryModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/conversation.repository.js')).href;
const messageRepositoryModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/message.repository.js')).href;
const leadRepositoryModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/lead.repository.js')).href;
const referralContextModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/referral-context.js')).href;

test.afterEach(() => {
  mock.restoreAll();
  mock.reset();
});

test('processMessageForConversation persists meta ad attribution to conversation and leads', async () => {
  const calls = {
    updateConversationAttribution: [],
    replaceConversationLeads: [],
  };

  mock.module(contactRepositoryModuleUrl, {
    namedExports: {
      findOrCreateContact: async () => {
        throw new Error('not expected');
      },
      findContactById: async () => ({
        id: 'contact-1',
        wa_id: '8613800000001',
      }),
      updateContact: async () => {},
    },
  });

  mock.module(conversationRepositoryModuleUrl, {
    namedExports: {
      getOrCreateConversation: async () => {
        throw new Error('not expected');
      },
      findConversationById: async () => ({
        id: 'conv-1',
        contact_id: 'contact-1',
        agent_id: 'agent-1',
        started_at: '2026-03-12T00:00:00.000Z',
        last_message_at: '2026-03-12T00:00:00.000Z',
        meta_ad_id: null,
      }),
      findLatestActiveConversation: async () => null,
      markConversationIdle: async () => {},
      updateConversationAttribution: async (conversationId, payload) => {
        calls.updateConversationAttribution.push({ conversationId, payload });
        return {
          id: conversationId,
          meta_ad_id: payload.metaAdId,
        };
      },
      updateConversationOnMessage: async () => {},
    },
  });

  mock.module(messageRepositoryModuleUrl, {
    namedExports: {
      createMessage: async () => {},
      getMessagesForClaude: async () => [],
      getTotalScore: async () => 0,
      getAllRiskFlags: async () => [],
    },
  });

  mock.module(leadRepositoryModuleUrl, {
    namedExports: {
      findLeadByConversation: async () => null,
      formatLeadDataForUI: () => ({}),
      replaceConversationLeads: async (...args) => {
        calls.replaceConversationLeads.push(args);
        return [];
      },
    },
  });

  mock.module(referralContextModuleUrl, {
    namedExports: {
      extractMetaAdIdFromMessageMetadata: (metadata) => metadata?.meta_ad_id || metadata?.referral?.ad_id || null,
    },
  });

  const { processMessageForConversation } = await import(`${moduleUrl}?test=${Date.now()}-${Math.random()}`);

  await processMessageForConversation(
    'conv-1',
    {
      content: 'Need price for BYD Song Plus',
      metadata: {
        meta_ad_id: 'meta-ad-99',
      },
    },
    {
      conversation_intent: ['business_inquiry'],
      conversation_intent_summary: 'Business buyer asking for quote',
      inquiry_quality: 'QUALIFY',
      business_value: 'AVERAGE',
      route: 'CONTINUE',
      next_message: 'Please share quantity and destination port.',
      handoff_summary: '',
      leads: [
        {
          car_model: 'BYD Song Plus',
          destination_country: 'Mexico',
        },
      ],
    }
  );

  assert.deepEqual(calls.updateConversationAttribution, [
    {
      conversationId: 'conv-1',
      payload: { metaAdId: 'meta-ad-99' },
    },
  ]);
  assert.equal(calls.replaceConversationLeads.length, 1);
  assert.equal(calls.replaceConversationLeads[0][0], 'conv-1');
  assert.equal(calls.replaceConversationLeads[0][1], 'contact-1');
  assert.equal(calls.replaceConversationLeads[0][2][0].meta_ad_id, 'meta-ad-99');
});
