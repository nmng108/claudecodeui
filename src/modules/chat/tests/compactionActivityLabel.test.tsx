import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { NormalizedMessage, ProjectSession, ServerEvent, SessionActivity } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * A compaction reaches the client as a transcript row, never as a `status`
 * event, so the activity indicator used to keep rotating its generic words for
 * the minutes a compaction can take. The handler now names it while it runs.
 */

type Marked = { sessionId: string; statusText: string | null | undefined; canInterrupt: boolean | undefined };

const renderHandlers = (initialActivity: SessionActivity | undefined) => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const marked: Marked[] = [];
  let activity = initialActivity;

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: new Map() },
    accumulatedStreamRef: { current: new Map() },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    onSessionProcessing: (sessionId, next) => {
      marked.push({ sessionId: sessionId as string, statusText: next?.statusText, canInterrupt: next?.canInterrupt });
      // Mirror the provider: the map now holds what was just reported.
      activity = {
        statusText: next?.statusText ?? null,
        canInterrupt: next?.canInterrupt ?? true,
        startedAt: activity?.startedAt ?? 0,
      };
    },
    getSessionActivity: () => activity,
    requestLatestMessages: async () => {},
    sessionStore: {
      appendRealtime: () => {},
      getMessages: () => [] as NormalizedMessage[],
      updateStreaming: () => {},
      finalizeStreaming: () => {},
    } as unknown as SessionStore,
  }));

  return { dispatch: (event: ServerEvent) => listener?.(event), marked };
};

const compactionRow = (compact: Record<string, unknown>) => ({
  id: `compact-${Math.random()}`,
  sessionId: 'viewed-session',
  provider: 'claude',
  timestamp: '2026-08-21T10:32:10.000Z',
  kind: 'text',
  role: 'assistant',
  content: 'Compacting conversation…',
  compact,
} as unknown as ServerEvent);

const RUNNING_TURN: SessionActivity = { statusText: null, canInterrupt: true, startedAt: 1 };

test('a running compaction names itself in the activity indicator', () => {
  const { dispatch, marked } = renderHandlers(RUNNING_TURN);

  dispatch(compactionRow({ phase: 'running' }));

  assert.deepEqual(marked, [{ sessionId: 'viewed-session', statusText: 'Compacting conversation', canInterrupt: true }]);
});

test('the label goes back to the rotating words when the compaction is done', () => {
  const { dispatch, marked } = renderHandlers(RUNNING_TURN);

  dispatch(compactionRow({ phase: 'running' }));
  dispatch(compactionRow({ phase: 'done', trigger: 'manual', preTokens: 335000, postTokens: 10000 }));

  assert.equal(marked.at(-1)?.statusText, null);
});

test('a failed compaction also clears the label', () => {
  const { dispatch, marked } = renderHandlers(RUNNING_TURN);

  dispatch(compactionRow({ phase: 'running' }));
  dispatch(compactionRow({ phase: 'failed', error: 'boom' }));

  assert.equal(marked.at(-1)?.statusText, null);
});

test('a compaction row on an idle session does not mark it as processing', () => {
  const { dispatch, marked } = renderHandlers(undefined);

  dispatch(compactionRow({ phase: 'running' }));
  dispatch(compactionRow({ phase: 'done' }));

  assert.deepEqual(marked, []);
});

test('a finished compaction leaves another status text alone', () => {
  const { dispatch, marked } = renderHandlers({ statusText: 'Running tests', canInterrupt: true, startedAt: 1 });

  dispatch(compactionRow({ phase: 'done' }));

  assert.deepEqual(marked, []);
});
