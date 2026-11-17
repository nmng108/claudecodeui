import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { FormEvent } from 'react';
import { beforeEach, test, vi } from 'vitest';

import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import { resetChatDrafts } from '@/shared/chatDrafts';
import type { ChatMessage, PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * Kiro's /compact is a single request that can run for minutes, and the chat
 * showed nothing while it did: the session looked idle and the command could be
 * sent again. A command the server marks with `metadata.pendingLabel` now puts
 * the session in the processing map for as long as the request runs, and a
 * repeat of it is refused until it answers.
 */

const PROJECT: Project = {
  projectId: 'project-1',
  displayName: 'Project One',
  fullPath: '/tmp/project-one',
};

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

// The execute call stays open until the test settles it, like a real compaction.
let settleExecute: (value: unknown) => void = () => {};
const execute = vi.fn(() => new Promise((resolve) => { settleExecute = resolve; }));

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      drafts: () => okJson({ success: true, drafts: [] }),
      saveDraft: () => okJson({ success: true }),
      deleteDraft: () => okJson({ success: true }),
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    commands: {
      list: () => okJson({
        builtIn: [{
          name: '/compact',
          description: 'Summarize the conversation',
          namespace: 'builtin',
          metadata: { type: 'builtin', pendingLabel: 'Compacting conversation' },
        }],
        custom: [],
      }),
      execute: () => execute(),
    },
    providers: { skills: () => okJson({ data: { skills: [] } }) },
    files: { search: () => okJson({ success: true, files: [] }) },
  },
}));

// What the processing map would report once the session is marked as busy.
let sessionIsLoading = false;

type Processing = { sessionId: string; statusText: string | null | undefined; canInterrupt: boolean | undefined };

const renderComposer = () => {
  const processing: Processing[] = [];
  const idle: string[] = [];
  const messages: ChatMessage[] = [];
  const view = renderHook(() => useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: { id: 'session-a' } as ProjectSession,
    currentSessionId: 'session-a',
    provider: 'kiro',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading: sessionIsLoading,
    canAbortSession: false,
    tokenBudget: null,
    sendMessage: () => undefined,
    onSessionProcessing: (sessionId, activity) => {
      processing.push({ sessionId: sessionId as string, statusText: activity?.statusText, canInterrupt: activity?.canInterrupt });
    },
    onSessionIdle: (sessionId) => { idle.push(sessionId as string); },
    scrollToBottom: () => undefined,
    addMessage: (message) => { messages.push(message); },
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }));
  return { view, processing, idle, messages };
};

const submit = async (view: ReturnType<typeof renderComposer>['view'], text: string) => {
  await act(async () => {
    view.result.current.setInput(text);
  });
  await act(async () => {
    await view.result.current.handleSubmit({ preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>);
  });
};

beforeEach(() => {
  localStorage.clear();
  resetChatDrafts();
  execute.mockClear();
  sessionIsLoading = false;
});

test('a pending command marks the session as compacting until the server answers', async () => {
  const { view, processing, idle } = renderComposer();
  await waitFor(() => assert.equal(view.result.current.slashCommandsCount, 1));

  await submit(view, '/compact');

  assert.deepEqual(processing, [{ sessionId: 'session-a', statusText: 'Compacting conversation', canInterrupt: false }]);
  assert.deepEqual(idle, [], 'still running');

  await act(async () => {
    settleExecute({ ok: true, json: async () => ({ type: 'builtin', action: 'notice', data: { message: 'done' } }) });
  });

  await waitFor(() => assert.deepEqual(idle, ['session-a']));
});

test('the same command is not started twice while it runs', async () => {
  const { view, processing, messages } = renderComposer();
  await waitFor(() => assert.equal(view.result.current.slashCommandsCount, 1));

  await submit(view, '/compact');
  await submit(view, '/compact');

  assert.equal(execute.mock.calls.length, 1);
  assert.equal(processing.length, 1);
  assert.equal(messages.length, 0, 'a repeat is ignored, not reported as an error');

  await act(async () => {
    settleExecute({ ok: true, json: async () => ({ type: 'builtin', action: 'notice', data: { message: 'done' } }) });
  });
});

test('a failed command still releases the session and allows another try', async () => {
  const { view, idle, messages } = renderComposer();
  await waitFor(() => assert.equal(view.result.current.slashCommandsCount, 1));

  await submit(view, '/compact');
  await act(async () => {
    settleExecute({ ok: false, status: 409, json: async () => ({ error: 'Kiro is already compacting this conversation.' }) });
  });

  await waitFor(() => assert.deepEqual(idle, ['session-a']));
  assert.match(String(messages.at(-1)?.content), /already compacting/);

  await submit(view, '/compact');
  assert.equal(execute.mock.calls.length, 2, 'the guard is released after a failure');
  await act(async () => {
    settleExecute({ ok: true, json: async () => ({ type: 'builtin', action: 'notice', data: { message: 'done' } }) });
  });
});

test('the command typed again while the session is busy says so instead of queueing a second run', async () => {
  const { view, messages } = renderComposer();
  await waitFor(() => assert.equal(view.result.current.slashCommandsCount, 1));

  await submit(view, '/compact');
  // The processing mark the first run set now reaches the composer as isLoading.
  sessionIsLoading = true;
  view.rerender();
  await submit(view, '/compact');

  assert.equal(execute.mock.calls.length, 1);
  assert.equal(String(messages.at(-1)?.content), '/compact is already running.');

  await act(async () => {
    settleExecute({ ok: true, json: async () => ({ type: 'builtin', action: 'notice', data: { message: 'done' } }) });
  });
});
