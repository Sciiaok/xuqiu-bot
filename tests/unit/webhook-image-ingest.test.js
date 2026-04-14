import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const routeModuleUrl = pathToFileURL(resolve(process.cwd(), 'app/api/webhook/route.js')).href;
const nextServerModuleUrl = pathToFileURL(resolve(process.cwd(), 'node_modules/next/server.js')).href;
const configModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/config.js')).href;
const whatsappModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/whatsapp.service.js')).href;
const whisperModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/whisper.service.js')).href;
const whatsappMediaModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/whatsapp-media.service.js')).href;
const conversationContextModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/conversation-context.service.js')).href;
const queueRepositoryModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/queue.repository.js')).href;
const conversationRepositoryModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/conversation.repository.js')).href;
const contactRepositoryModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/contact.repository.js')).href;

function buildWebhookBody(messages) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages,
              contacts: [{ profile: { name: 'Alice' } }],
              metadata: { phone_number_id: 'pnid-1' },
            },
          },
        ],
      },
    ],
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await new Promise((resolveFlush) => setImmediate(resolveFlush));
  await Promise.resolve();
}

async function loadWebhookRoute() {
  const calls = {
    context: [],
    enqueue: [],
    markAsRead: [],
    sendMessage: [],
    timers: [],
    takeover: [],
    transcribe: [],
    contactMetadata: [],
  };

  mock.restoreAll();
  mock.reset();

  mock.module(nextServerModuleUrl, {
    namedExports: {
      NextResponse: {
        json(body, init = {}) {
          return new Response(JSON.stringify(body), {
            status: init.status || 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
    },
  });

  mock.module(configModuleUrl, {
    namedExports: {
      config: {
        whatsapp: {
          verifyToken: 'verify-token',
          apiVersion: 'v22.0',
          phoneNumberId: 'default-pnid',
          token: 'wa-token',
        },
        queue: {
          aggregationWindowMs: 2000,
        },
        server: {
          port: 3002,
        },
        app: {
          baseUrl: undefined,
        },
      },
    },
  });

  mock.module(whatsappModuleUrl, {
    namedExports: {
      markAsRead: async (...args) => {
        calls.markAsRead.push(args);
      },
      sendMessage: async (...args) => {
        calls.sendMessage.push(args);
        return { messages: [{ id: 'wamid.outbound' }] };
      },
    },
  });

  mock.module(whisperModuleUrl, {
    namedExports: {
      transcribeWhatsAppAudio: async (...args) => {
        calls.transcribe.push(args);
        return 'transcribed audio';
      },
    },
  });

  mock.module(whatsappMediaModuleUrl, {
    namedExports: {
      buildInboundMediaPlaceholder: ({ type, filename, caption }) =>
        caption ? `[${type}: ${filename}] ${caption}` : `[${type}: ${filename}]`,
      buildMediaFilename: (_type, _mimeType, mediaId) => `${mediaId}.jpg`,
      buildWhatsAppMediaProxyUrl: (mediaId) => `/api/media/${mediaId}`,
    },
  });

  mock.module(conversationContextModuleUrl, {
    namedExports: {
      getOrCreateRoutedConversationContext: async (...args) => {
        calls.context.push(args);
        return {
          conversation_id: 'conv-1',
          contact_id: 'contact-1',
        };
      },
    },
  });

  mock.module(queueRepositoryModuleUrl, {
    namedExports: {
      enqueueMessage: async (payload) => {
        calls.enqueue.push(payload);
        return {
          id: `queue-${calls.enqueue.length}`,
          process_after: '2026-03-11T00:00:00.000Z',
        };
      },
    },
  });

  mock.module(conversationRepositoryModuleUrl, {
    namedExports: {
      isHumanTakeover: async (...args) => {
        calls.takeover.push(args);
        return false;
      },
    },
  });

  mock.module(contactRepositoryModuleUrl, {
    namedExports: {
      updateContactMetadata: async (...args) => {
        calls.contactMetadata.push(args);
        return { id: 'contact-1', metadata: args[1] };
      },
    },
  });

  mock.method(globalThis, 'setTimeout', (_fn, delay) => {
    calls.timers.push(delay);
    return 1;
  });

  const module = await import(`${routeModuleUrl}?test=${Date.now()}-${Math.random()}`);
  return { module, calls };
}

test.afterEach(() => {
  mock.restoreAll();
  mock.reset();
});

test('webhook enqueues supported text messages', async () => {
  const { module, calls } = await loadWebhookRoute();
  const request = new Request('http://localhost/api/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildWebhookBody([
      {
        from: '8613800000001',
        id: 'wamid.text.1',
        type: 'text',
        text: { body: 'hello from customer' },
      },
    ])),
  });

  const response = await module.POST(request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });

  await flushAsyncWork();

  assert.equal(calls.markAsRead.length, 1);
  assert.equal(calls.enqueue.length, 1);
  assert.equal(calls.enqueue[0].messageType, 'text');
  assert.equal(calls.enqueue[0].content, 'hello from customer');
  assert.equal(calls.sendMessage.length, 0);
});

test('webhook should accept inbound image messages instead of sending unsupported fallback', async () => {
  const { module, calls } = await loadWebhookRoute();
  const request = new Request('http://localhost/api/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildWebhookBody([
      {
        from: '8613800000001',
        id: 'wamid.image.1',
        type: 'image',
        image: {
          id: 'media-1',
          mime_type: 'image/jpeg',
          caption: 'see attachment',
        },
      },
    ])),
  });

  const response = await module.POST(request);
  assert.equal(response.status, 200);

  await flushAsyncWork();

  assert.equal(
    calls.sendMessage.length,
    0,
    'expected image messages to enter the processing pipeline without the unsupported fallback'
  );
  assert.equal(calls.enqueue.length, 1, 'expected inbound image to be queued');
  assert.equal(calls.enqueue[0].messageType, 'image');
  assert.equal(calls.enqueue[0].metadata.media_type, 'image');
  assert.equal(calls.enqueue[0].metadata.wa_media_id, 'media-1');
  assert.equal(calls.enqueue[0].metadata.media_url, '/api/media/media-1');
  assert.equal(typeof calls.enqueue[0].content, 'string');
  assert.notEqual(calls.enqueue[0].content.trim(), '');
});

test('webhook should process every message in a single payload', async () => {
  const { module, calls } = await loadWebhookRoute();
  const request = new Request('http://localhost/api/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildWebhookBody([
      {
        from: '8613800000001',
        id: 'wamid.text.1',
        type: 'text',
        text: { body: 'first message' },
      },
      {
        from: '8613800000001',
        id: 'wamid.text.2',
        type: 'text',
        text: { body: 'second message' },
      },
    ])),
  });

  const response = await module.POST(request);
  assert.equal(response.status, 200);

  await flushAsyncWork();

  assert.equal(calls.markAsRead.length, 2, 'expected all inbound messages to be marked as read');
  assert.equal(calls.enqueue.length, 2, 'expected every inbound message to be queued');
  assert.deepEqual(
    calls.enqueue.map((entry) => entry.content),
    ['first message', 'second message']
  );
});

test('webhook stores last_referral with ad_id on the contact metadata', async () => {
  const { module, calls } = await loadWebhookRoute();
  const request = new Request('http://localhost/api/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildWebhookBody([
      {
        from: '8613800000001',
        id: 'wamid.text.2',
        type: 'text',
        text: { body: 'hello from ad traffic' },
        referral: {
          source_type: 'ad',
          source_id: '1234567890',
          headline: 'BYD spare parts ad',
          body: 'Click to WhatsApp',
          ctwa_clid: 'clid-1',
        },
      },
    ])),
  });

  const response = await module.POST(request);
  assert.equal(response.status, 200);

  await flushAsyncWork();

  assert.equal(calls.contactMetadata.length, 1);
  assert.equal(calls.contactMetadata[0][0], 'contact-1');
  assert.equal(calls.contactMetadata[0][1].last_referral.ad_id, '1234567890');
  assert.equal(calls.contactMetadata[0][1].last_referral.headline, 'BYD spare parts ad');
  assert.equal(calls.contactMetadata[0][1].first_referral.ad_id, '1234567890');
});
