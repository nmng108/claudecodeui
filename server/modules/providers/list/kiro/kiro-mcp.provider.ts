import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import {
  AppError,
  readObjectRecord,
  readOptionalString,
  readStringArray,
  readStringRecord,
} from '@/shared/utils.js';

/**
 * Kiro keeps MCP servers in `<root>/.kiro/settings/mcp.json` under a top-level
 * `mcpServers` object (user root = home directory, project root = workspace).
 * A local server has `command`/`args`/`env`; a remote one has `url`/`headers`.
 * Kiro also stores `disabled` and `autoApprove` per server, and other
 * top-level keys may exist, so writes only replace `mcpServers`.
 */
const getKiroMcpConfigPath = (scope: McpScope, workspacePath: string): string => {
  const root = scope === 'user' ? os.homedir() : workspacePath;
  return path.join(root, '.kiro', 'settings', 'mcp.json');
};

const readKiroMcpConfig = async (filePath: string): Promise<Record<string, unknown>> => {
  let content: string;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }

  if (!content.trim()) {
    return {};
  }

  try {
    return readObjectRecord(JSON.parse(content)) ?? {};
  } catch {
    // Never overwrite a file we cannot parse: a write would destroy the user's config.
    throw new AppError(`Kiro MCP config is not valid JSON: ${filePath}`, {
      code: 'KIRO_MCP_CONFIG_INVALID',
      statusCode: 422,
    });
  }
};

export class KiroMcpProvider extends McpProvider {
  constructor() {
    super('kiro', ['user', 'project'], ['stdio', 'http']);
  }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const config = await readKiroMcpConfig(getKiroMcpConfigPath(scope, workspacePath));
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(
    scope: McpScope,
    workspacePath: string,
    servers: Record<string, unknown>,
  ): Promise<void> {
    const filePath = getKiroMcpConfigPath(scope, workspacePath);
    const config = await readKiroMcpConfig(filePath);
    config.mcpServers = servers;

    await mkdir(path.dirname(filePath), { recursive: true });
    // Temp file + rename so a crash cannot leave a half-written config.
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    await rename(tempPath, filePath);
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

    const command = readOptionalString(config.command);
    if (command) {
      return {
        provider: 'kiro',
        name,
        scope,
        transport: 'stdio',
        command,
        args: readStringArray(config.args) ?? [],
        env: readStringRecord(config.env),
      };
    }

    const url = readOptionalString(config.url);
    if (url) {
      return {
        provider: 'kiro',
        name,
        scope,
        transport: 'http',
        url,
        headers: readStringRecord(config.headers),
      };
    }

    return null;
  }
}
