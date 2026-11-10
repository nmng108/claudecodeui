import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/shared/api';
import { MCP_SUPPORTED_SCOPES } from '@/shared/constants';
import type {
  McpApiResponse,
  McpProject,
  McpProvider,
  McpScope,
  ProviderMcpRawConfig,
  ProviderMcpRawConfigWriteResult,
} from '@/shared/types';
import { getApiErrorMessage, getErrorMessage, getProjectPath } from '@/modules/mcp/utils/mcpFormatting';

/** How the draft is applied: `replace` stores it as the whole file, `merge` upserts the servers it contains. */
export type McpRawConfigMode = 'replace' | 'merge';

type UseMcpRawConfigArgs = {
  provider: McpProvider;
  currentProjects: McpProject[];
  /** Called after a successful save so the server list can be re-read. */
  onSaved: () => Promise<void>;
};

/** Loads, previews and saves the raw MCP config text of one provider for the Raw config editor. */
export function useMcpRawConfig({ provider, currentProjects, onSaved }: UseMcpRawConfigArgs) {
  const supportedScopes = MCP_SUPPORTED_SCOPES[provider];
  const [scope, setScope] = useState<McpScope>(supportedScopes.includes('user') ? 'user' : supportedScopes[0]);
  const [workspacePath, setWorkspacePath] = useState('');
  // The file text as last read from the server; its hash guards the save against concurrent edits.
  const [loaded, setLoaded] = useState<ProviderMcpRawConfig | null>(null);
  // What the user is typing: the whole file in replace mode, pasted servers in merge mode.
  const [draft, setDraft] = useState('');
  const [mode, setModeState] = useState<McpRawConfigMode>('replace');
  // Mirrors `mode` so a reload sets the right draft without re-running when the mode changes.
  const modeRef = useRef<McpRawConfigMode>('replace');
  // Dry-run result shown before the user confirms a save.
  const [preview, setPreview] = useState<ProviderMcpRawConfigWriteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isBusy, setIsBusy] = useState(false);

  const projectOptions = useMemo(
    () => currentProjects
      .map((project) => ({ value: getProjectPath(project), label: project.displayName || project.projectId }))
      .filter((option) => option.value),
    [currentProjects],
  );

  const needsProject = scope !== 'user';
  const canLoad = !needsProject || Boolean(workspacePath);

  const load = useCallback(async () => {
    if (!canLoad) {
      setLoaded(null);
      setDraft('');
      return;
    }

    setIsLoading(true);
    setError(null);
    setPreview(null);
    try {
      const response = await api.providers.mcpRawConfig(provider, {
        scope,
        workspacePath: needsProject ? workspacePath : undefined,
      });
      const data = await response.json() as McpApiResponse<{ config: ProviderMcpRawConfig }>;
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to load MCP config'));
      }

      setLoaded(data.data.config);
      setDraft(modeRef.current === 'replace' ? data.data.config.content : '');
    } catch (loadError) {
      setLoaded(null);
      setError(getErrorMessage(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [canLoad, needsProject, provider, scope, workspacePath]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(async (dryRun: boolean): Promise<ProviderMcpRawConfigWriteResult> => {
    const response = await api.providers.saveMcpRawConfig(provider, {
      scope,
      workspacePath: needsProject ? workspacePath : undefined,
      content: draft,
      mode,
      expectedHash: loaded?.hash,
      dryRun,
    });
    const data = await response.json() as McpApiResponse<{ result: ProviderMcpRawConfigWriteResult }>;
    if (!response.ok || !data.success) {
      throw new Error(getApiErrorMessage(data, 'Failed to save MCP config'));
    }

    return data.data.result;
  }, [draft, loaded?.hash, mode, needsProject, provider, scope, workspacePath]);

  const previewChanges = useCallback(async () => {
    setIsBusy(true);
    setError(null);
    try {
      setPreview(await send(true));
    } catch (previewError) {
      setPreview(null);
      setError(getErrorMessage(previewError));
    } finally {
      setIsBusy(false);
    }
  }, [send]);

  const save = useCallback(async () => {
    setIsBusy(true);
    setError(null);
    try {
      const result = await send(false);
      setPreview(null);
      setLoaded(result);
      setDraft(mode === 'replace' ? result.content : '');
      await onSaved();
    } catch (saveError) {
      setError(getErrorMessage(saveError));
    } finally {
      setIsBusy(false);
    }
  }, [mode, onSaved, send]);

  const updateDraft = useCallback((value: string) => {
    setDraft(value);
    setPreview(null);
  }, []);

  const changeMode = useCallback((next: McpRawConfigMode) => {
    modeRef.current = next;
    setModeState(next);
    setPreview(null);
    setDraft(next === 'replace' ? loaded?.content ?? '' : '');
  }, [loaded?.content]);

  const changeScope = useCallback((next: McpScope) => {
    setScope(next);
    setWorkspacePath('');
    setLoaded(null);
  }, []);

  return {
    supportedScopes,
    scope,
    workspacePath,
    projectOptions,
    needsProject,
    loaded,
    draft,
    mode,
    preview,
    error,
    isLoading,
    isBusy,
    isUnchanged: mode === 'replace' && loaded !== null && draft === loaded.content,
    changeScope,
    setWorkspacePath,
    changeMode,
    updateDraft,
    reload: load,
    previewChanges,
    save,
  };
}
