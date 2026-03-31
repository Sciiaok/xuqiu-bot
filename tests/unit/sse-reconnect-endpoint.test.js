import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Redis
const mockXrange = vi.fn();
const mockXread = vi.fn();
const mockDisconnect = vi.fn();
const mockBlockingClient = { xread: mockXread, disconnect: mockDisconnect };

vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({ xrange: mockXrange }),
  createBlockingClient: () => mockBlockingClient,
  streamKey: (id) => `sse:${id}`,
  STREAM_TTL_SECONDS: 14400,
}));

// Mock Supabase auth
vi.mock('../../lib/supabase-server.js', () => ({
  createClient: () => ({
    auth: { getUser: () => ({ data: { user: { id: 'user-1' } } }) },
  }),
}));

// Mock repository
const mockGetSession = vi.fn();
const mockGetLatestSession = vi.fn();
vi.mock('../../lib/repositories/orchestrator.repository.js', () => ({
  getSession: (...args) => mockGetSession(...args),
  getLatestSession: (...args) => mockGetLatestSession(...args),
}));

vi.mock('../../lib/repositories/campaign-brief.repository.js', () => ({
  getBrief: () => ({ id: 'brief-1', brief_id: 'brief-1' }),
}));

const { GET } = await import(
  '../../app/api/campaign/orchestrate/[id]/stream/route.js'
);

describe('GET /api/campaign/orchestrate/[id]/stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue({
      id: 'sess-1',
      brief_id: 'brief-1',
      status: 'running',
    });
  });

  it('should return 400 if lastEventId is missing', async () => {
    const req = new Request('http://localhost/api/campaign/orchestrate/sess-1/stream');
    const res = await GET(req, { params: Promise.resolve({ id: 'sess-1' }) });
    expect(res.status).toBe(400);
  });

  it('should return 400 if lastEventId format is invalid', async () => {
    const req = new Request('http://localhost/api/campaign/orchestrate/sess-1/stream?lastEventId=bad-id');
    const res = await GET(req, { params: Promise.resolve({ id: 'sess-1' }) });
    expect(res.status).toBe(400);
  });

  it('should return SSE response with correct headers for valid request', async () => {
    mockXrange.mockResolvedValue([
      ['1234-0', ['event', 'delta', 'data', '{"text":"hi"}']],
    ]);
    mockXread.mockResolvedValue(null);
    mockGetSession.mockResolvedValue({
      id: 'sess-1',
      brief_id: 'brief-1',
      status: 'completed',
    });

    const req = new Request(
      'http://localhost/api/campaign/orchestrate/sess-1/stream?lastEventId=1233-0'
    );
    const res = await GET(req, { params: Promise.resolve({ id: 'sess-1' }) });

    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('should replay events from XRANGE after lastEventId', async () => {
    mockXrange.mockResolvedValue([
      ['1234-0', ['event', 'delta', 'data', '{"text":"missed1"}']],
      ['1235-0', ['event', 'done', 'data', '{}']],
    ]);
    mockGetSession.mockResolvedValue({
      id: 'sess-1',
      brief_id: 'brief-1',
      status: 'completed',
    });

    const req = new Request(
      'http://localhost/api/campaign/orchestrate/sess-1/stream?lastEventId=1233-0'
    );
    const res = await GET(req, { params: Promise.resolve({ id: 'sess-1' }) });
    const text = await res.text();

    expect(text).toContain('id: 1234-0');
    expect(text).toContain('event: delta');
    expect(text).toContain('data: {"text":"missed1"}');
    expect(text).toContain('id: 1235-0');
    expect(text).toContain('event: done');
  });

  it('should send synthetic done if session already completed and no replay events', async () => {
    mockXrange.mockResolvedValue([]);
    mockGetSession.mockResolvedValue({
      id: 'sess-1',
      brief_id: 'brief-1',
      status: 'completed',
    });

    const req = new Request(
      'http://localhost/api/campaign/orchestrate/sess-1/stream?lastEventId=9999-0'
    );
    const res = await GET(req, { params: Promise.resolve({ id: 'sess-1' }) });
    const text = await res.text();

    expect(text).toContain('event: done');
  });
});
