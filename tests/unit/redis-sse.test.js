import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ioredis before importing sse.js
const mockXadd = vi.fn().mockResolvedValue('1234567890-0');
const mockExpire = vi.fn().mockResolvedValue(1);
vi.mock('../../lib/redis.js', () => ({
  getRedis: () => ({ xadd: mockXadd, expire: mockExpire }),
  streamKey: (id) => `sse:${id}`,
  STREAM_TTL_SECONDS: 14400,
}));

const { streamSSE } = await import('../../lib/sse.js');

describe('streamSSE with Redis Stream', () => {
  beforeEach(() => {
    mockXadd.mockClear();
    mockExpire.mockClear();
  });

  it('should emit SSE id: field from Redis Stream ID when streamKey provided', async () => {
    async function* gen() {
      yield { event: 'delta', data: { text: 'hello' } };
    }

    const response = streamSSE(gen(), { streamKey: 'sse:brief-1' });
    const text = await response.text();

    expect(text).toContain('id: 1234567890-0');
    expect(text).toContain('event: delta');
    expect(text).toContain('data: {"text":"hello"}');
  });

  it('should XADD each event to Redis Stream', async () => {
    async function* gen() {
      yield { event: 'delta', data: { text: 'hi' } };
      yield { event: 'done', data: {} };
    }

    const response = streamSSE(gen(), { streamKey: 'sse:brief-2' });
    await response.text();

    expect(mockXadd).toHaveBeenCalledTimes(2);
    expect(mockXadd).toHaveBeenCalledWith(
      'sse:brief-2', '*',
      'event', 'delta',
      'data', '{"text":"hi"}',
    );
  });

  it('should set EXPIRE on first XADD', async () => {
    async function* gen() {
      yield { event: 'delta', data: { text: 'a' } };
      yield { event: 'delta', data: { text: 'b' } };
    }

    const response = streamSSE(gen(), { streamKey: 'sse:brief-3' });
    await response.text();

    expect(mockExpire).toHaveBeenCalledTimes(1);
    expect(mockExpire).toHaveBeenCalledWith('sse:brief-3', 14400);
  });

  it('should work without streamKey (backward compatible)', async () => {
    async function* gen() {
      yield { event: 'delta', data: { text: 'no redis' } };
    }

    const response = streamSSE(gen());
    const text = await response.text();

    expect(text).toContain('event: delta');
    expect(text).not.toContain('id:');
    expect(mockXadd).not.toHaveBeenCalled();
  });

  it('should not break SSE if XADD fails', async () => {
    mockXadd.mockRejectedValueOnce(new Error('Redis down'));

    async function* gen() {
      yield { event: 'delta', data: { text: 'still works' } };
    }

    const response = streamSSE(gen(), { streamKey: 'sse:brief-4' });
    const text = await response.text();

    expect(text).toContain('event: delta');
    expect(text).toContain('data: {"text":"still works"}');
  });
});
