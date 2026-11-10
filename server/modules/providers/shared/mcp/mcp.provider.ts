import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import TOML from '@iarna/toml';

import type { IProviderMcp } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  McpRawConfigDocument,
  McpRawConfigFormat,
  McpScope,
  McpTransport,
  ProviderMcpRawConfig,
  ProviderMcpRawConfigWriteResult,
  ProviderMcpServer,
  SetProviderMcpServerEnabledInput,
  UpsertProviderMcpServerInput,
  WriteProviderMcpRawConfigInput,
} from '@/shared/types.js';
import { AppError, parseJsoncText, readObjectRecord } from '@/shared/utils.js';

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

const hashRawContent = (content: string): string => createHash('sha256').update(content).digest('hex');

const invalidRawConfig = (message: string): AppError => new AppError(message, {
  code: 'MCP_CONFIG_INVALID',
  statusCode: 422,
});

/**
 * Parses raw config text in the provider's format. Blank text is an empty
 * document; anything that is not an object is rejected.
 */
const parseRawConfigContent = (format: McpRawConfigFormat, content: string): Record<string, unknown> => {
  if (!content.trim()) {
    return {};
  }

  let parsed: unknown;
  try {
    if (format === 'toml') {
      parsed = TOML.parse(content);
    } else if (format === 'jsonc') {
      parsed = parseJsoncText(content);
    } else {
      parsed = JSON.parse(content);
    }
  } catch (error) {
    throw invalidRawConfig(`Config is not valid ${format.toUpperCase()}: ${error instanceof Error ? error.message : 'parse error'}`);
  }

  const record = readObjectRecord(parsed);
  if (!record) {
    throw invalidRawConfig('Config must be an object at the top level.');
  }

  return record;
};

const serializeRawConfig = (format: McpRawConfigFormat, document: Record<string, unknown>): string =>
  format === 'toml' ? TOML.stringify(document as never) : `${JSON.stringify(document, null, 2)}\n`;

/** Writes via temp file + rename, keeping the existing file's permissions (these files hold secrets). */
const writeTextFileAtomic = async (filePath: string, content: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const mode = await stat(filePath).then((stats) => stats.mode & 0o777).catch(() => 0o600);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, content, { encoding: 'utf8', mode });
  await rename(tempPath, filePath);
};

/** Keeps one copy of the previous file next to it so a bad edit can be undone by hand. */
const backupExistingFile = async (filePath: string): Promise<void> => {
  await copyFile(filePath, `${filePath}.cloudcli.bak`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  });
};

const sameJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

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

  /** Key inside the parsed config document that holds the servers map (`mcpServers`, `mcp_servers`, `mcp`). */
  protected abstract readonly rawServersKey: string;

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

  canToggleServers(): boolean {
    return this.supportsEnableToggle;
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

  async readRawConfig(input: { scope?: McpScope; workspacePath?: string }): Promise<ProviderMcpRawConfig> {
    const scope = input.scope ?? 'project';
    this.assertScope(scope);
    const document = await this.loadRawDocument(scope, resolveWorkspacePath(input.workspacePath));
    return this.toRawConfig(scope, document);
  }

  async writeRawConfig(input: WriteProviderMcpRawConfigInput): Promise<ProviderMcpRawConfigWriteResult> {
    const scope = input.scope ?? 'project';
    this.assertScope(scope);
    if (typeof input.content !== 'string') {
      throw invalidRawConfig('content must be a string.');
    }

    const workspacePath = resolveWorkspacePath(input.workspacePath);
    const document = await this.loadRawDocument(scope, workspacePath);
    if (input.expectedHash && input.expectedHash !== hashRawContent(document.content)) {
      throw new AppError('The MCP config changed on disk since it was loaded. Reload it and apply your edit again.', {
        code: 'MCP_CONFIG_CHANGED',
        statusCode: 409,
      });
    }

    // A broken existing file must stay fixable through a replace, so it is not fatal here.
    let existingDocument: Record<string, unknown> | null = null;
    try {
      existingDocument = parseRawConfigContent(document.format, document.content);
    } catch {
      existingDocument = null;
    }
    const existingServers = readObjectRecord(existingDocument?.[this.rawServersKey]) ?? {};

    const incoming = parseRawConfigContent(document.format, input.content);
    let nextContent: string;
    let nextServers: Record<string, unknown>;
    if (input.mode === 'merge') {
      if (!existingDocument) {
        throw invalidRawConfig('The existing config cannot be parsed, so servers cannot be merged into it. Use replace instead.');
      }

      nextServers = { ...existingServers, ...this.readIncomingServers(incoming) };
      nextContent = serializeRawConfig(document.format, { ...existingDocument, [this.rawServersKey]: nextServers });
    } else {
      nextServers = readObjectRecord(incoming[this.rawServersKey]) ?? {};
      nextContent = input.content;
    }

    this.assertServersValid(scope, existingServers, nextServers);

    const nextNames = Object.keys(nextServers);
    const result: ProviderMcpRawConfigWriteResult = {
      ...this.toRawConfig(scope, { ...document, content: nextContent, exists: document.exists || !input.dryRun }),
      added: nextNames.filter((name) => !(name in existingServers)),
      changed: nextNames.filter((name) => name in existingServers && !sameJson(existingServers[name], nextServers[name])),
      removed: Object.keys(existingServers).filter((name) => !(name in nextServers)),
      written: false,
    };

    if (!input.dryRun) {
      await this.persistRawDocument(scope, workspacePath, document, nextContent);
      result.written = true;
    }

    return result;
  }

  /** Reads the config document for a scope; shared-file providers override this to expose only the MCP section. */
  protected async loadRawDocument(scope: McpScope, workspacePath: string): Promise<McpRawConfigDocument> {
    const { filePath, format } = await this.resolveRawConfigFile(scope, workspacePath);
    try {
      return { filePath, format, content: await readFile(filePath, 'utf8'), exists: true, partial: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { filePath, format, content: '', exists: false, partial: false };
      }

      throw error;
    }
  }

  /** Stores validated raw text, backing up the previous file first. */
  protected async persistRawDocument(
    _scope: McpScope,
    _workspacePath: string,
    document: McpRawConfigDocument,
    content: string,
  ): Promise<void> {
    if (document.exists) {
      await backupExistingFile(document.filePath);
    }

    await writeTextFileAtomic(document.filePath, content);
  }

  /** File and syntax used for a scope by the default whole-file raw editor. */
  protected abstract resolveRawConfigFile(
    scope: McpScope,
    workspacePath: string,
  ): Promise<{ filePath: string; format: McpRawConfigFormat }>;

  private toRawConfig(scope: McpScope, document: McpRawConfigDocument): ProviderMcpRawConfig {
    return {
      provider: this.provider,
      scope,
      filePath: document.filePath,
      format: document.format,
      content: document.content,
      exists: document.exists,
      hash: hashRawContent(document.content),
      partial: document.partial,
    };
  }

  /** Accepts a full document or a bare name-to-server map pasted without its wrapper key. */
  private readIncomingServers(incoming: Record<string, unknown>): Record<string, unknown> {
    const wrapped = readObjectRecord(incoming[this.rawServersKey]);
    if (wrapped) {
      return wrapped;
    }

    const values = Object.values(incoming);
    if (values.length > 0 && values.every((value) => readObjectRecord(value))) {
      return incoming;
    }

    throw invalidRawConfig(`Expected a "${this.rawServersKey}" object or a map of server names to server definitions.`);
  }

  /** Rejects servers this provider cannot read, unless they were already in the file unchanged. */
  private assertServersValid(
    scope: McpScope,
    existingServers: Record<string, unknown>,
    nextServers: Record<string, unknown>,
  ): void {
    const problems: string[] = [];
    for (const [name, config] of Object.entries(nextServers)) {
      if (!name.trim()) {
        problems.push('a server has an empty name');
      } else if (
        this.normalizeServerConfig(scope, name, config) === null
        && !(name in existingServers && sameJson(existingServers[name], config))
      ) {
        problems.push(`"${name}" is not a valid ${this.provider} MCP server`);
      }
    }

    if (problems.length > 0) {
      throw invalidRawConfig(`Invalid MCP servers: ${problems.join('; ')}.`);
    }
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
