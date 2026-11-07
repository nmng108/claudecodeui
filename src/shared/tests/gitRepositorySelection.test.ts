import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/shared/api';
import {
  getActiveGitRepository,
  resetGitRepositorySelectionForTests,
  setActiveGitRepository,
} from '@/shared/gitRepositorySelection';

// The Source Control tab, the command palette and the compare view all call
// `api.git.*`; the selected repository is added there, not in each caller.

describe('active git repository', () => {
  beforeEach(() => {
    localStorage.clear();
    resetGitRepositorySelectionForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to the project folder and remembers a choice per project', () => {
    expect(getActiveGitRepository('p1')).toBe('');
    setActiveGitRepository('p1', 'services/api');
    setActiveGitRepository('p2', 'web');
    expect(getActiveGitRepository('p1')).toBe('services/api');
    expect(getActiveGitRepository('p2')).toBe('web');
  });

  it('survives a reload through localStorage and clears when set back to the project folder', () => {
    setActiveGitRepository('p1', 'services/api');
    resetGitRepositorySelectionForTests();
    expect(getActiveGitRepository('p1')).toBe('services/api');

    setActiveGitRepository('p1', '');
    resetGitRepositorySelectionForTests();
    expect(getActiveGitRepository('p1')).toBe('');
    expect(localStorage.getItem('git-active-repository:p1')).toBeNull();
  });

  it('adds the repository to git requests, as a query parameter or a body field', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    setActiveGitRepository('p1', 'services/api');
    await api.git.status('p1');
    await api.git.stage('p1', ['a.ts']);
    await api.worktrees.list('p1');

    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    expect(calls[0][0]).toContain('/api/git/status?project=p1&repo=services%2Fapi');
    expect(JSON.parse(String(calls[1][1]?.body))).toMatchObject({ project: 'p1', repo: 'services/api', files: ['a.ts'] });
    expect(calls[2][0]).toContain('repo=services%2Fapi');
  });

  it('leaves requests unscoped for the project folder and for repository discovery', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await api.git.status('p1');
    setActiveGitRepository('p1', 'services/api');
    await api.git.repositories('p1');

    const calls = fetchMock.mock.calls as unknown as Array<[string]>;
    expect(calls[0][0]).not.toContain('repo=');
    expect(calls[1][0]).toContain('/api/git/repositories?project=p1');
    expect(calls[1][0]).not.toContain('repo=');
  });
});