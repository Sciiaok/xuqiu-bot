import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Mock setup ─────────────────────────────────────────────────────────

const supabaseUrl = pathToFileURL(resolve(process.cwd(), 'lib/supabase.js')).href;

let mockBriefs = [];
let mockSessions = [];
let mockMessages = [];

const mockSupabase = {
  from: (table) => {
    if (table === 'campaign_briefs') {
      return {
        select: () => ({
          order: () => ({
            limit: async () => ({ data: mockBriefs, error: null }),
          }),
        }),
      };
    }
    if (table === 'orchestrator_sessions') {
      return {
        select: () => ({
          in: () => ({
            order: async () => ({ data: mockSessions, error: null }),
          }),
        }),
      };
    }
    if (table === 'orchestrator_messages') {
      return {
        select: () => ({
          in: () => ({
            eq: () => ({
              order: async () => ({ data: mockMessages, error: null }),
            }),
          }),
        }),
      };
    }
    return {};
  },
};

mock.module(supabaseUrl, { defaultExport: mockSupabase });

// ── Import after mocks ────────────────────────────────────────────────

const routeUrl = pathToFileURL(resolve(process.cwd(), 'app/api/campaign/sessions/route.js')).href;
const { GET } = await import(routeUrl);

// ── Tests ──────────────────────────────────────────────────────────────

describe('GET /api/campaign/sessions', () => {
  beforeEach(() => {
    mockBriefs = [];
    mockSessions = [];
    mockMessages = [];
  });

  it('returns empty array when no briefs exist', async () => {
    const res = await GET();
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.deepEqual(body.data, []);
  });

  it('returns sessions with first_message from orchestrator_messages', async () => {
    mockBriefs = [
      {
        id: 'brief-1',
        brief: { industry: '农业机械', target_countries: ['肯尼亚'] },
        completion: { completion_pct: 78 },
        status: 'completed',
        created_at: '2026-03-23T10:00:00Z',
        updated_at: '2026-03-23T10:30:00Z',
      },
    ];

    mockSessions = [
      {
        id: 'session-1',
        brief_id: 'brief-1',
        status: 'running',
        current_phase: 'strategy',
        phase_results: { research: {} },
        created_at: '2026-03-23T10:05:00Z',
      },
    ];

    mockMessages = [
      { session_id: 'session-1', content: '我想推广拖拉机到非洲' },
      { session_id: 'session-1', content: '预算5000美金' },
    ];

    const res = await GET();
    const body = await res.json();

    assert.equal(body.data.length, 1);
    const session = body.data[0];
    assert.equal(session.brief_id, 'brief-1');
    assert.equal(session.session_id, 'session-1');
    assert.equal(session.first_message, '我想推广拖拉机到非洲');
    assert.equal(session.status, 'running');
    assert.equal(session.current_phase, 'strategy');
    assert.equal(session.phase_index, 2);
    assert.equal(session.completion_pct, 78);
  });

  it('returns null first_message when no messages exist', async () => {
    mockBriefs = [
      {
        id: 'brief-2',
        brief: {},
        completion: {},
        status: 'active',
        created_at: '2026-03-22T10:00:00Z',
      },
    ];
    mockSessions = [];
    mockMessages = [];

    const res = await GET();
    const body = await res.json();

    assert.equal(body.data[0].first_message, null);
  });

  it('shows brief_completed status when brief done but no orchestration', async () => {
    mockBriefs = [
      {
        id: 'brief-3',
        brief: { industry: 'Test' },
        completion: { completion_pct: 100 },
        status: 'completed',
        created_at: '2026-03-22T10:00:00Z',
      },
    ];
    mockSessions = [];

    const res = await GET();
    const body = await res.json();

    assert.equal(body.data[0].status, 'brief_completed');
    assert.equal(body.data[0].phase_index, 1);
  });

  it('marks all phases complete when session status is completed', async () => {
    mockBriefs = [
      {
        id: 'brief-4',
        brief: { industry: 'Done' },
        completion: {},
        status: 'completed',
        created_at: '2026-03-22T10:00:00Z',
      },
    ];
    mockSessions = [
      {
        id: 'session-4',
        brief_id: 'brief-4',
        status: 'completed',
        current_phase: 'execution',
        phase_results: {},
        created_at: '2026-03-22T10:05:00Z',
      },
    ];

    const res = await GET();
    const body = await res.json();

    assert.equal(body.data[0].phase_index, 5);
    assert.equal(body.data[0].status, 'completed');
  });
});
