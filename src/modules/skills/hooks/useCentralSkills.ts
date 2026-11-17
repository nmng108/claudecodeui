import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { CentralScopeProvider, CentralSkill, CentralSkillApplyResult, SkillsProvider } from '@/shared/types';

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

type LoadedCentralSkills = {
  /** Scope the lists were loaded for: `global`, or a project id. */
  scopeKey: string;
  skills: CentralSkill[];
  providers: CentralScopeProvider[];
};

/**
 * Loads the shared skills folder of one scope (the user's, or one project's when
 * `projectId` is given) and exposes link, unlink, re-apply, share and delete for
 * it; used by the Skills tab and the shared skills dialog.
 */
export function useCentralSkills(projectId?: string) {
  const scopeKey = projectId ?? 'global';
  // What the last successful load returned, tagged with the scope it was for. It
  // is a single state so a scope change can be told apart from "nothing loaded":
  // a list from another scope is never shown for this one.
  const [loaded, setLoaded] = useState<LoadedCentralSkills | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const response = await api.providers.centralSkills({ projectId });
      const data = await response.json() as ApiEnvelope<{ skills: CentralSkill[]; providers?: CentralScopeProvider[] }>;
      if (!response.ok || !data.success) {
        throw new Error(readError(data, 'Failed to load shared skills'));
      }

      setLoaded({ scopeKey, skills: data.data.skills, providers: data.data.providers ?? [] });
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load shared skills');
    }
  }, [projectId, scopeKey]);

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

  const current = loaded?.scopeKey === scopeKey ? loaded : null;
  // Sent only for a project, so a user-scope request is exactly what it always was.
  const scope = projectId ? { projectId } : {};

  return {
    skills: current?.skills ?? [],
    /** Which providers read this scope's shared folder themselves and which can be linked into. */
    providers: current?.providers ?? [],
    error,
    reload,
    addSkills: (payload: Record<string, unknown>) =>
      run(() => api.providers.addCentralSkills({ ...payload, ...scope }), 'Failed to add shared skill'),
    link: (directoryName: string, providers?: SkillsProvider[], mode?: 'copy') =>
      run(() => api.providers.linkCentralSkill(directoryName, { providers, mode, ...scope }), 'Failed to link skill'),
    unlink: (directoryName: string, providers?: SkillsProvider[]) =>
      run(() => api.providers.unlinkCentralSkill(directoryName, { providers, ...scope }), 'Failed to unlink skill'),
    resync: (directoryName: string, providers?: SkillsProvider[]) =>
      run(() => api.providers.resyncCentralSkill(directoryName, { providers, ...scope }), 'Failed to re-apply skill'),
    adopt: (provider: SkillsProvider, directoryName: string) =>
      run(() => api.providers.adoptCentralSkill({ provider, directoryName, ...scope }), 'Failed to share skill'),
    remove: (directoryName: string) =>
      run(() => api.providers.deleteCentralSkill(directoryName, scope), 'Failed to delete shared skill'),
  };
}

/** The shared skills hook's return value, passed from the Skills tab to the shared skills dialog so both use one loaded list. */
export type CentralSkillsState = ReturnType<typeof useCentralSkills>;
