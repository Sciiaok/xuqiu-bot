import { createClient } from '../../../../../../lib/supabase-server.js';
import {
  getSession,
  getLatestSession,
} from '../../../../../../lib/repositories/orchestrator.repository.js';
import { getBrief } from '../../../../../../lib/repositories/campaign-brief.repository.js';
import { getRedis, createBlockingClient, streamKey } from '../../../../../../lib/redis.js';

const VALID_STREAM_ID = /^\d+-\d+$/;
const TERMINAL_STATUSES = new Set(['completed', 'failed']);
const XREAD_BLOCK_MS = 30_000;

/**
 * GET /api/campaign/orchestrate/[id]/stream?lastEventId=xxx
 *
 * Reconnection endpoint: replays missed SSE events from Redis Stream,
 * then switches to real-time XREAD BLOCK until session completes.
 */
export async function GET(request, { params }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { searchParams } = new URL(request.url);
  const lastEventId = searchParams.get('lastEventId') || '0-0';

  if (!VALID_STREAM_ID.test(lastEventId)) {
    return Response.json(
      { error: 'Invalid lastEventId format (expected: digits-digits, e.g. 0-0)' },
      { status: 400 },
    );
  }

  // Resolve session
  let session = await getSession(id);
  if (!session) {
    session = await getLatestSession(id);
  }
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }

  const brief = await getBrief(session.brief_id);
  const key = streamKey(brief?.id || session.brief_id);

  const encoder = new TextEncoder();
  let blockingClient = null;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (eventId, eventType, data) => {
        let frame = '';
        if (eventId) frame += `id: ${eventId}\n`;
        frame += `event: ${eventType}\ndata: ${data}\n\n`;
        controller.enqueue(encoder.encode(frame));
      };

      try {
        const redis = getRedis();

        // Phase 1: Replay missed events via XRANGE (exclusive start)
        // Use '-' for 0-0 (read from start), otherwise increment seq to skip last-seen event
        // Note: avoid '(' exclusive prefix — requires Redis 6.2+
        let rangeStart = '-';
        if (lastEventId !== '0-0') {
          const [ms, seq] = lastEventId.split('-');
          rangeStart = `${ms}-${Number(seq) + 1}`;
        }
        const replayEvents = await redis.xrange(key, rangeStart, '+');
        let lastId = lastEventId;

        for (const [eventId, fields] of replayEvents) {
          const eventType = fields[fields.indexOf('event') + 1];
          const eventData = fields[fields.indexOf('data') + 1];
          send(eventId, eventType, eventData);
          lastId = eventId;
        }

        // Check if session already finished (based on DB status, not event names)
        const freshSession = await getSession(session.id);
        if (TERMINAL_STATUSES.has(freshSession?.status)) {
          const lastReplayEvent = replayEvents.length > 0
            ? replayEvents[replayEvents.length - 1][1][replayEvents[replayEvents.length - 1][1].indexOf('event') + 1]
            : null;
          if (lastReplayEvent !== 'done' && lastReplayEvent !== 'error') {
            send(null, 'done', JSON.stringify({ status: freshSession.status }));
          }
          controller.close();
          return;
        }

        // Phase 2: Real-time via XREAD BLOCK
        blockingClient = createBlockingClient();
        await blockingClient.connect?.();

        while (true) {
          const result = await blockingClient.xread(
            'BLOCK', XREAD_BLOCK_MS,
            'STREAMS', key, lastId,
          );

          if (!result) {
            const currentSession = await getSession(session.id);
            if (!currentSession || TERMINAL_STATUSES.has(currentSession.status)) {
              send(null, 'done', JSON.stringify({ status: currentSession?.status || 'unknown' }));
              break;
            }
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
            continue;
          }

          const entries = result[0][1];
          let sawTerminalEvent = false;
          for (const [eventId, fields] of entries) {
            const eventType = fields[fields.indexOf('event') + 1];
            const eventData = fields[fields.indexOf('data') + 1];
            send(eventId, eventType, eventData);
            lastId = eventId;
            if (eventType === 'done' || eventType === 'error') sawTerminalEvent = true;
          }

          // Only close if session is actually terminal (done event may be mid-pipeline, e.g. intake done)
          if (sawTerminalEvent) {
            const currentSession = await getSession(session.id);
            if (!currentSession || TERMINAL_STATUSES.has(currentSession.status)) {
              controller.close();
              blockingClient.disconnect();
              blockingClient = null;
              return;
            }
          }
        }
      } catch (err) {
        try {
          send(null, 'error', JSON.stringify({ message: err.message }));
        } catch {}
      } finally {
        if (blockingClient) {
          blockingClient.disconnect();
          blockingClient = null;
        }
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      if (blockingClient) {
        blockingClient.disconnect();
        blockingClient = null;
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
