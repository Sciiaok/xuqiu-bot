import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'lib/queue-processor.js')).href;
const queueRepositoryModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/queue.repository.js')).href;
const sessionModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/session.js')).href;
const claudeModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/claude.service.js')).href;
const inquiryModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/inquiry-quality.js')).href;
const routingModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/routing.service.js')).href;
const whatsappModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/whatsapp.service.js')).href;
const messageRepositoryModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/message.repository.js')).href;
const conversationRepositoryModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/conversation.repository.js')).href;
const agentRoutingModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/agent-routing.service.js')).href;

test.afterEach(() => {
  mock.restoreAll();
  mock.reset();
});

test('queue processor preserves per-message metadata in aggregated storage payloads', async () => {
  const calls = {
    storedMessage: null,
    sendMessage: [],
  };

  mock.module(queueRepositoryModuleUrl, {
    namedExports: {
      acquirePendingMessages: async () => ([
        {
          id: 'queue-1',
          wa_id: '8613800000001',
          content: '[image: media-1.jpg] see this part',
          message_type: 'image',
          wa_message_id: 'wamid-1',
          metadata: {
            media_type: 'image',
            wa_media_id: 'media-1',
            media_url: '/api/media/media-1',
          },
        },
        {
          id: 'queue-2',
          wa_id: '8613800000001',
          content: 'Need quote for this one',
          message_type: 'text',
          wa_message_id: 'wamid-2',
          metadata: {},
        },
      ]),
      markAsCompleted: async () => {},
      markAsFailed: async () => {},
    },
  });

  mock.module(sessionModuleUrl, {
    namedExports: {
      getSessionByConversationId: async () => ({
        messages: [],
        lead_data: {},
        _lead: null,
        _conversation: {
          id: 'conv-1',
          wa_phone_number_id: 'conv-pnid-1',
        },
      }),
      processMessageForConversation: async (_conversationId, userMessageContent) => {
        calls.storedMessage = userMessageContent;
        return {
          messages: [],
          conversation_id: 'conv-1',
          _conversation: {
            id: 'conv-1',
            wa_phone_number_id: 'conv-pnid-1',
          },
        };
      },
    },
  });

  mock.module(claudeModuleUrl, {
    namedExports: {
      getResponse: async () => ({
        conversation_intent: ['business_inquiry'],
        conversation_intent_summary: 'Image plus text follow-up',
        inquiry_quality: 'GOOD',
        business_value: 'LOW',
        leads: [],
        route: 'CONTINUE',
        next_message: 'Friend, please share the model number.',
        handoff_summary: '',
      }),
    },
  });

  mock.module(inquiryModuleUrl, {
    namedExports: {
      getMissingFields: () => [],
      hasReachedGlobalMaxTurns: () => false,
      getGlobalMaxTurns: () => 6,
    },
  });

  mock.module(routingModuleUrl, {
    namedExports: {
      executeConversationRouting: async () => ({ success: true }),
    },
  });

  mock.module(whatsappModuleUrl, {
    namedExports: {
      sendMessage: async (...args) => {
        calls.sendMessage.push(args);
        return { messages: [{ id: 'wamid.outbound' }] };
      },
    },
  });

  mock.module(messageRepositoryModuleUrl, {
    namedExports: {
      createMessage: async () => {},
    },
  });

  mock.module(conversationRepositoryModuleUrl, {
    namedExports: {
      checkAndExpireTakeover: async () => false,
      updateConversationOnMessage: async () => {},
      findConversationById: async () => ({
        id: 'conv-1',
        agent_id: null,
        wa_phone_number_id: 'conv-pnid-1',
      }),
    },
  });

  mock.module(agentRoutingModuleUrl, {
    namedExports: {
      buildRoutingClarificationResponse: () => {
        throw new Error('clarification path should not be used');
      },
      resolveAgentForConversation: async () => ({
        agent: {
          id: 'agent-1',
        },
        routingDecision: {
          agentId: 'agent-1',
          needsClarification: false,
        },
        usedRouter: true,
      }),
    },
  });

  const { processConversationQueue } = await import(`${moduleUrl}?test=${Date.now()}-${Math.random()}`);
  const result = await processConversationQueue('conv-1');

  assert.equal(result.processed, true);
  assert.ok(calls.storedMessage, 'expected processMessageForConversation to receive a storage payload');
  assert.equal(
    calls.storedMessage.content,
    '[image: media-1.jpg] see this part\nNeed quote for this one'
  );
  assert.equal(calls.storedMessage.metadata.aggregated_messages.length, 2);
  assert.equal(calls.storedMessage.metadata.aggregated_messages[0].metadata.media_type, 'image');
  assert.equal(calls.storedMessage.metadata.aggregated_messages[0].metadata.media_url, '/api/media/media-1');
  assert.equal(calls.storedMessage.metadata.aggregated_messages[1].message_type, 'text');
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.sendMessage[0][2], 'conv-pnid-1');
});
