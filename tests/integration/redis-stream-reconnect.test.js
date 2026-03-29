import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

// Skip if Redis is not available
let redis;
let available = false;

beforeAll(async () => {
  try {
    redis = new Redis(REDIS_URL, { connectTimeout: 2000 });
    await redis.ping();
    available = true;
  } catch {
    console.warn('Redis not available — skipping integration tests');
  }
});

afterAll(async () => {
  if (redis) await redis.quit();
});

describe.runIf(() => available)('Redis Stream SSE integration', () => {
  const testKey = `sse:test-${Date.now()}`;

  afterAll(async () => {
    if (redis) await redis.del(testKey);
  });

  it('should write events with XADD and read them back with XRANGE', async () => {
    const id1 = await redis.xadd(testKey, '*', 'event', 'delta', 'data', '{"text":"hello"}');
    const id2 = await redis.xadd(testKey, '*', 'event', 'done', 'data', '{}');

    const events = await redis.xrange(testKey, '0-0', '+');

    expect(events).toHaveLength(2);
    expect(events[0][0]).toBe(id1);
    expect(events[0][1]).toEqual(['event', 'delta', 'data', '{"text":"hello"}']);
    expect(events[1][0]).toBe(id2);
    expect(events[1][1]).toEqual(['event', 'done', 'data', '{}']);
  });

  it('should support exclusive range read (skip already-seen event)', async () => {
    const events = await redis.xrange(testKey, '0-0', '+');
    const firstId = events[0][0];

    const replay = await redis.xrange(testKey, firstId, '+');
    const filtered = replay.filter(([id]) => id !== firstId);

    expect(filtered).toHaveLength(1);
    expect(filtered[0][1]).toEqual(['event', 'done', 'data', '{}']);
  });

  it('should support XREAD BLOCK with timeout returning null', async () => {
    const result = await redis.xread('BLOCK', 100, 'STREAMS', testKey, '$');
    expect(result).toBeNull();
  });

  it('should EXPIRE key and have it TTL properly', async () => {
    await redis.expire(testKey, 10);
    const ttl = await redis.ttl(testKey);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(10);
  });
});
