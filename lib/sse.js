export function streamSSE(generator, { heartbeatIntervalMs = 0, onAbort } = {}) {
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
      try {
        for await (const event of generator) {
          if (abortController.signal.aborted) break;
          const sseData = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
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
