import { useSyncExternalStore } from 'react';

/**
 * Which repository of a project the Source Control tab is working on.
 *
 * A project folder can hold several repositories. The choice is kept per
 * project, outside React state, so every caller of `api.git` / `api.worktrees`
 * (the Source Control tab, the command palette, the compare view) targets the
 * same repository without threading a parameter through each of them.
 *
 * The value is a path relative to the project folder; the empty string means
 * the project folder itself.
 */

const STORAGE_PREFIX = 'git-active-repository:';

const listeners = new Set<() => void>();
const selections = new Map<string, string>();

function readStored(projectId: string): string {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${projectId}`) ?? '';
  } catch {
    return '';
  }
}

export function getActiveGitRepository(projectId: string | null | undefined): string {
  if (!projectId) {
    return '';
  }
  const cached = selections.get(projectId);
  if (cached !== undefined) {
    return cached;
  }
  const stored = readStored(projectId);
  selections.set(projectId, stored);
  return stored;
}

export function setActiveGitRepository(projectId: string, repo: string): void {
  if (getActiveGitRepository(projectId) === repo) {
    return;
  }
  selections.set(projectId, repo);
  try {
    if (repo) {
      localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, repo);
    } else {
      localStorage.removeItem(`${STORAGE_PREFIX}${projectId}`);
    }
  } catch {
    // The selection still holds for this session when storage is unavailable.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribes a component to the active repository of a project. */
export function useActiveGitRepository(projectId: string | null | undefined): string {
  return useSyncExternalStore(
    subscribe,
    () => getActiveGitRepository(projectId),
    () => '',
  );
}

/** Forgets cached selections. Test helper. */
export function resetGitRepositorySelectionForTests(): void {
  selections.clear();
  listeners.clear();
}
