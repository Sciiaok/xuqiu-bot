/**
 * Parse SSE stream and call handler for each event.
 * Tracks the last event ID for reconnection.
 * Returns the last event ID seen (or null if none).
 */
export async function consumeSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventType = null;
  let eventId = null;
  let lastEventId = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('id: ')) {
          eventId = line.slice(4);
        } else if (line.startsWith('event: ')) {
          eventType = line.slice(7);
        } else if (line.startsWith('data: ') && eventType) {
          try {
            const data = JSON.parse(line.slice(6));
            if (eventId) lastEventId = eventId;
            onEvent(eventType, data);
          } catch { /* skip malformed */ }
          eventType = null;
          eventId = null;
        }
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return lastEventId;
    throw err;
  }
  return lastEventId;
}
