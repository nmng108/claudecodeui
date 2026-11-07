import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isKnownRepository,
  pickDefaultRepository,
  useGitRepositories,
} from '@/modules/git-panel/hooks/useGitRepositories';
import {
  getActiveGitRepository,
  resetGitRepositorySelectionForTests,
  setActiveGitRepository,
} from '@/shared/gitRepositorySelection';
import type { GitRepositoriesResponse, GitRepositoryEntry } from '@/shared/types';

let response: GitRepositoriesResponse | Error;

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      git: {
        repositories: async () => {
          if (response instanceof Error) throw response;
          return new Response(JSON.stringify(response));
        },
      },
    },
  };
});

const entry = (path: string, isProjectRoot = false): GitRepositoryEntry => ({
  path,
  name: path || 'root',
  isProjectRoot,
  branch: 'main',
});

describe('repository defaults', () => {
  it('prefers the project folder, then the first repository, then nothing', () => {
    expect(pickDefaultRepository([entry('a'), entry('', true)])).toBe('');
    expect(pickDefaultRepository([entry('a'), entry('b')])).toBe('a');
    expect(pickDefaultRepository([])).toBe('');
  });

  it('recognises discovered repositories only', () => {
    expect(isKnownRepository([entry('a')], 'a')).toBe(true);
    expect(isKnownRepository([entry('a')], 'b')).toBe(false);
  });
});

describe('useGitRepositories', () => {
  beforeEach(() => {
    localStorage.clear();
    resetGitRepositorySelectionForTests();
  });

  it('selects the first repository when the project folder is not one', async () => {
    response = { repositories: [entry('api'), entry('web')] };
    const { result } = renderHook(() => useGitRepositories('p1'));

    expect(result.current.isResolved).toBe(false);
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(getActiveGitRepository('p1')).toBe('api');
    expect(result.current.repositories).toHaveLength(2);
  });

  it('keeps a remembered repository that still exists', async () => {
    setActiveGitRepository('p1', 'web');
    response = { repositories: [entry('api'), entry('web')] };
    const { result } = renderHook(() => useGitRepositories('p1'));

    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(getActiveGitRepository('p1')).toBe('web');
  });

  it('replaces a remembered repository that no longer exists', async () => {
    setActiveGitRepository('p1', 'deleted');
    response = { repositories: [entry('api')] };
    const { result } = renderHook(() => useGitRepositories('p1'));

    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(getActiveGitRepository('p1')).toBe('api');
  });

  it('falls back to the project folder when discovery fails', async () => {
    response = new Error('network down');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = renderHook(() => useGitRepositories('p1'));

    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.repositories).toEqual([]);
    expect(getActiveGitRepository('p1')).toBe('');
  });
});