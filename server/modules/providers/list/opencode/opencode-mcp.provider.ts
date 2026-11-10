import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  parseJsoncText,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
} from '@/shared/utils.js';

type OpenCodeConfigPath = {
  filePath: string;
  exists: boolean;
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readOpenCodeConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = parseJsoncText(content);
    return readObjectRecord(parsed) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {};
    }

    throw error;
  }
};

const writeOpenCodeConfig = async (filePath: string, data: Record<string, unknown>): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
};

const resolveOpenCodeConfigPath = async (scope: McpScope, workspacePath: string): Promise<OpenCodeConfigPath> => {
  const root = scope === 'user'
    ? path.join(os.homedir(), '.config', 'opencode')
    : workspacePath;
  const jsonPath = path.join(root, 'opencode.json');
  const jsoncPath = path.join(root, 'opencode.jsonc');

  if (await fileExists(jsonPath)) {
    return { filePath: jsonPath, exists: true };
  }

  if (await fileExists(jsoncPath)) {
    return { filePath: jsoncPath, exists: true };
  }

  return { filePath: jsonPath, exists: false };
};

export class OpenCodeMcpProvider extends McpProvider {
  // `enabled` is deliberately not managed: a new server gets `enabled: true` from
  // buildServerConfig, and an edit keeps whatever the user last chose.
  protected readonly managedConfigKeys = ['type', 'command', 'args', 'env', 'environment', 'url', 'headers'] as const;

  protected readonly rawServersKey = 'mcp';

  protected async resolveRawConfigFile(scope: McpScope, workspacePath: string) {
    const { filePath } = await resolveOpenCodeConfigPath(scope, workspacePath);
    return { filePath, format: 'jsonc' as const };
  }

  protected readonly supportsEnableToggle = true;

  protected readEnabled(rawConfig: unknown): boolean {
    return readObjectRecord(rawConfig)?.enabled !== false;
  }

  protected writeEnabled(config: Record<string, unknown>, enabled: boolean): void {
    config.enabled = enabled;
  }

  constructor() {
    super('opencode', ['user', 'project'], ['stdio', 'http']);
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const { filePath } = await resolveOpenCodeConfigPath(scope, workspacePath);
    const config = await readOpenCodeConfig(filePath);
    return readObjectRecord(config.mcp) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const { filePath } = await resolveOpenCodeConfigPath(scope, workspacePath);
    const config = await readOpenCodeConfig(filePath);
    config.mcp = servers;
    await writeOpenCodeConfig(filePath, config);
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
        type: 'local',
        command: [input.command, ...(input.args ?? [])],
        enabled: true,
        environment: input.env ?? {},
      };
    }

    if (!input.url?.trim()) {
      throw new AppError('url is required for http MCP servers.', {
        code: 'MCP_URL_REQUIRED',
        statusCode: 400,
      });
    }

    return {
      type: 'remote',
      url: input.url,
      enabled: true,
      headers: input.headers ?? {},
    };
  }

  protected normalizeServerConfig(
    scope: McpScope,
    name: string,
    rawConfig: unknown,
  ): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) {
      return null;
    }

    if (config.type === 'local' || config.command !== undefined) {
      const commandParts = typeof config.command === 'string'
        ? [config.command, ...(readStringArray(config.args) ?? [])]
        : readStringArray(config.command);
      const command = commandParts?.[0];
      if (!command) {
        return null;
      }

      return {
        provider: 'opencode',
        name,
        scope,
        transport: 'stdio',
        command,
        args: commandParts.slice(1),
        env: readStringRecord(config.environment) ?? readStringRecord(config.env),
        enabled: config.enabled !== false,
      };
    }

    if (config.type === 'remote' || typeof config.url === 'string') {
      const url = readOptionalString(config.url);
      if (!url) {
        return null;
      }

      return {
        provider: 'opencode',
        name,
        scope,
        transport: 'http',
        url,
        headers: readStringRecord(config.headers),
        enabled: config.enabled !== false,
      };
    }

    return null;
  }
}
