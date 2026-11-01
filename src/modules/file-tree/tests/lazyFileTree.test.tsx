import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import { buildSearchTree } from '@/modules/file-tree/utils/fileTreeUtils';
import { directoryRevealProgress } from '@/modules/file-tree/utils/revealDirectory';
import type { FileTreeSearchHit, Project } from '@/shared/types';

/**
 * The tree no longer loads a whole project: the root arrives first and a
 * folder's children arrive when it is opened, so a workspace with hundreds of
 * thousands of files costs only the folders the user actually visits. Search
 * runs on the server for the same reason.
 */

const ROOT = '/work/space';

type Entry = { type: 'file' | 'directory'; name: string; path: string };
const dir = (parent: string, name: string): Entry => ({ type: 'directory', name, path: `${parent}/${name}` });
const file = (parent: string, name: string): Entry => ({ type: 'file', name, path: `${parent}/${name}` });

let listings: Record<string, Entry[]> = {};
const listFiles = vi.fn(async (_projectId: string, directoryPath?: string | null) => {
  const key = directoryPath ?? ROOT;
  if (!(key in listings)) {
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'Directory not found' }) };
  }
  return { ok: true, json: async () => ({ path: key, entries: listings[key], truncated: false }) };
});
const searchFiles = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    listFiles: (...args: [string, (string | null)?]) => listFiles(...args),
    searchFiles: (...args: unknown[]) => searchFiles(...args),
  },
}));

const { useFileTreeData } = await import('@/modules/file-tree/hooks/useFileTreeData');
const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'space', fullPath: ROOT, path: ROOT };
const requestedPaths = () => listFiles.mock.calls.map((call) => call[1] ?? null);

beforeEach(() => {
  listFiles.mockClear();
  searchFiles.mockReset();
  listings = {
    [ROOT]: [dir(ROOT, 'repo-a'), dir(ROOT, 'repo-b'), file(ROOT, 'README.md')],
    [`${ROOT}/repo-a`]: [dir(`${ROOT}/repo-a`, 'src'), file(`${ROOT}/repo-a`, 'package.json')],
    [`${ROOT}/repo-a/src`]: [file(`${ROOT}/repo-a/src`, 'index.ts')],
    [`${ROOT}/repo-b`]: [file(`${ROOT}/repo-b`, 'main.py')],
  };
});

test('only the root is listed until a folder is opened, and each folder is fetched once', async () => {
  const { result } = renderHook(() => useFileTreeData(project));
  await waitFor(() => assert.equal(result.current.files.length, 3));

  assert.deepEqual(requestedPaths(), [null]);
  assert.equal(result.current.files[0]?.children, undefined);

  act(() => {
    result.current.loadDirectory(`${ROOT}/repo-a`);
    result.current.loadDirectory(`${ROOT}/repo-a`);
  });
  await waitFor(() => assert.equal(result.current.files[0]?.children?.length, 2));

  assert.deepEqual(requestedPaths(), [null, `${ROOT}/repo-a`]);
  // The sibling folder was never touched.
  assert.equal(result.current.files[1]?.children, undefined);
});

test('a refresh reloads the root and every folder that was opened, keeping them open', async () => {
  const { result } = renderHook(() => useFileTreeData(project));
  await waitFor(() => assert.equal(result.current.files.length, 3));
  act(() => result.current.loadDirectory(`${ROOT}/repo-a`));
  await waitFor(() => assert.equal(result.current.files[0]?.children?.length, 2));

  listings[`${ROOT}/repo-a`] = [...listings[`${ROOT}/repo-a`], file(`${ROOT}/repo-a`, 'new.txt')];
  listFiles.mockClear();
  act(() => result.current.refreshFiles());

  await waitFor(() => assert.equal(result.current.files[0]?.children?.length, 3));
  assert.deepEqual([...requestedPaths()].sort(), [null, `${ROOT}/repo-a`].sort());
});

test('a folder that cannot be read shows as empty without breaking the rest of the tree', async () => {
  delete listings[`${ROOT}/repo-b`];
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result } = renderHook(() => useFileTreeData(project));
  await waitFor(() => assert.equal(result.current.files.length, 3));

  act(() => result.current.loadDirectory(`${ROOT}/repo-b`));
  await waitFor(() => assert.deepEqual(result.current.files[1]?.children, []));
  assert.equal(result.current.error, null);
  errorSpy.mockRestore();
});

test('a root that cannot be listed reports the server message', async () => {
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  delete listings[ROOT];
  const { result } = renderHook(() => useFileTreeData(project));

  await waitFor(() => assert.equal(result.current.error, 'Directory not found'));
  errorSpy.mockRestore();
});

test('clicking a folder in the tree fetches and shows its children', async () => {
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('repo-a')));
  assert.equal(screen.queryByText('package.json'), null);

  fireEvent.click(screen.getByText('repo-a'));

  await waitFor(() => assert.ok(screen.getByText('package.json')));
  assert.deepEqual(requestedPaths(), [null, `${ROOT}/repo-a`]);
});

test('typing in the search box searches the server and shows the matches with their folders open', async () => {
  searchFiles.mockResolvedValue({
    ok: true,
    json: async () => ({
      results: [
        {
          type: 'file',
          name: 'index.ts',
          path: `${ROOT}/repo-a/src/index.ts`,
          relativePath: 'repo-a/src/index.ts',
        },
      ],
      truncated: false,
    }),
  });
  render(<FileTree selectedProject={project} />);
  await waitFor(() => assert.ok(screen.getByText('repo-a')));

  fireEvent.change(screen.getAllByRole('textbox')[0], { target: { value: 'index' } });

  await waitFor(() => assert.ok(screen.getByText('index.ts')));
  assert.equal(searchFiles.mock.calls.length, 1);
  assert.equal(searchFiles.mock.calls[0][0], 'p1');
  assert.equal(searchFiles.mock.calls[0][1].query, 'index');
  // The ancestors of the hit are shown; unrelated folders and files are not.
  assert.ok(screen.getByText('src'));
  assert.equal(screen.queryByText('repo-b'), null);
  assert.equal(screen.queryByText('README.md'), null);
});

const hit = (relativePath: string, type: 'file' | 'directory' = 'file', root = ROOT): FileTreeSearchHit => ({
  type,
  name: relativePath.split('/').pop() as string,
  path: `${root}/${relativePath}`,
  relativePath,
});

test('buildSearchTree nests hits under synthesized folders, folders first', () => {
  const tree = buildSearchTree([
    hit('b.md'),
    hit('docs/guide/start.md'),
    hit('docs/api.md'),
  ]);

  assert.deepEqual(tree.map((node) => node.name), ['docs', 'b.md']);
  const docs = tree[0];
  assert.equal(docs.type, 'directory');
  assert.equal(docs.path, `${ROOT}/docs`);
  assert.deepEqual(docs.children?.map((node) => node.name), ['guide', 'api.md']);
  assert.equal(docs.children?.[0].path, `${ROOT}/docs/guide`);
  assert.equal(docs.children?.[0].children?.[0].path, `${ROOT}/docs/guide/start.md`);
});

test('buildSearchTree lets a matching folder keep its own details and its hit children', () => {
  const tree = buildSearchTree([hit('docs/api.md'), { ...hit('docs', 'directory'), size: 7 }]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0].size, 7);
  assert.deepEqual(tree[0].children?.map((node) => node.name), ['api.md']);
});

test('buildSearchTree rebuilds Windows paths with the separator the server used', () => {
  const root = 'C:\\work\\space';
  const tree = buildSearchTree([
    { type: 'file', name: 'a.ts', path: `${root}\\src\\a.ts`, relativePath: 'src/a.ts' },
  ]);

  assert.equal(tree[0].path, `${root}\\src`);
  assert.equal(tree[0].children?.[0].path, `${root}\\src\\a.ts`);
});

test('directoryRevealProgress waits for a folder that has not loaded and settles once it has', () => {
  const unloaded = [{ type: 'directory' as const, name: 'a', path: `${ROOT}/a` }];

  const pending = directoryRevealProgress(unloaded, ROOT, 'a/b/');
  assert.deepEqual(pending, { paths: [`${ROOT}/a`], settled: false });

  const loadedWithoutB = [{ ...unloaded[0], children: [] }];
  assert.deepEqual(directoryRevealProgress(loadedWithoutB, ROOT, 'a/b/'), {
    paths: [`${ROOT}/a`],
    settled: true,
  });

  const loadedWithB = [{
    ...unloaded[0],
    children: [{ type: 'directory' as const, name: 'b', path: `${ROOT}/a/b` }],
  }];
  assert.deepEqual(directoryRevealProgress(loadedWithB, ROOT, 'a/b/'), {
    paths: [`${ROOT}/a`, `${ROOT}/a/b`],
    settled: true,
  });
});
