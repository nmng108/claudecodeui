import path from 'node:path';

import { mcpCentralDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  CentralMcpApplyResult,
  CentralMcpOperationResult,
  CentralMcpScope,
  CentralMcpServer,
  CentralMcpServerFields,
  CentralMcpServerWithStatus,
  CentralMcpTargetStatus,
  CreateCentralMcpServerInput,
  LLMProvider,
  ProviderMcpServer,
  UpdateCentralMcpServerInput,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type TargetRecord = { serverId: number; provider: LLMProvider; enabled: boolean };

/** Reads each provider scope at most once per operation, since many central servers share them. */
type EntryReader = (provider: LLMProvider, server: CentralMcpServer) => Promise<ProviderMcpServer[]>;

const allProviderIds = (): LLMProvider[] => providerRegistry.listProviders().map((provider) => provider.id);

const notFound = (id: number): AppError => new AppError(`Central MCP server ${id} was not found.`, {
  code: 'MCP_CENTRAL_NOT_FOUND',
  statusCode: 404,
});

const badRequest = (code: string, message: string): AppError => new AppError(message, { code, statusCode: 400 });

const resolveProviderIds = (requested: LLMProvider[] | undefined): LLMProvider[] => {
  const known = allProviderIds();
  const providers = requested ?? known;
  for (const provider of providers) {
    if (!known.includes(provider)) {
      throw badRequest('UNSUPPORTED_PROVIDER', `Unsupported provider "${provider}".`);
    }
  }

  return [...new Set(providers)];
};

/** Keeps only the fields that belong to the transport and checks the required ones. */
const normalizeFields = (fields: CentralMcpServerFields): CentralMcpServerFields => {
  if (fields.transport === 'stdio') {
    if (!fields.command?.trim()) {
      throw badRequest('MCP_COMMAND_REQUIRED', 'command is required for stdio MCP servers.');
    }

    return { transport: 'stdio', command: fields.command.trim(), args: fields.args ?? [], env: fields.env ?? {} };
  }

  if (fields.transport === 'http') {
    if (!fields.url?.trim()) {
      throw badRequest('MCP_URL_REQUIRED', 'url is required for http MCP servers.');
    }

    return { transport: 'http', url: fields.url.trim(), headers: fields.headers ?? {} };
  }

  throw badRequest('INVALID_MCP_TRANSPORT', 'Central MCP servers support only "stdio" and "http".');
};

const fieldsOf = (server: CentralMcpServer): CentralMcpServerFields => ({
  transport: server.transport,
  command: server.command,
  args: server.args,
  env: server.env,
  url: server.url,
  headers: server.headers,
});

const workspaceKey = (scope: CentralMcpScope, workspacePath?: string): string => {
  if (scope === 'user') {
    return '';
  }

  if (!workspacePath?.trim()) {
    throw badRequest('MCP_WORKSPACE_REQUIRED', 'workspacePath is required for project scope.');
  }

  return path.resolve(workspacePath);
};

const sortedEntries = (record?: Record<string, string>): string =>
  JSON.stringify(Object.entries(record ?? {}).sort(([left], [right]) => left.localeCompare(right)));

/** Names the fields in which a provider's entry differs from the central definition. */
const diffEntry = (
  server: CentralMcpServer,
  entry: ProviderMcpServer,
  target: TargetRecord,
  canToggle: boolean,
): string[] => {
  const differences: string[] = [];
  if (entry.transport !== server.transport) {
    differences.push('transport');
  } else if (server.transport === 'stdio') {
    if ((entry.command ?? '') !== (server.command ?? '')) differences.push('command');
    if (JSON.stringify(entry.args ?? []) !== JSON.stringify(server.args ?? [])) differences.push('args');
    if (sortedEntries(entry.env) !== sortedEntries(server.env)) differences.push('env');
  } else {
    if ((entry.url ?? '') !== (server.url ?? '')) differences.push('url');
    if (sortedEntries(entry.headers) !== sortedEntries(server.headers)) differences.push('headers');
  }

  const providerEnabled = canToggle ? entry.enabled : true;
  if (providerEnabled !== undefined && providerEnabled !== target.enabled) {
    differences.push('enabled');
  }

  return differences;
};

const entryLocation = (server: CentralMcpServer) => ({
  name: server.name,
  scope: server.scope,
  workspacePath: server.workspacePath,
});

const createEntryReader = (): EntryReader => {
  const cache = new Map<string, Promise<ProviderMcpServer[]>>();
  return (provider, server) => {
    const key = `${provider}|${server.scope}|${server.workspacePath ?? ''}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = providerRegistry
        .resolveProvider(provider)
        .mcp.listServersForScope(server.scope, { workspacePath: server.workspacePath });
      cache.set(key, pending);
    }

    return pending;
  };
};

const buildTargetStatus = async (
  server: CentralMcpServer,
  target: TargetRecord,
  readEntries: EntryReader,
): Promise<CentralMcpTargetStatus> => {
  const canToggle = providerRegistry.resolveProvider(target.provider).mcp.canToggleServers();
  try {
    const entries = await readEntries(target.provider, server);
    const entry = entries.find((candidate) => candidate.name === server.name);
    if (!entry) {
      return {
        provider: target.provider,
        enabled: target.enabled,
        state: !target.enabled && !canToggle ? 'paused' : 'missing',
        differences: [],
      };
    }

    const differences = diffEntry(server, entry, target, canToggle);
    // A provider without a native switch should have no entry while the server is off.
    if (!canToggle && !target.enabled && !differences.includes('enabled')) {
      differences.push('enabled');
    }

    return {
      provider: target.provider,
      enabled: target.enabled,
      state: differences.length === 0 ? 'in_sync' : 'drifted',
      differences,
    };
  } catch (error) {
    return {
      provider: target.provider,
      enabled: target.enabled,
      state: 'missing',
      differences: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
};

const withStatus = async (
  server: CentralMcpServer,
  readEntries: EntryReader = createEntryReader(),
): Promise<CentralMcpServerWithStatus> => {
  const targets = mcpCentralDb.listTargets(server.id);
  return { ...server, targets: await Promise.all(targets.map((target) => buildTargetStatus(server, target, readEntries))) };
};

const requireServer = (id: number): CentralMcpServer => {
  const server = mcpCentralDb.getServer(id);
  if (!server) {
    throw notFound(id);
  }

  return server;
};

/**
 * Writes the central definition into one provider's config. A provider without a
 * native on/off field expresses "off" by removing the entry.
 */
const applyToProvider = async (
  server: CentralMcpServer,
  providerId: LLMProvider,
  enabled: boolean,
): Promise<CentralMcpApplyResult['outcome']> => {
  const provider = providerRegistry.resolveProvider(providerId);
  const canToggle = provider.mcp.canToggleServers();
  if (!enabled && !canToggle) {
    await provider.mcp.removeServer(entryLocation(server));
    return 'removed';
  }

  await provider.mcp.upsertServer({
    ...entryLocation(server),
    ...fieldsOf(server),
    enabled: canToggle ? enabled : undefined,
  });
  return 'applied';
};

/** Flips only the on/off state where the provider has a switch, so unrelated drift is not overwritten. */
const applyEnabledOnly = async (
  server: CentralMcpServer,
  providerId: LLMProvider,
  enabled: boolean,
  readEntries: EntryReader,
): Promise<CentralMcpApplyResult['outcome']> => {
  const provider = providerRegistry.resolveProvider(providerId);
  if (provider.mcp.canToggleServers()) {
    const entries = await readEntries(providerId, server);
    if (entries.some((entry) => entry.name === server.name)) {
      await provider.mcp.setServerEnabled({ ...entryLocation(server), enabled });
      return 'applied';
    }
  }

  return applyToProvider(server, providerId, enabled);
};

/** Links a provider: refuses to touch an entry the app does not own unless `adopt` is set. */
const linkProvider = async (
  server: CentralMcpServer,
  providerId: LLMProvider,
  enabled: boolean,
  adopt: boolean,
): Promise<CentralMcpApplyResult> => {
  try {
    const provider = providerRegistry.resolveProvider(providerId);
    const existing = (await provider.mcp.listServersForScope(server.scope, { workspacePath: server.workspacePath }))
      .some((entry) => entry.name === server.name);
    const owned = mcpCentralDb.listTargets(server.id).some((target) => target.provider === providerId);
    if (existing && !owned && !adopt) {
      return {
        provider: providerId,
        outcome: 'conflict',
        error: `${providerId} already has a server named "${server.name}" that is not managed here.`,
      };
    }

    const outcome = await applyToProvider(server, providerId, enabled);
    mcpCentralDb.setTarget(server.id, providerId, enabled);
    return { provider: providerId, outcome };
  } catch (error) {
    return { provider: providerId, outcome: 'failed', error: error instanceof Error ? error.message : 'Unknown error' };
  }
};

/** Removes the provider entry the app owns and forgets the link. */
const unlinkProvider = async (server: CentralMcpServer, providerId: LLMProvider): Promise<CentralMcpApplyResult> => {
  try {
    const provider = providerRegistry.resolveProvider(providerId);
    await provider.mcp.removeServer(entryLocation(server));
    mcpCentralDb.removeTarget(server.id, providerId);
    return { provider: providerId, outcome: 'removed' };
  } catch (error) {
    return { provider: providerId, outcome: 'failed', error: error instanceof Error ? error.message : 'Unknown error' };
  }
};

const settle = async (
  server: CentralMcpServer,
  results: CentralMcpApplyResult[],
): Promise<CentralMcpOperationResult> => ({ server: await withStatus(server), results });

export const providerMcpCentralService = {
  /** Lists every central server with how each linked provider compares with it. */
  async listCentralServers(): Promise<CentralMcpServerWithStatus[]> {
    const readEntries = createEntryReader();
    return Promise.all(mcpCentralDb.listServers().map((server) => withStatus(server, readEntries)));
  },

  /** Creates a central server and writes it into each requested provider. */
  async createCentralServer(input: CreateCentralMcpServerInput): Promise<CentralMcpOperationResult> {
    const name = input.name?.trim();
    if (!name) {
      throw badRequest('MCP_SERVER_NAME_REQUIRED', 'MCP server name is required.');
    }

    if (input.scope !== 'user' && input.scope !== 'project') {
      throw badRequest('INVALID_MCP_SCOPE', 'Central MCP servers support only "user" or "project" scope.');
    }

    const workspacePath = workspaceKey(input.scope, input.workspacePath);
    const fields = normalizeFields(input);
    const providers = resolveProviderIds(input.providers);
    if (mcpCentralDb.findServer(name, input.scope, workspacePath)) {
      throw new AppError(`A shared MCP server named "${name}" already exists in this scope.`, {
        code: 'MCP_CENTRAL_DUPLICATE',
        statusCode: 409,
      });
    }

    const server = mcpCentralDb.createServer({ name, scope: input.scope, workspacePath }, fields);
    const results: CentralMcpApplyResult[] = [];
    for (const providerId of providers) {
      results.push(await linkProvider(server, providerId, input.enabled ?? true, input.adoptExisting === true));
    }

    return settle(server, results);
  },

  /** Changes a central server's connection fields and/or linked providers, pushing the change to providers. */
  async updateCentralServer(id: number, input: UpdateCentralMcpServerInput): Promise<CentralMcpOperationResult> {
    let server = requireServer(id);
    const results: CentralMcpApplyResult[] = [];
    const previousTargets = mcpCentralDb.listTargets(id);

    const touchesFields = (['transport', 'command', 'args', 'env', 'url', 'headers'] as const)
      .some((key) => input[key] !== undefined);
    if (touchesFields) {
      const merged = normalizeFields({ ...fieldsOf(server), ...stripUndefined(input) });
      server = mcpCentralDb.updateServerFields(id, merged) as CentralMcpServer;
    }

    const desired = input.providers ? resolveProviderIds(input.providers) : previousTargets.map((target) => target.provider);
    for (const target of previousTargets) {
      if (!desired.includes(target.provider)) {
        results.push(await unlinkProvider(server, target.provider));
      } else if (touchesFields) {
        try {
          results.push({ provider: target.provider, outcome: await applyToProvider(server, target.provider, target.enabled) });
        } catch (error) {
          results.push({ provider: target.provider, outcome: 'failed', error: error instanceof Error ? error.message : 'Unknown error' });
        }
      }
    }

    for (const providerId of desired) {
      if (!previousTargets.some((target) => target.provider === providerId)) {
        results.push(await linkProvider(server, providerId, true, input.adoptExisting === true));
      }
    }

    return settle(server, results);
  },

  /** Switches the server on or off for the given providers (default: all linked ones). */
  async setCentralServerEnabled(
    id: number,
    enabled: boolean,
    providers?: LLMProvider[],
  ): Promise<CentralMcpOperationResult> {
    const server = requireServer(id);
    const requested = providers ? resolveProviderIds(providers) : null;
    const readEntries = createEntryReader();
    const results: CentralMcpApplyResult[] = [];
    for (const target of mcpCentralDb.listTargets(id)) {
      if (requested && !requested.includes(target.provider)) {
        continue;
      }

      try {
        const outcome = await applyEnabledOnly(server, target.provider, enabled, readEntries);
        mcpCentralDb.setTarget(id, target.provider, enabled);
        results.push({ provider: target.provider, outcome });
      } catch (error) {
        results.push({ provider: target.provider, outcome: 'failed', error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    return settle(server, results);
  },

  /** Re-applies the central definition to one linked provider, or to all of them. */
  async resyncCentralServer(id: number, provider?: LLMProvider): Promise<CentralMcpOperationResult> {
    const server = requireServer(id);
    const results: CentralMcpApplyResult[] = [];
    for (const target of mcpCentralDb.listTargets(id)) {
      if (provider && target.provider !== provider) {
        continue;
      }

      try {
        results.push({ provider: target.provider, outcome: await applyToProvider(server, target.provider, target.enabled) });
      } catch (error) {
        results.push({ provider: target.provider, outcome: 'failed', error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    return settle(server, results);
  },

  /** Makes the central definition match one provider's current entry; other providers then show as drifted. */
  async adoptCentralFromProvider(id: number, providerId: LLMProvider): Promise<CentralMcpOperationResult> {
    const server = requireServer(id);
    const target = mcpCentralDb.listTargets(id).find((candidate) => candidate.provider === providerId);
    if (!target) {
      throw badRequest('MCP_CENTRAL_NOT_LINKED', `${providerId} is not linked to this shared server.`);
    }

    const entries = await createEntryReader()(providerId, server);
    const entry = entries.find((candidate) => candidate.name === server.name);
    if (!entry) {
      throw new AppError(`${providerId} has no server named "${server.name}" to take values from.`, {
        code: 'MCP_SERVER_NOT_FOUND',
        statusCode: 404,
      });
    }

    const fields = fieldsFromProviderEntry(entry);
    const updated = mcpCentralDb.updateServerFields(id, fields) as CentralMcpServer;
    if (entry.enabled !== undefined) {
      mcpCentralDb.setTarget(id, providerId, entry.enabled);
    }

    return settle(updated, []);
  },

  /** Turns an existing provider entry into a central server linked to that provider only. */
  async importFromProvider(input: {
    provider: LLMProvider;
    name: string;
    scope: CentralMcpScope;
    workspacePath?: string;
  }): Promise<CentralMcpOperationResult> {
    const workspacePath = workspaceKey(input.scope, input.workspacePath);
    if (mcpCentralDb.findServer(input.name, input.scope, workspacePath)) {
      throw new AppError(`A shared MCP server named "${input.name}" already exists in this scope.`, {
        code: 'MCP_CENTRAL_DUPLICATE',
        statusCode: 409,
      });
    }

    const provider = providerRegistry.resolveProvider(input.provider);
    const entries = await provider.mcp.listServersForScope(input.scope, { workspacePath: workspacePath || undefined });
    const entry = entries.find((candidate) => candidate.name === input.name);
    if (!entry) {
      throw new AppError(`${input.provider} has no server named "${input.name}".`, {
        code: 'MCP_SERVER_NOT_FOUND',
        statusCode: 404,
      });
    }

    const server = mcpCentralDb.createServer(
      { name: input.name, scope: input.scope, workspacePath },
      fieldsFromProviderEntry(entry),
    );
    mcpCentralDb.setTarget(server.id, input.provider, entry.enabled !== false);
    return settle(server, [{ provider: input.provider, outcome: 'applied' }]);
  },

  /** Deletes a central server and, unless told otherwise, the provider entries it owns. */
  async deleteCentralServer(id: number, removeFromProviders = true): Promise<CentralMcpApplyResult[]> {
    const server = requireServer(id);
    const results: CentralMcpApplyResult[] = [];
    if (removeFromProviders) {
      for (const target of mcpCentralDb.listTargets(id)) {
        results.push(await unlinkProvider(server, target.provider));
      }
    }

    if (results.some((result) => result.outcome === 'failed')) {
      return results;
    }

    mcpCentralDb.deleteServer(id);
    return results;
  },
};

const stripUndefined = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;

/** Reads a provider entry into central fields; SSE entries cannot be shared. */
function fieldsFromProviderEntry(entry: ProviderMcpServer): CentralMcpServerFields {
  if (entry.transport === 'sse') {
    throw badRequest('INVALID_MCP_TRANSPORT', 'SSE servers cannot be shared across providers.');
  }

  return normalizeFields({
    transport: entry.transport,
    command: entry.command,
    args: entry.args,
    env: entry.env,
    url: entry.url,
    headers: entry.headers,
  });
}
