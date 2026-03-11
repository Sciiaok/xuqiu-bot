import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(resolve(process.cwd(), 'src/agent-router.service.js')).href;
const configModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/config.js')).href;
const runtimeModuleUrl = pathToFileURL(resolve(process.cwd(), 'src/agent-runtime.service.js')).href;
const referralModuleUrl = pathToFileURL(resolve(process.cwd(), 'lib/referral-context.js')).href;

test.afterEach(() => {
  mock.restoreAll();
  mock.reset();
});

test('router accepts clarification tool calls without a candidate agent_id', async () => {
  class FakeAnthropic {
    constructor() {
      this.messages = {
        create: async () => ({
          id: 'msg-router-1',
          content: [
            {
              type: 'tool_use',
              name: 'select_agent',
              input: {
                agent_id: '',
                confidence: 'low',
                reason: 'Message is ambiguous between candidates.',
                needs_clarification: true,
                clarification_message: 'Friend, are you asking about cars or auto parts?',
              },
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
          apiKey: 'anthropic-test-key',
          model: 'claude-test-model',
        },
      },
    },
  });

  mock.module(runtimeModuleUrl, {
    namedExports: {
      buildRoutingCandidate: (agent) => ({
        id: agent.id,
        name: agent.name,
        product_line: agent.product_line,
        summary: 'summary',
        routing_hints: 'hints',
      }),
    },
  });

  mock.module(referralModuleUrl, {
    namedExports: {
      formatReferralContextForPrompt: () => 'No inbound referral context.',
      resolveAgentAdContext: () => '',
    },
  });

  const { routeConversationWithClaudeToolUse } = await import(`${moduleUrl}?test=${Date.now()}-${Math.random()}`);
  const result = await routeConversationWithClaudeToolUse({
    conversationHistory: [],
    userMessage: 'I need something for my vehicle',
    candidateAgents: [
      { id: 'agent-auto', name: 'Vehicles', product_line: 'auto' },
      { id: 'agent-parts', name: 'Auto Parts', product_line: 'parts' },
    ],
  });

  assert.equal(result.needsClarification, true);
  assert.equal(result.agentId, '');
  assert.equal(result.clarificationMessage, 'Friend, are you asking about cars or auto parts?');
});
