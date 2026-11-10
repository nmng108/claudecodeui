import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { CentralSkill, CentralSkillApplyResult, SkillsProvider } from '@/shared/types';

type ApiEnvelope<T> =
  | { success: true; data: T }
  | { success: false; error?: { message?: string } | string };

const readError = (payload: ApiEnvelope<unknown>, fallback: string): string => {
  if (payload.success) {
    return fallback;
  }

  const error = payload.error;
  return (typeof error === 'string' ? error : error?.message) || fallback;
};

/** Joins the per-provider problems of an operation into one message, or null when nothing went wrong. */
export function describeCentralSkillProblems(results: CentralSkillApplyResult[]): string | null {
  const problems = results
    .filter((result) => result.outcome === 'conflict' || result.outcome === 'failed')
    .map((result) => `${result.provider}: ${result.error || result.outcome}`);
  return problems.length > 0 ? problems.join('; ') : null;
}

/** Loads the shared skills folder and exposes link, unlink, re-apply, share and delete; used by the Skills tab and the shared skills dialog. */
export function useCentralSkills() {
  const [skills, setSkills] = useState<CentralSkill[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const response = await api.providers.centralSkills();
      const data = await response.json() as ApiEnvelope<{ skills: CentralSkill[] }>;
      if (!response.ok || !data.success) {
        throw new Error(readError(data, 'Failed to load shared skills'));
      }

      setSkills(data.data.skills);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load shared skills');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Runs one API call, refreshes the list either way, and returns the per-provider results.
  const run = useCallback(async (
    call: () => Promise<Response>,
    fallback: string,
  ): Promise<CentralSkillApplyResult[]> => {
    try {
      const response = await call();
      const data = await response.json() as ApiEnvelope<{ results?: CentralSkillApplyResult[] }>;
      if (!response.ok || !data.success) {
        throw new Error(readError(data, fallback));
      }

      return data.data.results ?? [];
    } finally {
      await reload();
    }
  }, [reload]);

  return {
    skills,
    error,
    reload,
    addSkills: (payload: unknown) => run(() => api.providers.addCentralSkills(payload), 'Failed to add shared skill'),
    link: (directoryName: string, providers?: SkillsProvider[], mode?: 'copy') =>
      run(() => api.providers.linkCentralSkill(directoryName, { providers, mode }), 'Failed to link skill'),
    unlink: (directoryName: string, providers?: SkillsProvider[]) =>
      run(() => api.providers.unlinkCentralSkill(directoryName, { providers }), 'Failed to unlink skill'),
    resync: (directoryName: string, providers?: SkillsProvider[]) =>
      run(() => api.providers.resyncCentralSkill(directoryName, { providers }), 'Failed to re-apply skill'),
    adopt: (provider: SkillsProvider, directoryName: string) =>
      run(() => api.providers.adoptCentralSkill({ provider, directoryName }), 'Failed to share skill'),
    remove: (directoryName: string) =>
      run(() => api.providers.deleteCentralSkill(directoryName), 'Failed to delete shared skill'),
  };
}

/** The shared skills hook's return value, passed from the Skills tab to the shared skills dialog so both use one loaded list. */
export type CentralSkillsState = ReturnType<typeof useCentralSkills>;
