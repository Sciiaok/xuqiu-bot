import { describe, it, expect, vi } from 'vitest';
import { consumeSSE } from '../consume-sse.js';

/** Helper: create a fake Response whose body yields the given chunks */
function fakeResponse(chunks) {
  let idx = 0;
  const reader = {
    read: vi.fn(async () => {
      if (idx >= chunks.length) return { done: true, value: undefined };
      const chunk = new TextEncoder().encode(chunks[idx++]);
      return { done: false, value: chunk };
    }),
  };
  return { body: { getReader: () => reader } };
}

describe('consumeSSE', () => {
  it('parses a single SSE event', async () => {
    const handler = vi.fn();
    const response = fakeResponse([
      'event: message\ndata: {"text":"hello"}\n\n',
    ]);

    await consumeSSE(response, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('message', { text: 'hello' });
  });

  it('parses multiple events in one chunk', async () => {
    const handler = vi.fn();
    const response = fakeResponse([
      'event: msg1\ndata: {"a":1}\n\nevent: msg2\ndata: {"b":2}\n\n',
    ]);

    await consumeSSE(response, handler);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith('msg1', { a: 1 });
    expect(handler).toHaveBeenCalledWith('msg2', { b: 2 });
  });

  it('parses events split across chunks', async () => {
    const handler = vi.fn();
    const response = fakeResponse([
      'event: split\n',
      'data: {"val":"ok"}\n\n',
    ]);

    await consumeSSE(response, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('split', { val: 'ok' });
  });

  it('handles malformed JSON gracefully (skips the event)', async () => {
    const handler = vi.fn();
    const response = fakeResponse([
      'event: bad\ndata: {not json}\n\nevent: good\ndata: {"ok":true}\n\n',
    ]);

    await consumeSSE(response, handler);

    // Only the valid event should be emitted
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('good', { ok: true });
  });

  it('handles stream end (empty stream)', async () => {
    const handler = vi.fn();
    const response = fakeResponse([]);

    await consumeSSE(response, handler);

    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores data lines without a preceding event type', async () => {
    const handler = vi.fn();
    const response = fakeResponse([
      'data: {"orphan":true}\n\nevent: real\ndata: {"ok":1}\n\n',
    ]);

    await consumeSSE(response, handler);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('real', { ok: 1 });
  });

  it('tracks and returns lastEventId from id: lines', async () => {
    const handler = vi.fn();
    const response = fakeResponse([
      'id: 100-0\nevent: a\ndata: {"x":1}\n\nid: 200-0\nevent: b\ndata: {"x":2}\n\n',
    ]);

    const lastId = await consumeSSE(response, handler);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(lastId).toBe('200-0');
  });

  it('returns null when no id: lines are present', async () => {
    const handler = vi.fn();
    const response = fakeResponse([
      'event: msg\ndata: {"ok":true}\n\n',
    ]);

    const lastId = await consumeSSE(response, handler);

    expect(lastId).toBeNull();
  });

  it('suppresses AbortError and returns lastEventId', async () => {
    const handler = vi.fn();
    const abortErr = new DOMException('Aborted', 'AbortError');
    const reader = {
      read: vi.fn(async () => { throw abortErr; }),
    };
    const response = { body: { getReader: () => reader } };

    const lastId = await consumeSSE(response, handler);
    expect(lastId).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rethrows non-AbortError errors', async () => {
    const handler = vi.fn();
    const reader = {
      read: vi.fn(async () => { throw new Error('network fail'); }),
    };
    const response = { body: { getReader: () => reader } };

    await expect(consumeSSE(response, handler)).rejects.toThrow('network fail');
  });
});
