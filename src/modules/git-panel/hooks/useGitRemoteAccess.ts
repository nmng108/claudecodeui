import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { GitRemoteAccess } from '@/shared/types';

const AUTO_CHECK_STORAGE_KEY = 'git-remote-access-auto-check';

function readAutoCheck(): boolean {
  try {
    return localStorage.getItem(AUTO_CHECK_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

type UseGitRemoteAccessOptions = {
  projectId: string | null;
  /** Active repository (relative path); a change runs a new check. */
  repo: string;
  /** Branch name; switching it can change the upstream, so it runs a new check. */
  branch: string;
  /** False while the repository is still loading, missing, or has no remote. */
  enabled: boolean;
};

type GitRemoteAccessController = {
  access: GitRemoteAccess | null;
  isChecking: boolean;
  /** Whether the check runs by itself when a repository is shown. */
  autoCheck: boolean;
  setAutoCheck: (value: boolean) => void;
  /** Runs the check; `force` skips the server's one-minute cache. */
  check: (force?: boolean) => Promise<void>;
};

/**
 * Checks, without changing anything, whether the credentials git would use can
 * read from and push to the active repository's remote.
 */
export function useGitRemoteAccess({
  projectId,
  repo,
  branch,
  enabled,
}: UseGitRemoteAccessOptions): GitRemoteAccessController {
  const [access, setAccess] = useState<GitRemoteAccess | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [autoCheck, setAutoCheckState] = useState(readAutoCheck);
  const latestRequestRef = useRef(0);

  const setAutoCheck = useCallback((value: boolean) => {
    setAutoCheckState(value);
    try {
      localStorage.setItem(AUTO_CHECK_STORAGE_KEY, value ? '1' : '0');
    } catch {
      // The choice still applies for this session.
    }
  }, []);

  const check = useCallback(
    async (force = false) => {
      if (!projectId) {
        return;
      }
      const requestId = latestRequestRef.current + 1;
      latestRequestRef.current = requestId;
      setIsChecking(true);
      try {
        const response = await api.git.remoteAccess(projectId, { force });
        const data = (await response.json()) as GitRemoteAccess;
        if (latestRequestRef.current !== requestId) {
          return;
        }
        setAccess(data.error ? { state: 'error', message: data.details ?? data.error } : data);
      } catch (error) {
        if (latestRequestRef.current !== requestId) {
          return;
        }
        setAccess({ state: 'error', message: error instanceof Error ? error.message : String(error) });
      } finally {
        if (latestRequestRef.current === requestId) {
          setIsChecking(false);
        }
      }
    },
    [projectId],
  );

  useEffect(() => {
    // Any scope change invalidates the previous answer and any request in flight.
    latestRequestRef.current += 1;
    setAccess(null);
    setIsChecking(false);

    if (enabled && autoCheck) {
      void check(false);
    }
  }, [autoCheck, branch, check, enabled, projectId, repo]);

  return { access, isChecking, autoCheck, setAutoCheck, check };
}
