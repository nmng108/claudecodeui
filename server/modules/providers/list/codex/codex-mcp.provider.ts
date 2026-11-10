import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
} from '@/shared/utils.js';

const readTomlConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = TOML.parse(content) as Record<string, unknown>;
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }
    throw error;
  }
};

const writeTomlConfig = async (filePath: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const toml = TOML.stringify(data as never);
  await writeFile(filePath, toml, 'utf8');
};

export class CodexMcpProvider extends McpProvider {
  protected readonly managedConfigKeys = [
    'command', 'args', 'env', 'env_vars', 'cwd',
    'url', 'bearer_token_env_var', 'http_headers', 'env_http_headers',
  ] as const;

  protected readonly rawServersKey = 'mcp_servers';

  protected async resolveRawConfigFile(scope: McpScope, workspacePath: string) {
    return {
      filePath: scope === 'user'
        ? path.join(os.homedir(), '.codex', 'config.toml')
        : path.join(workspacePath, '.codex', 'config.toml'),
      format: 'toml' as const,
    };
  }

  // Codex skips a server whose table has `enabled = false` but keeps its definition.
  protected readonly supportsEnableToggle = true;

  protected readEnabled(rawConfig: unknown): boolean {
    return readObjectRecord(rawConfig)?.enabled !== false;
  }

  protected writeEnabled(config: Record<string, unknown>, enabled: boolean): void {
    if (enabled) {
      delete config.enabled;
    } else {
      config.enabled = false;
    }
  }

  constructor() {
    super('codex', ['user', 'project'], ['stdio', 'http']);
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const filePath = scope === 'user'
      ? path.join(os.homedir(), '.codex', 'config.toml')
      : path.join(workspacePath, '.codex', 'config.toml');
    const config = await readTomlConfig(filePath);
    return readObjectRecord(config.mcp_servers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const filePath = scope === 'user'
      ? path.join(os.homedir(), '.codex', 'config.toml')
      : path.join(workspacePath, '.codex', 'config.toml');
    const config = await readTomlConfig(filePath);
    config.mcp_servers = servers;
    await writeTomlConfig(filePath, config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) {
        throw new AppError('command is required for stdio MCP servers.', {
          code: 'MCP_COMMAND_REQUIRED',
          statusCode: 400,
        });
      }

      return {
        command: input.command,
        args: input.args ?? [],
        env: input.env ?? {},
        env_vars: input.envVars ?? [],
        cwd: input.cwd,
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      url: input.url,
      bearer_token_env_var: input.bearerTokenEnvVar,
      http_headers: input.headers ?? {},
      env_http_headers: input.envHttpHeaders ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    if (!rawConfig || typeof rawConfig !== 'object') {
      return null;
    }

    const config = rawConfig as Record<string, unknown>;
    if (typeof config.command === 'string') {
      return {
        provider: 'codex',
        name,
        scope,
        transport: 'stdio',
        command: config.command,
        args: readStringArray(config.args),
        env: readStringRecord(config.env),
        cwd: readOptionalString(config.cwd),
        envVars: readStringArray(config.env_vars),
        enabled: config.enabled !== false,
      };
    }

    if (typeof config.url === 'string') {
      return {
        provider: 'codex',
        name,
        scope,
        transport: 'http',
        url: config.url,
        headers: readStringRecord(config.http_headers),
        bearerTokenEnvVar: readOptionalString(config.bearer_token_env_var),
        envHttpHeaders: readStringRecord(config.env_http_headers),
        enabled: config.enabled !== false,
      };
    }

    return null;
  }
}
