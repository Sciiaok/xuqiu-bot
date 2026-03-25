import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/campaign-intake.service.js')).href;
const configModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/config.js')).href;
const supabaseModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/supabase.js')).href;
const briefRepoUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/campaign-brief.repository.js')).href;
const orchRepoUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/orchestrator.repository.js')).href;

// ── Mock state holders ──────────────────────────────────────────────────
const mockRepo = {
  // brief repo
  getBrief: mock.fn(async () => null),
  updateBriefFields: mock.fn(async () => ({ brief: {} })),
  updateCompletion: mock.fn(async () => ({})),
  updateBrief: mock.fn(async () => ({})),
  // orchestrator repo
  createSession: mock.fn(async () => ({ id: 'session-1' })),
  getLatestSession: mock.fn(async () => ({ id: 'session-1' })),
  getMessagesForClaude: mock.fn(async () => []),
  getNextMessageIndex: mock.fn(async () => 0),
  addMessage: mock.fn(async () => ({})),
  addMessages: mock.fn(async () => []),
};

// ── Mock config ─────────────────────────────────────────────────────────
mock.module(configModuleUrl, {
  namedExports: {
    config: {
      anthropic: { apiKey: 'test-key', model: 'claude-sonnet-4-6' },
    },
  },
});

// ── Mock supabase ───────────────────────────────────────────────────────
mock.module(supabaseModuleUrl, {
  defaultExport: {
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: { id: 'test-uuid' }, error: null }) }) }),
      select: () => ({ eq: () => ({ order: () => ({ data: [], error: null }) }) }),
    }),
  },
});

// ── Mock repositories ───────────────────────────────────────────────────
mock.module(briefRepoUrl, {
  namedExports: {
    getBrief: mockRepo.getBrief,
    updateBriefFields: mockRepo.updateBriefFields,
    updateCompletion: mockRepo.updateCompletion,
    updateBrief: mockRepo.updateBrief,
  },
});
mock.module(orchRepoUrl, {
  namedExports: {
    createSession: mockRepo.createSession,
    getLatestSession: mockRepo.getLatestSession,
    getMessagesForClaude: mockRepo.getMessagesForClaude,
    getNextMessageIndex: mockRepo.getNextMessageIndex,
    addMessage: mockRepo.addMessage,
    addMessages: mockRepo.addMessages,
  },
});

// ── Mock Anthropic SDK ──────────────────────────────────────────────────
// Helper to create an async iterable from an array of events
function createMockStream(events, finalMsg) {
  const iterable = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++], done: false };
          return { done: true };
        },
      };
    },
    async finalMessage() {
      return finalMsg || { stop_reason: 'end_turn', content: [] };
    },
  };
  return iterable;
}

let mockStreamEvents = [];
let mockFinalMessage = { stop_reason: 'end_turn', content: [] };

mock.module('@anthropic-ai/sdk', {
  defaultExport: class MockAnthropic {
    constructor() {
      this.messages = {
        stream: () => createMockStream(mockStreamEvents, mockFinalMessage),
      };
    }
  },
});

// ── Import module under test (after all mocks) ─────────────────────────
const { getIntakeTools, buildIntakeSystemPrompt, processIntakeMessage } =
  await import(`${moduleUrl}?test=${Date.now()}`);

// ── Helper to collect all events from async generator ───────────────────
async function collectEvents(gen) {
  const events = [];
  for await (const e of gen) {
    events.push(e);
  }
  return events;
}

// ════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════

describe('getIntakeTools', () => {
  it('returns 3 tool definitions', () => {
    const tools = getIntakeTools();
    assert.equal(tools.length, 3);
    assert.ok(tools.find(t => t.name === 'update_brief'));
    assert.ok(tools.find(t => t.name === 'save_brief'));
    assert.ok(tools.find(t => t.name === 'parse_attachment'));
  });

  it('each tool has name, description, and input_schema', () => {
    for (const tool of getIntakeTools()) {
      assert.ok(tool.name);
      assert.ok(tool.description);
      assert.ok(tool.input_schema);
      assert.equal(tool.input_schema.type, 'object');
    }
  });
});

describe('buildIntakeSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildIntakeSystemPrompt();
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.length > 100);
  });

  it('mentions CampaignBrief fields', () => {
    const prompt = buildIntakeSystemPrompt();
    assert.ok(prompt.includes('company_name') || prompt.includes('公司'));
    assert.ok(prompt.includes('budget') || prompt.includes('预算'));
  });
});

describe('processIntakeMessage', () => {
  it('yields error when brief not found', async () => {
    mockRepo.getBrief.mock.resetCalls();
    mockRepo.getBrief.mock.mockImplementation(async () => null);

    const events = await collectEvents(
      processIntakeMessage('nonexistent-id', 'hello'),
    );

    assert.ok(events.length >= 1);
    const errorEvent = events.find(e => e.event === 'error');
    assert.ok(errorEvent, 'expected an error event');
    assert.ok(errorEvent.data.message.includes('not found'));
  });

  it('yields delta and done events on successful text response', async () => {
    // Setup mocks for a successful flow
    mockRepo.getBrief.mock.mockImplementation(async () => ({
      id: 'brief-1',
      brief: { company_name: 'TestCo' },
      completion: {},
    }));
    mockRepo.getMessagesForClaude.mock.mockImplementation(async () => []);
    mockRepo.getNextMessageIndex.mock.mockImplementation(async () => 0);
    mockRepo.addMessage.mock.mockImplementation(async () => ({}));
    mockRepo.addMessages.mock.mockImplementation(async () => []);

    // Mock stream: content_block_start(text) -> delta(text) -> content_block_stop
    mockStreamEvents = [
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: '！' } },
      { type: 'content_block_stop' },
    ];
    mockFinalMessage = { stop_reason: 'end_turn', content: [] };

    const events = await collectEvents(
      processIntakeMessage('brief-1', '你好'),
    );

    const deltas = events.filter(e => e.event === 'delta');
    assert.ok(deltas.length >= 1, 'expected at least one delta event');
    assert.equal(deltas[0].data.text, '你好');

    const doneEvent = events.find(e => e.event === 'done');
    assert.ok(doneEvent, 'expected a done event');
    assert.equal(doneEvent.data.brief_id, 'brief-1');
  });

  it('yields brief_update event with default text streamLevel', async () => {
    mockRepo.getBrief.mock.mockImplementation(async () => ({
      id: 'brief-1',
      brief: { company_name: 'TestCo' },
      completion: {},
    }));
    mockRepo.getMessagesForClaude.mock.mockImplementation(async () => []);
    mockRepo.getNextMessageIndex.mock.mockImplementation(async () => 0);
    mockRepo.addMessage.mock.mockImplementation(async () => ({}));
    mockRepo.addMessages.mock.mockImplementation(async () => []);

    mockStreamEvents = [
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop' },
    ];
    mockFinalMessage = { stop_reason: 'end_turn', content: [] };

    const events = await collectEvents(
      processIntakeMessage('brief-1', 'hi'),
    );

    const briefUpdate = events.find(e => e.event === 'brief_update');
    assert.ok(briefUpdate, 'expected a brief_update event');
  });

  it('filters thinking events when streamLevel is text', async () => {
    mockRepo.getBrief.mock.mockImplementation(async () => ({
      id: 'brief-1',
      brief: {},
      completion: {},
    }));
    mockRepo.getMessagesForClaude.mock.mockImplementation(async () => []);
    mockRepo.getNextMessageIndex.mock.mockImplementation(async () => 0);
    mockRepo.addMessage.mock.mockImplementation(async () => ({}));
    mockRepo.addMessages.mock.mockImplementation(async () => []);

    mockStreamEvents = [
      { type: 'content_block_start', content_block: { type: 'thinking' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me think...' } },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Response' } },
      { type: 'content_block_stop' },
    ];
    mockFinalMessage = { stop_reason: 'end_turn', content: [] };

    // streamLevel='text' should NOT yield thinking
    const textEvents = await collectEvents(
      processIntakeMessage('brief-1', 'hi', { streamLevel: 'text' }),
    );
    const thinkingEvents = textEvents.filter(e => e.event === 'thinking');
    assert.equal(thinkingEvents.length, 0, 'text streamLevel should not emit thinking');

    // streamLevel='full' SHOULD yield thinking
    const fullEvents = await collectEvents(
      processIntakeMessage('brief-1', 'hi', { streamLevel: 'full' }),
    );
    const fullThinking = fullEvents.filter(e => e.event === 'thinking');
    assert.ok(fullThinking.length > 0, 'full streamLevel should emit thinking');
  });

  it('does not emit tool_call or tool_result at text streamLevel', async () => {
    mockRepo.getBrief.mock.mockImplementation(async () => ({
      id: 'brief-1',
      brief: {},
      completion: {},
    }));
    mockRepo.getMessagesForClaude.mock.mockImplementation(async () => []);
    mockRepo.getNextMessageIndex.mock.mockImplementation(async () => 0);
    mockRepo.addMessage.mock.mockImplementation(async () => ({}));
    mockRepo.addMessages.mock.mockImplementation(async () => []);
    mockRepo.updateBriefFields.mock.mockImplementation(async () => ({
      brief: { company_name: 'TestCo' },
    }));
    mockRepo.updateCompletion.mock.mockImplementation(async () => ({}));

    // First stream iteration: tool_use, stops with tool_use
    const toolStream = [
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'update_brief', id: 'tu_1' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"fields":{"company_name":"TestCo"}}' } },
      { type: 'content_block_stop' },
    ];

    // Second stream iteration: text response after tool result
    const textStream = [
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Got it' } },
      { type: 'content_block_stop' },
    ];

    let callCount = 0;
    // We need to override the stream mock to return different streams per call
    // Since mock.module is already set, we work with the global mockStreamEvents/mockFinalMessage
    // For a two-iteration loop, we switch events between calls

    // Use a simpler approach: single stream with just text (tool tests via full level)
    mockStreamEvents = toolStream;
    mockFinalMessage = { stop_reason: 'end_turn', content: [] };

    const events = await collectEvents(
      processIntakeMessage('brief-1', 'company is TestCo', { streamLevel: 'text' }),
    );

    const toolCallEvents = events.filter(e => e.event === 'tool_call');
    const toolResultEvents = events.filter(e => e.event === 'tool_result');
    assert.equal(toolCallEvents.length, 0, 'text streamLevel should not emit tool_call');
    assert.equal(toolResultEvents.length, 0, 'text streamLevel should not emit tool_result');
  });
});

describe('shouldEmit (via processIntakeMessage streamLevel)', () => {
  // shouldEmit is not exported, so we test it indirectly

  it('full level emits tool_call, tool_result, and thinking', async () => {
    mockRepo.getBrief.mock.mockImplementation(async () => ({
      id: 'brief-1',
      brief: {},
      completion: {},
    }));
    mockRepo.getMessagesForClaude.mock.mockImplementation(async () => []);
    mockRepo.getNextMessageIndex.mock.mockImplementation(async () => 0);
    mockRepo.addMessage.mock.mockImplementation(async () => ({}));
    mockRepo.addMessages.mock.mockImplementation(async () => []);
    mockRepo.updateBriefFields.mock.mockImplementation(async () => ({
      brief: { company_name: 'Acme' },
    }));
    mockRepo.updateCompletion.mock.mockImplementation(async () => ({}));

    mockStreamEvents = [
      { type: 'content_block_start', content_block: { type: 'thinking' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'update_brief', id: 'tu_2' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"fields":{"company_name":"Acme"}}' } },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done' } },
      { type: 'content_block_stop' },
    ];
    mockFinalMessage = { stop_reason: 'end_turn', content: [] };

    const events = await collectEvents(
      processIntakeMessage('brief-1', 'company is Acme', { streamLevel: 'full' }),
    );

    const eventTypes = events.map(e => e.event);
    assert.ok(eventTypes.includes('thinking'), 'full level should emit thinking');
    assert.ok(eventTypes.includes('tool_call'), 'full level should emit tool_call');
    assert.ok(eventTypes.includes('tool_result'), 'full level should emit tool_result');
    assert.ok(eventTypes.includes('delta'), 'full level should emit delta');
    assert.ok(eventTypes.includes('done'), 'full level should emit done');
  });

  it('events level excludes thinking but includes tool events', async () => {
    mockRepo.getBrief.mock.mockImplementation(async () => ({
      id: 'brief-1',
      brief: {},
      completion: {},
    }));
    mockRepo.getMessagesForClaude.mock.mockImplementation(async () => []);
    mockRepo.getNextMessageIndex.mock.mockImplementation(async () => 0);
    mockRepo.addMessage.mock.mockImplementation(async () => ({}));
    mockRepo.addMessages.mock.mockImplementation(async () => []);
    mockRepo.updateBriefFields.mock.mockImplementation(async () => ({
      brief: { company_name: 'Acme' },
    }));
    mockRepo.updateCompletion.mock.mockImplementation(async () => ({}));

    mockStreamEvents = [
      { type: 'content_block_start', content_block: { type: 'thinking' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'update_brief', id: 'tu_3' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"fields":{"company_name":"Acme"}}' } },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } },
      { type: 'content_block_stop' },
    ];
    mockFinalMessage = { stop_reason: 'end_turn', content: [] };

    const events = await collectEvents(
      processIntakeMessage('brief-1', 'test', { streamLevel: 'events' }),
    );

    const eventTypes = events.map(e => e.event);
    assert.ok(!eventTypes.includes('thinking'), 'events level should NOT emit thinking');
    assert.ok(eventTypes.includes('tool_call'), 'events level should emit tool_call');
    assert.ok(eventTypes.includes('tool_result'), 'events level should emit tool_result');
    assert.ok(eventTypes.includes('delta'), 'events level should emit delta');
    assert.ok(eventTypes.includes('done'), 'events level should emit done');
  });

  it('text level only emits delta, done, error, brief_update', async () => {
    mockRepo.getBrief.mock.mockImplementation(async () => ({
      id: 'brief-1',
      brief: {},
      completion: {},
    }));
    mockRepo.getMessagesForClaude.mock.mockImplementation(async () => []);
    mockRepo.getNextMessageIndex.mock.mockImplementation(async () => 0);
    mockRepo.addMessage.mock.mockImplementation(async () => ({}));
    mockRepo.addMessages.mock.mockImplementation(async () => []);
    mockRepo.updateBriefFields.mock.mockImplementation(async () => ({
      brief: { company_name: 'Acme' },
    }));
    mockRepo.updateCompletion.mock.mockImplementation(async () => ({}));

    mockStreamEvents = [
      { type: 'content_block_start', content_block: { type: 'thinking' } },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'update_brief', id: 'tu_4' } },
      { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"fields":{"company_name":"Acme"}}' } },
      { type: 'content_block_stop' },
      { type: 'content_block_start', content_block: { type: 'text' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_stop' },
    ];
    mockFinalMessage = { stop_reason: 'end_turn', content: [] };

    const events = await collectEvents(
      processIntakeMessage('brief-1', 'test', { streamLevel: 'text' }),
    );

    const eventTypes = events.map(e => e.event);
    const allowedTypes = new Set(['delta', 'done', 'error', 'brief_update']);
    for (const t of eventTypes) {
      assert.ok(allowedTypes.has(t), `text level emitted unexpected event type: ${t}`);
    }
    assert.ok(eventTypes.includes('delta'), 'text level should emit delta');
    assert.ok(eventTypes.includes('done'), 'text level should emit done');
    assert.ok(eventTypes.includes('brief_update'), 'text level should emit brief_update');
  });
});
