import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type { CentralMcpApplyResult, CentralMcpServer, McpApiResponse, McpProvider } from '@/shared/types';
import { getApiErrorMessage, getErrorMessage } from '@/modules/mcp/utils/mcpFormatting';

type OperationData = { server?: CentralMcpServer; results?: CentralMcpApplyResult[] };

/** Joins the per-provider problems of an operation into one message, or null when everything succeeded. */
export function describeCentralFailures(results: CentralMcpApplyResult[]): string | null {
  const problems = results
    .filter((result) => result.outcome === 'conflict' || result.outcome === 'failed')
    .map((result) => `${result.provider}: ${result.error || result.outcome}`);
  return problems.length > 0 ? problems.join('; ') : null;
}

/** Loads the shared MCP servers and exposes the operations on them; used by the MCP settings list and the shared servers dialog. */
export function useCentralMcpServers() {
  const [servers, setServers] = useState<CentralMcpServer[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const response = await api.providers.centralMcpServers();
      const data = await response.json() as McpApiResponse<{ servers: CentralMcpServer[] }>;
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, 'Failed to load shared MCP servers'));
      }

      setServers(data.data.servers);
      setError(null);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Runs one API call, refreshes the list either way, and reports provider-level problems.
  const run = useCallback(async (call: () => Promise<Response>, fallback: string): Promise<CentralMcpApplyResult[]> => {
    try {
      const response = await call();
      const data = await response.json() as McpApiResponse<OperationData>;
      if (!response.ok || !data.success) {
        throw new Error(getApiErrorMessage(data, fallback));
      }

      return data.data.results ?? [];
    } finally {
      await reload();
    }
  }, [reload]);

  return {
    servers,
    error,
    reload,
    create: (payload: unknown) => run(() => api.providers.createCentralMcpServer(payload), 'Failed to create shared MCP server'),
    update: (id: number, payload: unknown) => run(() => api.providers.updateCentralMcpServer(id, payload), 'Failed to update shared MCP server'),
    setEnabled: (id: number, enabled: boolean, providers?: McpProvider[]) =>
      run(() => api.providers.setCentralMcpServerEnabled(id, { enabled, providers }), 'Failed to switch shared MCP server'),
    resync: (id: number, provider?: McpProvider) =>
      run(() => api.providers.resyncCentralMcpServer(id, { provider }), 'Failed to re-apply shared MCP server'),
    adopt: (id: number, provider: McpProvider) =>
      run(() => api.providers.adoptCentralMcpServer(id, { provider }), 'Failed to use provider values'),
    importEntry: (payload: { provider: McpProvider; name: string; scope: string; workspacePath?: string }) =>
      run(() => api.providers.importCentralMcpServer(payload), 'Failed to share MCP server'),
    remove: (id: number) => run(() => api.providers.deleteCentralMcpServer(id), 'Failed to delete shared MCP server'),
  };
}

/** The shared MCP servers hook's return value, passed from the MCP list to the shared servers dialog so both use one loaded list. */
export type CentralMcpServersState = ReturnType<typeof useCentralMcpServers>;
