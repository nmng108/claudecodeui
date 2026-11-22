import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * A live thinking row has a random id, the persisted copy of the same thought
 * has the transcript's id. Once the transcript holds the thought the live row
 * must go, otherwise returning to a session shows every thought twice.
 */

const sessionMessages = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      sessionMessages: (...args: unknown[]) => sessionMessages(...args),
    },
  },
}));

const message = (
  id: string,
  second: number,
  fields: Partial<NormalizedMessage>,
): NormalizedMessage => ({
  id,
  provider: 'kiro',
  sessionId: 'session-1',
  timestamp: `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`,
  ...fields,
} as NormalizedMessage);

const HISTORY = [
  message('s:0', 0, { kind: 'text', role: 'user', content: 'question' }),
  message('s:1', 2, { kind: 'thinking', content: 'I should look at the\nfile first' }),
  message('s:2', 3, { kind: 'text', role: 'assistant', content: 'answer' }),
];

beforeEach(() => {
  sessionMessages.mockReset();
  sessionMessages.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { messages: HISTORY, total: HISTORY.length, hasMore: false } }),
  });
});

afterEach(() => {
  vi.resetModules();
});

async function openStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  return renderHook(() => useSessionStore());
}

describe('live thinking rows after a server refresh', () => {
  it('drops a live thought the transcript already holds, whatever its line breaks', async () => {
    const { result } = await openStore();

    act(() => {
      result.current.appendRealtime('session-1', message('thinking_live', 2, {
        kind: 'thinking',
        content: 'I should look at the file first',
      }));
    });
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });

    const thoughts = result.current.getMessages('session-1').filter((row) => row.kind === 'thinking');
    assert.deepEqual(thoughts.map((row) => row.id), ['s:1']);
  });

  it('drops a live thought when the optimistic user row of its turn is still in the store', async () => {
    const { result } = await openStore();

    // The composer's local echo and the transcript's copy of the same message
    // must count as one turn, or the thought is looked up under the wrong turn.
    act(() => {
      result.current.appendRealtime('session-1', message('local_1', 0, {
        kind: 'text',
        role: 'user',
        content: 'question',
      }));
      result.current.appendRealtime('session-1', message('thinking_live', 2, {
        kind: 'thinking',
        content: 'I should look at the file first',
      }));
    });
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });

    const rows = result.current.getMessages('session-1');
    assert.deepEqual(rows.filter((row) => row.kind === 'thinking').map((row) => row.id), ['s:1']);
    assert.equal(rows.some((row) => row.id === 'local_1'), false);
  });

  it('keeps a live thought the transcript does not hold yet', async () => {
    const { result } = await openStore();

    act(() => {
      result.current.appendRealtime('session-1', message('thinking_live', 4, {
        kind: 'thinking',
        content: 'a thought that is not on disk yet',
      }));
    });
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });

    const thoughts = result.current.getMessages('session-1').filter((row) => row.kind === 'thinking');
    assert.deepEqual(thoughts.map((row) => row.id), ['s:1', 'thinking_live']);
  });

  it('keeps a short live thought that only appears inside a longer persisted one', async () => {
    const { result } = await openStore();

    act(() => {
      result.current.appendRealtime('session-1', message('thinking_live', 2, {
        kind: 'thinking',
        content: 'file first',
      }));
    });
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 20, offset: 0 });
    });

    const thoughts = result.current.getMessages('session-1').filter((row) => row.kind === 'thinking');
    assert.deepEqual(thoughts.map((row) => row.id), ['s:1', 'thinking_live']);
  });

  it('refreshes a long session with many live thoughts without re-sorting per thought', async () => {
    // The shared helper only formats seconds below a minute; this session runs for hours.
    const at = (second: number) => new Date(Date.UTC(2026, 0, 1) + second * 1000).toISOString();
    const turns = 1500;
    const rows: NormalizedMessage[] = [];
    for (let turn = 0; turn < turns; turn++) {
      const base = turn * 10;
      rows.push(message(`u${turn}`, 0, { timestamp: at(base), kind: 'text', role: 'user', content: `q${turn}` }));
      rows.push(message(`t${turn}a`, 0, { timestamp: at(base + 1), kind: 'thinking', content: `thought ${turn} a` }));
      rows.push(message(`t${turn}b`, 0, { timestamp: at(base + 2), kind: 'thinking', content: `thought ${turn} b` }));
      rows.push(message(`a${turn}`, 0, { timestamp: at(base + 3), kind: 'text', role: 'assistant', content: `answer ${turn}` }));
    }
    sessionMessages.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { messages: rows, total: rows.length, hasMore: false } }),
    });
    const { result } = await openStore();

    act(() => {
      for (let live = 0; live < 300; live++) {
        result.current.appendRealtime('session-1', message(`live${live}`, 0, {
          timestamp: at((turns - 1) * 10 + 5),
          kind: 'thinking',
          content: `fresh thought number ${live}`,
        }));
      }
    });
    const startedAt = performance.now();
    await act(async () => {
      await result.current.fetchFromServer('session-1', { limit: 10000, offset: 0 });
    });
    const elapsedMs = performance.now() - startedAt;

    const kept = result.current.getMessages('session-1').filter((row) => row.id.startsWith('live'));
    assert.equal(kept.length, 300);
    // Sorting all rows per live thought took over a second here; one sort is far under this bound.
    assert.ok(elapsedMs < 400, `refresh took ${elapsedMs}ms`);
  });
});
