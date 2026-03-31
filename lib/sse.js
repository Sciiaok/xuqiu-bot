import { getRedis, STREAM_TTL_SECONDS } from './redis.js';

/**
 * Stream SSE events from an async generator.
 *
 * Options:
 * - heartbeatIntervalMs: send heartbeat comments at this interval (0 = disabled)
 * - onAbort: callback when client disconnects
 * - streamKey: if provided, each event is also written to this Redis Stream key
 *              via XADD, and the Redis Stream ID is emitted as the SSE `id:` field.
 */
export function streamSSE(generator, { heartbeatIntervalMs = 0, onAbort, streamKey } = {}) {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let abortCallback = null;
  let cleanupDone = false;

  if (onAbort) {
    abortCallback = async () => {
      if (cleanupDone) return;
      cleanupDone = true;
      try {
        await onAbort();
      } catch {}
    };
  }

  const stream = new ReadableStream({
    async start(controller) {
      let heartbeatTimer;
      if (heartbeatIntervalMs > 0) {
        heartbeatTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          } catch {
            abortController.abort();
          }
        }, heartbeatIntervalMs);
      }

      let ttlSet = false;
      const redis = streamKey ? getRedis() : null;

      try {
        for await (const event of generator) {
          if (abortController.signal.aborted) break;

          // Write to Redis Stream (non-blocking, non-fatal)
          let eventId = null;
          if (redis && streamKey) {
            try {
              eventId = await redis.xadd(
                streamKey, '*',
                'event', event.event,
                'data', JSON.stringify(event.data),
              );
              if (!ttlSet) {
                await redis.expire(streamKey, STREAM_TTL_SECONDS);
                ttlSet = true;
              }
            } catch (err) {
              console.warn('[sse] Redis XADD failed, continuing without persistence:', err.message);
            }
          }

          // Build SSE frame
          let sseData = '';
          if (eventId) {
            sseData += `id: ${eventId}\n`;
          }
          sseData += `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

          try {
            controller.enqueue(encoder.encode(sseData));
          } catch {
            abortController.abort();
            break;
          }
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          try {
            const errorEvent = `event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`;
            controller.enqueue(encoder.encode(errorEvent));
          } catch {}
        }
      } finally {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      abortController.abort();
      if (abortCallback) {
        abortCallback();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
