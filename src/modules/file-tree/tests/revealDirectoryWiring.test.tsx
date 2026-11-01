import assert from 'node:assert/strict';

import { render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard for the wiring, not the maths: a directory reference clicked
 * in the chat reaches the tree as the model wrote it, relative to the project
 * root, while every node here is keyed by its absolute path. Rendering the
 * real tree is what proves the two ends still meet, now that each folder's
 * children are fetched only when the folder opens.
 */

const ROOT = '/home/odoo/workspace/personal';

const listings: Record<string, Array<{ type: string; name: string; path: string }>> = {
  [ROOT]: [
    { type: 'directory', name: 'decisions', path: `${ROOT}/decisions` },
    { type: 'directory', name: 'notes', path: `${ROOT}/notes` },
  ],
  [`${ROOT}/decisions`]: [
    { type: 'directory', name: 'archive', path: `${ROOT}/decisions/archive` },
    { type: 'file', name: '0001-first.md', path: `${ROOT}/decisions/0001-first.md` },
  ],
  [`${ROOT}/decisions/archive`]: [
    { type: 'file', name: 'old.md', path: `${ROOT}/decisions/archive/old.md` },
  ],
};

const listFiles = vi.fn(async (_projectId: string, directoryPath?: string | null) => {
  const key = directoryPath ?? ROOT;
  return {
    ok: true,
    json: async () => ({ path: key, entries: listings[key] ?? [], truncated: false }),
  };
});

vi.mock('@/shared/api', () => ({
  api: {
    listFiles: (...args: [string, (string | null)?]) => listFiles(...args),
    searchFiles: async () => ({ ok: true, json: async () => ({ results: [], truncated: false }) }),
  },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'personal', fullPath: ROOT, path: ROOT };

test('a relative directory reference expands that folder in the tree', async () => {
  render(<FileTree selectedProject={project} revealDirectory={{ path: 'decisions/' }} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  // Visible only because the folder was expanded and its children fetched for us.
  await waitFor(() => assert.ok(screen.getByText('0001-first.md')));
});

test('a reference to a nested folder opens every level on the way down', async () => {
  render(<FileTree selectedProject={project} revealDirectory={{ path: 'decisions/archive/' }} />);

  await waitFor(() => assert.ok(screen.getByText('old.md')));
  assert.ok(screen.getByText('0001-first.md'));
});

test('a folder nobody asked for stays closed and is never fetched', async () => {
  listFiles.mockClear();
  render(<FileTree selectedProject={project} revealDirectory={null} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  assert.equal(screen.queryByText('0001-first.md'), null);
  // Only the root was listed.
  assert.deepEqual(listFiles.mock.calls.map((call) => call[1] ?? null), [null]);
});
