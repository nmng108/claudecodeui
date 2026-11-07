import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { getActiveGitRepository, setActiveGitRepository } from '@/shared/gitRepositorySelection';
import type { GitRepositoriesResponse, GitRepositoryEntry } from '@/shared/types';

type GitRepositories = {
  repositories: GitRepositoryEntry[];
  /** True when discovery stopped at its result or time limit. */
  truncated: boolean;
  /** False until the first discovery for the project has finished (or failed). */
  isResolved: boolean;
  isLoading: boolean;
  refresh: () => void;
};

/**
 * Picks the repository to show when the remembered one is gone or none was
 * chosen yet: the project folder itself when it is a repository, otherwise the
 * first repository found.
 */
export function pickDefaultRepository(repositories: GitRepositoryEntry[]): string {
  return repositories.find((entry) => entry.isProjectRoot)?.path ?? repositories[0]?.path ?? '';
}

/** True when `repo` names one of the discovered repositories. */
export function isKnownRepository(repositories: GitRepositoryEntry[], repo: string): boolean {
  return repositories.some((entry) => entry.path === repo);
}

/**
 * Discovers the repositories inside a project folder and keeps the active one
 * valid: a remembered repository that no longer exists is replaced by the
 * default.
 */
export function useGitRepositories(projectId: string | null): GitRepositories {
  const [repositories, setRepositories] = useState<GitRepositoryEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [isResolved, setIsResolved] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const loadedProjectRef = useRef<string | null>(null);

  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!projectId) {
      loadedProjectRef.current = null;
      setRepositories([]);
      setTruncated(false);
      setIsResolved(false);
      setIsLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    // A different project starts unresolved; a manual refresh keeps showing the current list.
    if (loadedProjectRef.current !== projectId) {
      loadedProjectRef.current = projectId;
      setRepositories([]);
      setTruncated(false);
      setIsResolved(false);
    }
    setIsLoading(true);

    void (async () => {
      let found: GitRepositoryEntry[] = [];
      let wasTruncated = false;
      try {
        const response = await api.git.repositories(projectId, { signal: controller.signal });
        const data = (await response.json()) as GitRepositoriesResponse;
        if (controller.signal.aborted) {
          return;
        }
        if (!data.error && Array.isArray(data.repositories)) {
          found = data.repositories;
          wasTruncated = Boolean(data.truncated);
        }
      } catch (error) {
        if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          return;
        }
        console.error('Error listing git repositories:', error);
      }

      // Discovery failing must not hide the panel: with no list the project
      // folder is used, which is what the tab did before it knew about several.
      if (found.length > 0) {
        const active = getActiveGitRepository(projectId);
        if (!isKnownRepository(found, active)) {
          setActiveGitRepository(projectId, pickDefaultRepository(found));
        }
      }

      setRepositories(found);
      setTruncated(wasTruncated);
      setIsResolved(true);
      setIsLoading(false);
    })();

    return () => controller.abort();
  }, [projectId, reloadToken]);

  return { repositories, truncated, isResolved, isLoading, refresh };
}
