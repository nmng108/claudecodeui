import { useCallback, useState } from 'react';

import { api } from '@/shared/api';
import type { McpApiResponse, McpConnectionCheckResult, McpConnectionCheckState, McpProvider, ProviderMcpServer } from '@/shared/types';
import { getApiErrorMessage, getErrorMessage } from '@/modules/mcp/utils/mcpFormatting';

/** Used by the MCP server list to find a row's check state; includes the provider so results stay with their own tab. */
export const getConnectionCheckKey = (server: ProviderMcpServer): string => (
  `${server.provider}:${server.scope}:${server.workspacePath || 'global'}:${server.name}`
);

/**
 * Holds the on-demand "check connection" results of one provider's MCP list.
 * Used by the MCP server list. Nothing is checked automatically: a check
 * starts the server's command (stdio) or contacts its URL, so it only runs
 * when the user asks for it.
 */
export function useMcpConnectionChecks(selectedProvider: McpProvider) {
  // Results and in-flight flags per server row; kept in state so the badges re-render as checks finish.
  const [checks, setChecks] = useState<Record<string, McpConnectionCheckState>>({});

  const checkServer = useCallback(async (server: ProviderMcpServer) => {
    const key = getConnectionCheckKey(server);
    setChecks((current) => ({ ...current, [key]: { isChecking: true } }));

    let next: McpConnectionCheckState;
    try {
      const response = await api.providers.checkMcpServerConnection(selectedProvider, server.name, {
        scope: server.scope,
        workspacePath: server.workspacePath,
      });
      const data = await response.json() as McpApiResponse<{ result: McpConnectionCheckResult }>;
      next = !response.ok || !data.success
        ? { isChecking: false, error: getApiErrorMessage(data, 'Failed to check MCP server') }
        : { isChecking: false, result: data.data.result };
    } catch (error) {
      next = { isChecking: false, error: getErrorMessage(error) };
    }

    setChecks((current) => ({ ...current, [key]: next }));
  }, [selectedProvider]);

  return { checks, checkServer };
}
