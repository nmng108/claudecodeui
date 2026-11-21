import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ProjectSession, ServerEvent } from '@/shared/types';

/**
 * A reply streaming into a session that is not on screen is still one growing
 * row. Storing each delta as its own row made the session show a pile of
 * word-sized fragments after switching back to it, and the single shared
 * buffer let two streaming sessions write into each other's row.
 */

const render = () => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const sessionStore = {
    appendRealtime: vi.fn(),
    updateStreaming: vi.fn(),
    finalizeStreaming: vi.fn(),
    getMessages: vi.fn(() => []),
  };

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'kiro',
    selectedSession: { id: 'viewed' } as ProjectSession,
    currentSessionId: 'viewed',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: new Map() },
    accumulatedStreamRef: { current: new Map() },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: sessionStore as unknown as SessionStore,
  }));

  const delta = (sessionId: string, content: string) => listener?.({
    kind: 'stream_delta',
    sessionId,
    content,
  } as unknown as ServerEvent);
  return { sessionStore, delta, send: (event: ServerEvent) => listener?.(event) };
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('deltas for a session that is not on screen build one row instead of one row per delta', () => {
  const { sessionStore, delta } = render();

  delta('background', 'CLI runs ro');
  delta('background', 'ughly:');
  vi.advanceTimersByTime(100);

  assert.equal(sessionStore.appendRealtime.mock.calls.length, 0);
  assert.deepEqual(sessionStore.updateStreaming.mock.calls.map((call) => [call[0], call[1]]), [
    ['background', 'CLI runs roughly:'],
  ]);
});

test('two sessions streaming at once keep separate text', () => {
  const { sessionStore, delta } = render();

  delta('viewed', 'first ');
  delta('background', 'other ');
  delta('viewed', 'reply');
  delta('background', 'reply');
  vi.advanceTimersByTime(100);

  const published = new Map(sessionStore.updateStreaming.mock.calls.map((call) => [call[0], call[1]]));
  assert.equal(published.get('viewed'), 'first reply');
  assert.equal(published.get('background'), 'other reply');
});

test('stream_end publishes what is buffered for that session only, then finalizes it', () => {
  const { sessionStore, delta, send } = render();

  delta('background', 'done');
  delta('viewed', 'still going');
  send({ kind: 'stream_end', sessionId: 'background' } as unknown as ServerEvent);

  assert.deepEqual(sessionStore.updateStreaming.mock.calls.map((call) => [call[0], call[1]]), [
    ['background', 'done'],
  ]);
  assert.deepEqual(sessionStore.finalizeStreaming.mock.calls.map((call) => call[0]), ['background']);

  vi.advanceTimersByTime(100);
  assert.deepEqual(sessionStore.updateStreaming.mock.calls.map((call) => [call[0], call[1]]), [
    ['background', 'done'],
    ['viewed', 'still going'],
  ]);
});
