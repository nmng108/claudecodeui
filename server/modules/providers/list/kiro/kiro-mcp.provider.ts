import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';

/**
 * Stub MCP adapter. `docs/kiro/design.md` assigns Kiro's real config paths
 * (`~/.kiro/settings/mcp.json`, `<workspace>/.kiro/settings/mcp.json`) to a
 * later task; no scopes or transports are declared supported until then, so
 * every route backed by this adapter reports empty results rather than
 * reading or writing any file.
 */
export class KiroMcpProvider extends McpProvider {
  constructor() {
    super('kiro', [], []);
  }

  protected async readScopedServers(_scope: McpScope, _workspacePath: string): Promise<Record<string, unknown>> {
    return {};
  }

  protected async writeScopedServers(
    _scope: McpScope,
    _workspacePath: string,
    _servers: Record<string, unknown>,
  ): Promise<void> {
    // Not implemented yet; writes are rejected by the base class's scope check
    // before this would ever run (no scopes are declared supported).
  }

  protected buildServerConfig(_input: UpsertProviderMcpServerInput): Record<string, unknown> {
    return {};
  }

  protected normalizeServerConfig(
    _scope: McpScope,
    _name: string,
    _rawConfig: unknown,
  ): ProviderMcpServer | null {
    return null;
  }
}
