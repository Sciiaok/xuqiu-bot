import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const claudeModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/claude.service.js')).href;
const configModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/config.js')).href;
const mediaServiceModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/whatsapp-media.service.js')).href;

test.afterEach(() => {
  mock.restoreAll();
  mock.reset();
});

test('getResponse sends inbound WhatsApp images to Claude as image blocks', async () => {
  let createPayload = null;
  const fakeImageBytes = Buffer.from('fake-image-bytes');

  class FakeAnthropic {
    constructor() {
      this.messages = {
        create: async (payload) => {
          createPayload = payload;
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  conversation_intent: ['business_inquiry'],
                  conversation_intent_summary: 'Customer sent an image inquiry',
                  inquiry_quality: 'GOOD',
                  business_value: 'LOW',
                  leads: [],
                  route: 'CONTINUE',
                  next_message: 'Friend, please share the model and destination.',
                  handoff_summary: '',
                }),
              },
            ],
          };
        },
      };
    }
  }

  mock.module('@anthropic-ai/sdk', {
    defaultExport: FakeAnthropic,
  });

  mock.module(configModuleUrl, {
    namedExports: {
      config: {
        anthropic: {
          directApiKey: 'anthropic-test-key',
          apiKey: 'anthropic-test-key',
          model: 'claude-test-model',
        },
        supabase: {
          url: 'http://test.local',
          publishableKey: 'test',
        },
      },
    },
  });

  mock.module(mediaServiceModuleUrl, {
    namedExports: {
      downloadWhatsAppMediaBuffer: async () => ({
        buffer: fakeImageBytes,
        mimeType: 'image/png',
      }),
      isClaudeSupportedImageMimeType: (mimeType) => mimeType === 'image/png',
    },
  });

  const { getResponse } = await import(`${claudeModuleUrl}?test=${Date.now()}-${Math.random()}`);

  const response = await getResponse(
    [],
    {
      content: '[image: whatsapp-image-123.png] please quote this one',
      metadata: {
        media_type: 'image',
        wa_media_id: 'media-123',
      },
    },
    {}
  );

  assert.equal(response.next_message, 'Friend, please share the model and destination.');
  assert.ok(createPayload, 'expected Anthropic messages.create to be called');
  assert.equal(createPayload.model, 'claude-test-model');
  assert.equal(createPayload.messages.length, 1);
  assert.equal(createPayload.messages[0].role, 'user');
  assert.ok(Array.isArray(createPayload.messages[0].content));
  assert.equal(createPayload.messages[0].content[0].type, 'text');
  assert.equal(createPayload.messages[0].content[1].type, 'image');
  assert.equal(createPayload.messages[0].content[1].source.type, 'base64');
  assert.equal(createPayload.messages[0].content[1].source.media_type, 'image/png');
  assert.equal(
    createPayload.messages[0].content[1].source.data,
    fakeImageBytes.toString('base64')
  );
});

test('getResponse traces contextInfo in claude.request.started log', async () => {
  const originalConsoleLog = console.log;
  const logLines = [];

  class FakeAnthropic {
    constructor() {
      this.messages = {
        create: async () => ({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                conversation_intent: ['business_inquiry'],
                conversation_intent_summary: 'Need more company details',
                inquiry_quality: 'GOOD',
                business_value: 'LOW',
                leads: [],
                route: 'CONTINUE',
                next_message: 'Please share your company name.',
                handoff_summary: '',
              }),
            },
          ],
        }),
      };
    }
  }

  mock.module('@anthropic-ai/sdk', {
    defaultExport: FakeAnthropic,
  });

  mock.module(configModuleUrl, {
    namedExports: {
      config: {
        anthropic: {
          directApiKey: 'anthropic-test-key',
          apiKey: 'anthropic-test-key',
          model: 'claude-test-model',
        },
        supabase: {
          url: 'http://test.local',
          publishableKey: 'test',
        },
      },
    },
  });

  mock.module(mediaServiceModuleUrl, {
    namedExports: {
      downloadWhatsAppMediaBuffer: async () => {
        throw new Error('media download should not be called');
      },
      isClaudeSupportedImageMimeType: () => false,
    },
  });

  console.log = (line) => {
    logLines.push(line);
  };

  try {
    const { getResponse } = await import(`${claudeModuleUrl}?test=${Date.now()}-${Math.random()}`);

    await getResponse(
      [],
      'Need quote',
      {
        missing_fields: ['company_name', 'destination_country'],
        companyName: 'ACME Trading',
      },
      null,
      { traceId: 'trace-123', conversationId: 'conv-123', waId: 'wa-123' }
    );
  } finally {
    console.log = originalConsoleLog;
  }

  const startedLog = logLines
    .map((line) => JSON.parse(line))
    .find((entry) => entry.event === 'claude.request.started');

  assert.ok(startedLog, 'expected claude.request.started log');
  assert.deepEqual(startedLog.context_info, {
    missing_fields: ['company_name', 'destination_country'],
    companyName: 'ACME Trading',
  });
  assert.equal(startedLog.trace_id, 'trace-123');
  assert.equal(startedLog.conversation_id, 'conv-123');
  assert.equal(startedLog.wa_id, 'wa-123');
});
