import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Mock setup ─────────────────────────────────────────────────────────

const briefRepoUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/campaign-brief.repository.js')).href;
const orchRepoUrl = pathToFileURL(resolve(process.cwd(), 'lib/repositories/orchestrator.repository.js')).href;
const researchUrl = pathToFileURL(resolve(process.cwd(), 'src/research-agent.service.js')).href;
const strategyUrl = pathToFileURL(resolve(process.cwd(), 'src/strategy-agent.service.js')).href;
const aigcUrl = pathToFileURL(resolve(process.cwd(), 'src/aigc.service.js')).href;
const executionUrl = pathToFileURL(resolve(process.cwd(), 'src/execution-agent.service.js')).href;
const supabaseUrl = pathToFileURL(resolve(process.cwd(), 'lib/supabase.js')).href;
const configUrl = pathToFileURL(resolve(process.cwd(), 'src/config.js')).href;
const anthropicUrl = pathToFileURL(resolve(process.cwd(), 'node_modules/@anthropic-ai/sdk/index.mjs')).href;

// Mock supabase (must be before config since orchestrator imports it)
mock.module(supabaseUrl, {
  defaultExport: {
    storage: {
      from: () => ({
        download: async () => ({
          data: new Blob([Buffer.from('fake-image')]),
          error: null,
        }),
      }),
    },
  },
});

mock.module(configUrl, {
  namedExports: {
    config: {
      anthropic: { apiKey: 'test', baseURL: 'https://openrouter.ai/api', model: 'claude-sonnet-4-6' },
      meta: { accessToken: 'test', adAccountId: '123', apiVersion: 'v21.0' },
      aigc: { apiKey: 'test', baseURL: 'https://openrouter.ai/api', imageModel: 'test', storageBucket: 'test' },
    },
  },
});

// ── DB mocks ───────────────────────────────────────────────────────────

let mockSession = {};
let mockBrief = {};
let persistedMessages = [];
let sessionUpdates = [];

mock.module(briefRepoUrl, {
  namedExports: {
    getBrief: mock.fn(async () => mockBrief),
  },
});

let messageIndex = 0;
mock.module(orchRepoUrl, {
  namedExports: {
    createSession: mock.fn(async (briefId) => {
      mockSession = { id: 'session-1', brief_id: briefId, status: 'draft', phase_results: {}, current_phase: null };
      return mockSession;
    }),
    getSession: mock.fn(async () => mockSession),
    getLatestSession: mock.fn(async () => mockSession),
    updateSession: mock.fn(async (id, updates) => {
      sessionUpdates.push(updates);
      if (updates.status) mockSession.status = updates.status;
      if (updates.phase_results) mockSession.phase_results = updates.phase_results;
      if (updates.current_phase !== undefined) mockSession.current_phase = updates.current_phase;
      return mockSession;
    }),
    addMessages: mock.fn(async (sessionId, msgs) => {
      persistedMessages.push(...msgs);
      return msgs;
    }),
    getMessagesForClaude: mock.fn(async () => []),
    getNextMessageIndex: mock.fn(async () => messageIndex++),
  },
});

// ── Agent mocks ────────────────────────────────────────────────────────

const MOCK_RESEARCH = {
  market_overview: { market_size_estimate: '$5B' },
  competitor_ads: { summary: 'Competitors focus on price' },
  platform_recommendations: [{ platform: 'meta', fit_score: 9 }],
  recommendations: ['Start with Meta'],
};

const MOCK_STRATEGY = {
  summary: 'Meta lead gen campaign',
  total_budget: 5000,
  currency: 'USD',
  duration_days: 30,
  platforms: [{
    platform: 'meta', budget_allocation: 100, budget_amount: 5000, rationale: 'Best fit',
    campaigns: [{
      name: 'Lead Gen', objective: 'lead_gen', daily_budget: 166,
      ad_sets: [{
        name: 'Nigeria 25-55',
        targeting: { countries: ['NG'], age_range: [25, 55] },
        optimization_goal: 'lead_generation',
        ads: [{
          name: 'Ad 1', format: 'image',
          primary_text: 'Power up', headline: 'Battery', description: 'Reliable', cta: 'Learn More',
          media_requirements: { type: 'image', specs: '1080x1080', suggested_content: 'Product showcase' },
        }],
      }],
    }],
  }],
};

const MOCK_EXECUTION = {
  status: 'completed', platform: 'meta',
  campaigns: [{ id: 'c1', name: 'Lead Gen', ad_sets: [] }],
  errors: [],
};

mock.module(researchUrl, {
  namedExports: { conductResearch: mock.fn(async () => MOCK_RESEARCH) },
});

mock.module(strategyUrl, {
  namedExports: { generateMediaPlan: mock.fn(async () => MOCK_STRATEGY) },
});

mock.module(aigcUrl, {
  namedExports: {
    generateFromDocument: mock.fn(async () => ({
      id: 'asset-1', url: 'https://storage.test/img.png', storage_path: 'generated/img.png',
    })),
  },
});

mock.module(executionUrl, {
  namedExports: {
    executeMediaPlan: mock.fn(async () => MOCK_EXECUTION),
    previewExecution: mock.fn(() => ({
      preview: 'Campaign: Lead Gen\n  Budget: $5000',
      entity_counts: { campaigns: 1, ad_sets: 1, ads: 1 },
    })),
    uploadMedia: mock.fn(async () => ({ image_hash: 'hash123' })),
  },
});

// Mock Anthropic for chatWithOrchestrator
mock.module(anthropicUrl, {
  defaultExport: class Anthropic {
    constructor() {
      this.messages = {
        create: mock.fn(async () => ({ content: [{ text: 'test response' }] })),
        stream: mock.fn(() => ({
          [Symbol.asyncIterator]: async function* () {
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: '方案分析如下...' } };
          },
          finalMessage: async () => ({ stop_reason: 'end_turn', content: [] }),
        })),
      };
    }
  },
});

// ── Import orchestrator ────────────────────────────────────────────────

const orchUrl = pathToFileURL(resolve(process.cwd(), 'src/campaign-orchestrator.service.js')).href;
const {
  orchestrate,
  orchestrateAfterApproval,
  chatWithOrchestrator,
  detectStartPhase,
  summarizePhaseResult,
  PHASES,
} = await import(orchUrl);

// ── Helpers ────────────────────────────────────────────────────────────

async function collectEvents(gen) {
  const events = [];
  for await (const e of gen) events.push(e);
  return events;
}

function findEvents(events, name) {
  return events.filter(e => e.event === name);
}

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  sessionUpdates = [];
  persistedMessages = [];
  messageIndex = 0;
  mockSession = {
    id: 'session-1',
    brief_id: 'brief-1',
    status: 'draft',
    phase_results: {},
    current_phase: null,
  };
  mockBrief = {
    id: 'brief-1',
    status: 'completed',
    brief: {
      company_name: 'CF Energy',
      industry: 'energy storage',
      products: [{ model: 'CFE-5' }],
      target_countries: ['Nigeria'],
      budget_total: 5000,
    },
  };
});

describe('Campaign Orchestrator (session-based)', () => {
  describe('orchestrate — full pipeline', () => {
    it('runs research → strategy → creative, pauses at execution for approval', async () => {
      const events = await collectEvents(orchestrate('session-1'));

      const starts = findEvents(events, 'orchestration_start');
      assert.equal(starts.length, 1);
      assert.equal(starts[0].data.session_id, 'session-1');
      assert.equal(starts[0].data.start_phase, 'research');

      const phaseStarts = findEvents(events, 'phase_start');
      assert.equal(phaseStarts.length, 3); // research, strategy, creative
      assert.equal(phaseStarts[0].data.phase, 'research');
      assert.equal(phaseStarts[1].data.phase, 'strategy');
      assert.equal(phaseStarts[2].data.phase, 'creative');

      const approvals = findEvents(events, 'approval_required');
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].data.phase, 'execution');

      assert.equal(findEvents(events, 'done').length, 0);
    });

    it('persists agent traces to orchestrator_messages', async () => {
      await collectEvents(orchestrate('session-1'));

      // Should have trace messages for research, strategy, creative + approval message
      const traceMessages = persistedMessages.filter(m => m.phase !== null);
      assert.ok(traceMessages.length >= 3, `Expected >= 3 trace messages, got ${traceMessages.length}`);

      // Should have approval message (phase=null, user-facing)
      const approvalMsg = persistedMessages.find(m => m.phase === null && m.role === 'assistant');
      assert.ok(approvalMsg, 'Should persist approval preview as user-facing message');
      assert.ok(approvalMsg.content.includes('投放方案'));
    });

    it('updates session status throughout pipeline', async () => {
      await collectEvents(orchestrate('session-1'));

      // Should have set status to 'running' then 'awaiting_approval'
      assert.ok(sessionUpdates.some(u => u.status === 'running'));
      assert.ok(sessionUpdates.some(u => u.status === 'awaiting_approval'));
    });

    it('emits error when session not found', async () => {
      mockSession = null;
      const events = await collectEvents(orchestrate('nonexistent'));
      assert.equal(events[0].event, 'error');
      assert.ok(events[0].data.message.includes('not found'));
    });

    it('emits error when brief is incomplete', async () => {
      mockBrief = { id: 'b1', brief: {} };
      const events = await collectEvents(orchestrate('session-1'));
      assert.equal(events[0].event, 'error');
      assert.ok(events[0].data.message.includes('incomplete'));
    });
  });

  describe('orchestrate — resume', () => {
    it('skips completed phases', async () => {
      mockSession.phase_results = { research: MOCK_RESEARCH };
      const events = await collectEvents(orchestrate('session-1'));

      const starts = findEvents(events, 'orchestration_start');
      assert.equal(starts[0].data.start_phase, 'strategy');
    });
  });

  describe('orchestrateAfterApproval', () => {
    it('runs execution phase after approval', async () => {
      mockSession.status = 'awaiting_approval';
      mockSession.phase_results = {
        research: MOCK_RESEARCH,
        strategy: MOCK_STRATEGY,
        creative: { creatives: {} },
      };

      const events = await collectEvents(orchestrateAfterApproval('session-1'));

      const phaseStarts = findEvents(events, 'phase_start');
      assert.equal(phaseStarts.length, 1);
      assert.equal(phaseStarts[0].data.phase, 'execution');

      assert.equal(findEvents(events, 'done').length, 1);

      // Should persist user approval message
      const userApproval = persistedMessages.find(m => m.role === 'user' && m.phase === null);
      assert.ok(userApproval, 'Should persist user approval');
      assert.ok(userApproval.content.includes('确认执行'));
    });

    it('rejects if not awaiting approval', async () => {
      mockSession.status = 'completed';
      const events = await collectEvents(orchestrateAfterApproval('session-1'));
      assert.equal(events[0].event, 'error');
      assert.ok(events[0].data.message.includes('not awaiting approval'));
    });
  });

  describe('chatWithOrchestrator', () => {
    it('streams response and persists conversation', async () => {
      mockSession.status = 'awaiting_approval';
      mockSession.phase_results = { research: MOCK_RESEARCH };

      const events = await collectEvents(chatWithOrchestrator('session-1', '方案的预算分配怎样？'));

      // Should have delta and done events
      const deltas = findEvents(events, 'delta');
      assert.ok(deltas.length > 0, 'Should stream text deltas');
      assert.equal(findEvents(events, 'done').length, 1);

      // Should persist both user and assistant messages
      const userMsg = persistedMessages.find(m => m.role === 'user' && m.content === '方案的预算分配怎样？');
      assert.ok(userMsg, 'Should persist user message');
      assert.equal(userMsg.phase, null, 'User chat should have phase=null');

      const assistantMsg = persistedMessages.find(m => m.role === 'assistant' && m.phase === null);
      assert.ok(assistantMsg, 'Should persist assistant response');
    });
  });

  describe('phase error handling', () => {
    it('emits phase_error and sets session to failed', async () => {
      const { conductResearch } = await import(researchUrl);
      conductResearch.mock.mockImplementationOnce(async () => {
        throw new Error('API rate limit');
      });

      const events = await collectEvents(orchestrate('session-1'));

      const errors = findEvents(events, 'phase_error');
      assert.equal(errors.length, 1);
      assert.equal(errors[0].data.phase, 'research');
      assert.ok(errors[0].data.error.includes('rate limit'));

      assert.ok(sessionUpdates.some(u => u.status === 'failed'));
    });
  });

  describe('detectStartPhase', () => {
    it('returns first phase when no results', () => {
      assert.equal(detectStartPhase({ phase_results: {} }), 'research');
    });

    it('returns next incomplete phase', () => {
      assert.equal(detectStartPhase({ phase_results: { research: {}, strategy: {} } }), 'creative');
    });
  });

  describe('summarizePhaseResult', () => {
    it('summarizes research', () => {
      const s = summarizePhaseResult('research', MOCK_RESEARCH);
      assert.equal(s.recommendations_count, 1);
    });

    it('summarizes strategy', () => {
      const s = summarizePhaseResult('strategy', MOCK_STRATEGY);
      assert.deepEqual(s.platforms, ['meta']);
    });

    it('summarizes execution', () => {
      const s = summarizePhaseResult('execution', MOCK_EXECUTION);
      assert.equal(s.status, 'completed');
    });
  });
});

describe('evaluateOutput', () => {
  it('scores research with all fields as 100', async () => {
    const { evaluateOutput } = await import(orchUrl);
    const result = evaluateOutput('research', {
      recommendations: ['Focus on Meta'],
      platform_recommendations: [{ platform: 'meta', fit_score: 9 }],
      competitor_ads: { summary: 'Competitors use video' },
    });
    assert.equal(result.score, 100);
    assert.equal(result.issues.length, 0);
  });

  it('scores research with missing fields as 50 or lower', async () => {
    const { evaluateOutput } = await import(orchUrl);
    const result = evaluateOutput('research', {
      recommendations: [],
      platform_recommendations: [],
    });
    assert.ok(result.score <= 50, `Score should be <= 50, got ${result.score}`);
    assert.ok(result.issues.length >= 2);
  });

  it('scores strategy with bad budget allocation', async () => {
    const { evaluateOutput } = await import(orchUrl);
    const result = evaluateOutput('strategy', {
      platforms: [{ platform: 'meta', budget_allocation: 40, campaigns: [{}] }],
    });
    assert.ok(result.issues.some(i => i.includes('预算')));
  });
});
