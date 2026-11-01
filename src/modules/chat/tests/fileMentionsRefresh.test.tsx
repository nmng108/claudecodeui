import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import type { KeyboardEvent, RefObject } from 'react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * The `@` dropdown asks the server to search the project as the query is
 * typed. That keeps it correct for any workspace size (no whole-tree load in
 * the browser) and for files created after the composer mounted (uploads, agent
 * edits, the terminal, git checkouts), because every query is a fresh search.
 */

const searchFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: { searchFiles: (...args: unknown[]) => searchFiles(...args) },
}));

const { useFileMentions } = await import('@/modules/chat/hooks/useFileMentions');

const ROOT = '/home/user/project';
const project: Project = { projectId: 'p1', displayName: 'project', fullPath: ROOT };

const hit = (name: string) => ({ type: 'file', name, path: `${ROOT}/${name}`, relativePath: name });
const searchResponse = (names: string[]) => ({
  ok: true,
  json: async () => ({ results: names.map(hit), truncated: false }),
});

// A search response the test resolves by hand, to hold a request in flight.
const deferredSearchResponse = () => {
  let resolve: (names: string[]) => void = () => {};
  const promise = new Promise<ReturnType<typeof searchResponse>>((resolvePromise) => {
    resolve = (names) => resolvePromise(searchResponse(names));
  });
  return { promise, resolve };
};

const keyEvent = (key: string) =>
  ({ key, preventDefault: () => {} }) as unknown as KeyboardEvent<HTMLTextAreaElement>;

const renderMentions = () => {
  const textareaRef: RefObject<HTMLTextAreaElement> = { current: null };
  const hook = renderHook(
    ({ input }: { input: string }) =>
      useFileMentions({ selectedProject: project, input, setInput: vi.fn(), textareaRef }),
    { initialProps: { input: '' } },
  );

  // Mirrors the composer: the input changes and the caret follows it.
  const type = (input: string) => {
    hook.rerender({ input });
    act(() => {
      hook.result.current.setCursorPosition(input.length);
    });
  };

  const shownNames = () => hook.result.current.filteredFiles.map((file) => file.name);

  return { ...hook, type, shownNames };
};

const queriesSent = () => searchFiles.mock.calls.map((call) => (call[1] as { query: string }).query);

test('typing `@` searches the server for files and maps the hits', async () => {
  searchFiles.mockReset();
  searchFiles.mockResolvedValue(searchResponse(['uploaded.txt']));

  const { result, type, shownNames } = renderMentions();
  // Nothing is requested until the user types `@`.
  assert.equal(searchFiles.mock.calls.length, 0);

  type('@upl');

  await waitFor(() => assert.deepEqual(shownNames(), ['uploaded.txt']));
  assert.deepEqual(searchFiles.mock.calls[0][0], 'p1');
  assert.deepEqual(searchFiles.mock.calls[0][1], { query: 'upl', type: 'file', limit: 10 });
  // `path` is what lands in the message; `relativePath` carries the absolute path.
  assert.deepEqual(result.current.filteredFiles[0], {
    name: 'uploaded.txt',
    path: 'uploaded.txt',
    relativePath: `${ROOT}/uploaded.txt`,
  });
});

test('keystrokes inside one query are coalesced into a single search', async () => {
  searchFiles.mockReset();
  searchFiles.mockResolvedValue(searchResponse(['a.txt']));

  const { type, shownNames } = renderMentions();

  type('@a');
  type('@a.');
  type('@a.t');

  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));
  assert.deepEqual(queriesSent(), ['a.t']);
});

test('the previous list stays visible while the next search is in flight', async () => {
  searchFiles.mockReset();
  searchFiles.mockResolvedValueOnce(searchResponse(['a.txt']));
  const next = deferredSearchResponse();
  searchFiles.mockReturnValueOnce(next.promise);

  const { type, shownNames } = renderMentions();
  type('@a');
  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));

  type('@ab');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));
  assert.deepEqual(shownNames(), ['a.txt']);

  await act(async () => {
    next.resolve(['ab.txt']);
  });
  await waitFor(() => assert.deepEqual(shownNames(), ['ab.txt']));
});

test('an older search that lands after a newer one cannot overwrite it', async () => {
  searchFiles.mockReset();
  const older = deferredSearchResponse();
  const newer = deferredSearchResponse();
  searchFiles.mockReturnValueOnce(older.promise);
  searchFiles.mockReturnValueOnce(newer.promise);

  const { type, shownNames } = renderMentions();
  type('@a');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  type('@ab');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));

  // The newer request superseded the older one.
  const olderSignal = (searchFiles.mock.calls[0][2] as { signal: AbortSignal }).signal;
  assert.equal(olderSignal.aborted, true);

  await act(async () => {
    newer.resolve(['ab-newer.txt']);
  });
  await waitFor(() => assert.deepEqual(shownNames(), ['ab-newer.txt']));

  await act(async () => {
    older.resolve(['a-older.txt']);
  });
  assert.deepEqual(shownNames(), ['ab-newer.txt']);
});

test('a search that lands after Escape dismissed the dropdown does not re-open it', async () => {
  searchFiles.mockReset();
  searchFiles.mockResolvedValueOnce(searchResponse(['a.txt']));
  const late = deferredSearchResponse();
  searchFiles.mockReturnValueOnce(late.promise);
  searchFiles.mockResolvedValue(searchResponse(['new.txt']));

  const { result, type, shownNames } = renderMentions();
  type('mail me at foo@');
  await waitFor(() => assert.deepEqual(shownNames(), ['a.txt']));

  type('mail me at foo@n');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 2));
  assert.equal(result.current.showFileDropdown, true);

  act(() => {
    result.current.handleFileMentionsKeyDown(keyEvent('Escape'));
  });
  assert.equal(result.current.showFileDropdown, false);

  // Let the late search, which brings a changed list, finish completely.
  await act(async () => {
    late.resolve(['new.txt']);
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
  });

  // Still dismissed, so the next Enter reaches the composer and sends the message.
  assert.equal(result.current.showFileDropdown, false);
  let enterHandled = true;
  act(() => {
    enterHandled = result.current.handleFileMentionsKeyDown(keyEvent('Enter'));
  });
  assert.equal(enterHandled, false);
  assert.equal(searchFiles.mock.calls.length, 2);

  // Typing on inside the query re-opens the dropdown, which searches again.
  type('mail me at foo@ne');
  await waitFor(() => assert.deepEqual(shownNames(), ['new.txt']));
  assert.equal(searchFiles.mock.calls.length, 3);
});

test('Escape before any file matched stops a late search from showing the dropdown', async () => {
  searchFiles.mockReset();
  const late = deferredSearchResponse();
  searchFiles.mockReturnValueOnce(late.promise);

  const { result, type, shownNames } = renderMentions();

  // Nothing has matched yet, so no files are offered.
  type('mail foo@zz');
  await waitFor(() => assert.equal(searchFiles.mock.calls.length, 1));
  assert.deepEqual(shownNames(), []);

  act(() => {
    result.current.handleFileMentionsKeyDown(keyEvent('Escape'));
  });

  // The search then brings a matching file.
  await act(async () => {
    late.resolve(['zz-new.txt']);
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
  });

  assert.equal(result.current.showFileDropdown, false);
  assert.deepEqual(shownNames(), []);
  let enterHandled = true;
  act(() => {
    enterHandled = result.current.handleFileMentionsKeyDown(keyEvent('Enter'));
  });
  assert.equal(enterHandled, false);
});
