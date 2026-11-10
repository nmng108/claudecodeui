import path from 'node:path';

import type { IProviderMcp } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  McpScope,
  McpTransport,
  ProviderMcpServer,
  SetProviderMcpServerEnabledInput,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import { AppError, readObjectRecord } from '@/shared/utils.js';

const resolveWorkspacePath = (workspacePath?: string): string =>
  path.resolve(workspacePath ?? process.cwd());

const normalizeServerName = (name: string): string => {
  const normalized = name.trim();
  if (!normalized) {
    throw new AppError('MCP server name is required.', {
      code: 'MCP_SERVER_NAME_REQUIRED',
      statusCode: 400,
    });
  }

  return normalized;
};

/**
 * Shared MCP provider for provider-specific config readers/writers.
 */
export abstract class McpProvider implements IProviderMcp {
  protected readonly provider: LLMProvider;
  protected readonly supportedScopes: McpScope[];
  protected readonly supportedTransports: McpTransport[];

  /**
   * Config keys `buildServerConfig` owns for this provider, across all transports.
   * On update these are replaced from the form input; every other key already on
   * the server (for example Kiro's `autoApprove`) is kept as is.
   */
  protected abstract readonly managedConfigKeys: readonly string[];

  /** True when the provider's config has a native per-server on/off field. */
  protected readonly supportsEnableToggle: boolean = false;

  protected constructor(
    provider: LLMProvider,
    supportedScopes: McpScope[],
    supportedTransports: McpTransport[],
  ) {
    this.provider = provider;
    this.supportedScopes = supportedScopes;
    this.supportedTransports = supportedTransports;
  }

  async listServers(options?: { workspacePath?: string }): Promise<Record<McpScope, ProviderMcpServer[]>> {
    const grouped: Record<McpScope, ProviderMcpServer[]> = {
      user: [],
      local: [],
      project: [],
    };

    for (const scope of this.supportedScopes) {
      grouped[scope] = await this.listServersForScope(scope, options);
    }

    return grouped;
  }

  async listServersForScope(
    scope: McpScope,
    options?: { workspacePath?: string },
  ): Promise<ProviderMcpServer[]> {
    if (!this.supportedScopes.includes(scope)) {
      return [];
    }

    const workspacePath = resolveWorkspacePath(options?.workspacePath);
    const scopedServers = await this.readScopedServers(scope, workspacePath);
    return Object.entries(scopedServers)
      .map(([name, rawConfig]) => this.normalizeServerConfig(scope, name, rawConfig))
      .filter((entry): entry is ProviderMcpServer => entry !== null);
  }

  async upsertServer(input: UpsertProviderMcpServerInput): Promise<ProviderMcpServer> {
    const scope = input.scope ?? 'project';
    this.assertScopeAndTransport(scope, input.transport);

    const workspacePath = resolveWorkspacePath(input.workspacePath);
    const normalizedName = normalizeServerName(input.name);
    const scopedServers = await this.readScopedServers(scope, workspacePath);
    const mergedConfig = this.mergeServerConfig(
      readObjectRecord(scopedServers[normalizedName]),
      this.buildServerConfig(input),
    );
    if (input.enabled !== undefined && this.supportsEnableToggle) {
      this.writeEnabled(mergedConfig, input.enabled);
    }
    scopedServers[normalizedName] = mergedConfig;
    await this.writeScopedServers(scope, workspacePath, scopedServers);

    return {
      provider: this.provider,
      name: normalizedName,
      scope,
      transport: input.transport,
      command: input.command,
      args: input.args,
      env: input.env,
      cwd: input.cwd,
      url: input.url,
      headers: input.headers,
      envVars: input.envVars,
      bearerTokenEnvVar: input.bearerTokenEnvVar,
      envHttpHeaders: input.envHttpHeaders,
      enabled: this.supportsEnableToggle ? this.readEnabled(mergedConfig) : undefined,
    };
  }

  async setServerEnabled(input: SetProviderMcpServerEnabledInput): Promise<ProviderMcpServer> {
    const scope = input.scope ?? 'project';
    this.assertScope(scope);
    if (!this.supportsEnableToggle) {
      throw new AppError(`Provider "${this.provider}" cannot enable or disable MCP servers in its config.`, {
        code: 'MCP_TOGGLE_NOT_SUPPORTED',
        statusCode: 400,
      });
    }

    const workspacePath = resolveWorkspacePath(input.workspacePath);
    const normalizedName = normalizeServerName(input.name);
    const scopedServers = await this.readScopedServers(scope, workspacePath);
    const existing = readObjectRecord(scopedServers[normalizedName]);
    if (!existing) {
      throw new AppError(`MCP server "${normalizedName}" was not found in ${scope} scope.`, {
        code: 'MCP_SERVER_NOT_FOUND',
        statusCode: 404,
      });
    }

    const updated = { ...existing };
    this.writeEnabled(updated, input.enabled);
    scopedServers[normalizedName] = updated;
    await this.writeScopedServers(scope, workspacePath, scopedServers);

    const normalized = this.normalizeServerConfig(scope, normalizedName, updated);
    if (!normalized) {
      throw new AppError(`MCP server "${normalizedName}" has an unrecognised definition.`, {
        code: 'MCP_SERVER_INVALID',
        statusCode: 422,
      });
    }

    return normalized;
  }

  async removeServer(
    input: { name: string; scope?: McpScope; workspacePath?: string },
  ): Promise<{ removed: boolean; provider: LLMProvider; name: string; scope: McpScope }> {
    const scope = input.scope ?? 'project';
    this.assertScope(scope);

    const workspacePath = resolveWorkspacePath(input.workspacePath);
    const normalizedName = normalizeServerName(input.name);
    const scopedServers = await this.readScopedServers(scope, workspacePath);
    const removed = Object.prototype.hasOwnProperty.call(scopedServers, normalizedName);
    if (removed) {
      delete scopedServers[normalizedName];
      await this.writeScopedServers(scope, workspacePath, scopedServers);
    }

    return { removed, provider: this.provider, name: normalizedName, scope };
  }

  protected abstract readScopedServers(
    scope: McpScope,
    workspacePath: string,
  ): Promise<Record<string, unknown>>;

  protected abstract writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void>;

  protected abstract buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown>;

  protected abstract normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null;

  /**
   * Reads the provider-native on/off state from a raw server config. Providers
   * with `supportsEnableToggle` must override this together with `writeEnabled`.
   */
  protected readEnabled(_rawConfig: unknown): boolean | undefined {
    return undefined;
  }

  /** Writes the provider-native on/off state into a raw server config in place. */
  protected writeEnabled(_config: Record<string, unknown>, _enabled: boolean): void {
    // Providers without a native switch never reach this.
  }

  /**
   * Overlays freshly built config on the server's existing config. Managed keys
   * come only from `built`; all other existing keys survive the edit.
   */
  private mergeServerConfig(
    existing: Record<string, unknown> | null,
    built: Record<string, unknown>,
  ): Record<string, unknown> {
    const preserved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(existing ?? {})) {
      if (!this.managedConfigKeys.includes(key)) {
        preserved[key] = value;
      }
    }

    // Preserved keys win over `built` only for unmanaged keys, so a managed key
    // missing from `built` (e.g. `command` after switching to http) is dropped.
    return { ...built, ...preserved };
  }

  protected assertScope(scope: McpScope): void {
    if (!this.supportedScopes.includes(scope)) {
      throw new AppError(`Provider "${this.provider}" does not support "${scope}" MCP scope.`, {
        code: 'MCP_SCOPE_NOT_SUPPORTED',
        statusCode: 400,
      });
    }
  }

  protected assertScopeAndTransport(scope: McpScope, transport: McpTransport): void {
    this.assertScope(scope);
    if (!this.supportedTransports.includes(transport)) {
      throw new AppError(`Provider "${this.provider}" does not support "${transport}" MCP transport.`, {
        code: 'MCP_TRANSPORT_NOT_SUPPORTED',
        statusCode: 400,
      });
    }
  }
}
