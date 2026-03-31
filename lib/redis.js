import Redis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

/** Shared connection for non-blocking commands (XADD, XRANGE, EXPIRE, DEL) */
let sharedClient = null;

export function getRedis() {
  if (!sharedClient) {
    sharedClient = new Redis(REDIS_URL, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    sharedClient.on('error', (err) => {
      console.error('[redis] shared client error:', err.message);
    });
  }
  return sharedClient;
}

/**
 * Create a dedicated connection for XREAD BLOCK.
 * Caller MUST call .disconnect() when done to avoid connection leaks.
 */
export function createBlockingClient() {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null, // no retry limit for blocking reads
    lazyConnect: true,
  });
  client.on('error', (err) => {
    console.error('[redis] blocking client error:', err.message);
  });
  return client;
}

/** Stream key for a given briefId */
export function streamKey(briefId) {
  return `sse:${briefId}`;
}

/** TTL for stream keys: 4 hours */
export const STREAM_TTL_SECONDS = 4 * 60 * 60;
