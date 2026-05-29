import Redis from 'ioredis';
import { config } from '../src/config.js';

const REDIS_URL = config.redis.url;

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

/**
 * Create a dedicated connection for pub/sub SUBSCRIBE.
 *
 * ioredis 的 subscribe 是连接级独占模式（client 进入 subscriber state 后
 * 不能再跑普通命令），所以必须用一根专门的长连接，不能复用 sharedClient。
 * 与 createBlockingClient 平级 —— 同样 long-lived，永不 disconnect。
 */
export function createSubscriberClient() {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  client.on('error', (err) => {
    console.error('[redis] subscriber client error:', err.message);
  });
  return client;
}

/** Stream key for a given briefId */
export function streamKey(briefId) {
  return `sse:${briefId}`;
}

/** TTL for stream keys: 4 hours */
export const STREAM_TTL_SECONDS = 4 * 60 * 60;

/** Redis key for user input for a given sessionId */
export function userInputKey(sessionId) {
  return `user_input:${sessionId}`;
}

/** TTL for user input keys: 4 hours */
export const USER_INPUT_TTL_SECONDS = 4 * 60 * 60;

/** Redis key for stop signal */
export function stopKey(sessionId) {
  return `stop:${sessionId}`;
}

/** Check if a stop signal has been set for this session */
export async function isStopRequested(sessionId) {
  const redis = getRedis();
  return Boolean(await redis.exists(stopKey(sessionId)));
}
