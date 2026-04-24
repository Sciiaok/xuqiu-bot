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
  it('handles stream end (empty stream)', async () => {
    const handler = vi.fn();
    const response = fakeResponse([]);

    await consumeSSE(response, handler);

    expect(handler).not.toHaveBeenCalled();
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
