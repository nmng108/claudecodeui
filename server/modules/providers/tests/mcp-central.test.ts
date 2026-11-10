import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { providerMcpCentralService } from '@/modules/providers/services/mcp-central.service.js';
import { AppError } from '@/shared/utils.js';

const PROVIDERS = ['claude', 'codex', 'cursor', 'opencode', 'kiro'] as const;

/** Runs a test against a fresh database and a fake home directory. */
async function withCentralEnvironment(run: (context: { home: string; workspace: string }) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const originalHomedir = os.homedir;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-central-'));
  const workspace = path.join(home, 'workspace');
  await fs.mkdir(workspace, { recursive: true });

  closeConnection();
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  (os as any).homedir = () => home;

  try {
    await run({ home, workspace });
  } finally {
    (os as any).homedir = originalHomedir;
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

const userEntry = async (provider: (typeof PROVIDERS)[number], name: string) =>
  (await providerMcpService.listProviderMcpServersForScope(provider, 'user')).find((server) => server.name === name);

const stateOf = (status: { targets: Array<{ provider: string; state: string }> }, provider: string) =>
  status.targets.find((target) => target.provider === provider)?.state;

/**
 * This test covers creating a central server: every provider gets the entry,
 * statuses start in sync, and the same name cannot be created twice.
 */
test('central MCP server is written to every provider and starts in sync', { concurrency: false }, async () => {
  await withCentralEnvironment(async () => {
    const created = await providerMcpCentralService.createCentralServer({
      name: 'shared-http',
      scope: 'user',
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer x' },
    });

    assert.deepEqual(created.results.map((result) => result.outcome), PROVIDERS.map(() => 'applied'));
    for (const provider of PROVIDERS) {
      assert.equal((await userEntry(provider, 'shared-http'))?.url, 'https://example.com/mcp', provider);
      assert.equal(stateOf(created.server, provider), 'in_sync', provider);
    }

    await assert.rejects(
      providerMcpCentralService.createCentralServer({ name: 'shared-http', scope: 'user', transport: 'http', url: 'https://other' }),
      (error: unknown) => error instanceof AppError && error.code === 'MCP_CENTRAL_DUPLICATE' && error.statusCode === 409,
    );
  });
});

/**
 * This test covers a provider-side edit: the provider keeps its own change, the
 * central status shows the drifted field, and resync pushes the central value back.
 */
test('editing a provider entry shows drift and resync restores it', { concurrency: false }, async () => {
  await withCentralEnvironment(async () => {
    const { server } = await providerMcpCentralService.createCentralServer({
      name: 'drifty',
      scope: 'user',
      transport: 'http',
      url: 'https://example.com/a',
      providers: ['kiro', 'cursor'],
    });

    await providerMcpService.upsertProviderMcpServer('kiro', {
      name: 'drifty', scope: 'user', transport: 'http', url: 'https://example.com/changed',
    });
    assert.equal((await userEntry('kiro', 'drifty'))?.url, 'https://example.com/changed');

    const listed = (await providerMcpCentralService.listCentralServers())[0];
    const kiro = listed.targets.find((target) => target.provider === 'kiro');
    assert.equal(kiro?.state, 'drifted');
    assert.deepEqual(kiro?.differences, ['url']);
    assert.equal(stateOf(listed, 'cursor'), 'in_sync');

    const resynced = await providerMcpCentralService.resyncCentralServer(server.id, 'kiro');
    assert.equal(stateOf(resynced.server, 'kiro'), 'in_sync');
    assert.equal((await userEntry('kiro', 'drifty'))?.url, 'https://example.com/a');

    // Adopting takes the provider's value as the new central value.
    await providerMcpService.upsertProviderMcpServer('kiro', {
      name: 'drifty', scope: 'user', transport: 'http', url: 'https://example.com/b',
    });
    const adopted = await providerMcpCentralService.adoptCentralFromProvider(server.id, 'kiro');
    assert.equal(adopted.server.url, 'https://example.com/b');
    assert.equal(stateOf(adopted.server, 'kiro'), 'in_sync');
    assert.equal(stateOf(adopted.server, 'cursor'), 'drifted');
  });
});

/**
 * This test covers switching a central server off: providers with a native switch
 * keep the entry (and their other fields), the others lose it and show as paused.
 */
test('disabling a central server uses native switches and pauses the other providers', { concurrency: false }, async () => {
  await withCentralEnvironment(async () => {
    const { server } = await providerMcpCentralService.createCentralServer({
      name: 'toggled', scope: 'user', transport: 'stdio', command: 'node', args: ['s.js'],
    });
    // A provider-only field must survive the toggle.
    const kiroFile = path.join(os.homedir(), '.kiro', 'settings', 'mcp.json');
    const kiroConfig = JSON.parse(await fs.readFile(kiroFile, 'utf8'));
    kiroConfig.mcpServers.toggled.autoApprove = ['tool'];
    await fs.writeFile(kiroFile, JSON.stringify(kiroConfig), 'utf8');

    const off = await providerMcpCentralService.setCentralServerEnabled(server.id, false);
    assert.equal((await userEntry('kiro', 'toggled'))?.enabled, false);
    assert.equal(JSON.parse(await fs.readFile(kiroFile, 'utf8')).mcpServers.toggled.autoApprove[0], 'tool');
    assert.equal(await userEntry('claude', 'toggled'), undefined);
    assert.equal(await userEntry('cursor', 'toggled'), undefined);
    assert.equal(stateOf(off.server, 'claude'), 'paused');
    assert.equal(stateOf(off.server, 'kiro'), 'in_sync');

    const on = await providerMcpCentralService.setCentralServerEnabled(server.id, true);
    assert.equal((await userEntry('kiro', 'toggled'))?.enabled, true);
    assert.equal((await userEntry('claude', 'toggled'))?.command, 'node');
    assert.ok(on.server.targets.every((target) => target.state === 'in_sync'));

    // One provider only.
    await providerMcpCentralService.setCentralServerEnabled(server.id, false, ['codex']);
    assert.equal((await userEntry('codex', 'toggled'))?.enabled, false);
    assert.equal((await userEntry('kiro', 'toggled'))?.enabled, true);
  });
});

/**
 * This test covers name collisions with entries the app does not own, plus editing,
 * unlinking and deleting a central server.
 */
test('conflicts are left alone unless adopted, and update/unlink/delete touch only owned entries', { concurrency: false }, async () => {
  await withCentralEnvironment(async () => {
    await providerMcpService.upsertProviderMcpServer('cursor', {
      name: 'taken', scope: 'user', transport: 'stdio', command: 'mine',
    });
    await providerMcpService.upsertProviderMcpServer('kiro', {
      name: 'unrelated', scope: 'user', transport: 'stdio', command: 'keep',
    });

    const created = await providerMcpCentralService.createCentralServer({
      name: 'taken', scope: 'user', transport: 'stdio', command: 'shared', providers: ['cursor', 'kiro'],
    });
    assert.equal(created.results.find((result) => result.provider === 'cursor')?.outcome, 'conflict');
    assert.equal((await userEntry('cursor', 'taken'))?.command, 'mine');
    assert.deepEqual(created.server.targets.map((target) => target.provider), ['kiro']);

    const adopted = await providerMcpCentralService.updateCentralServer(created.server.id, {
      providers: ['cursor', 'kiro'],
      adoptExisting: true,
    });
    assert.equal(adopted.results.find((result) => result.provider === 'cursor')?.outcome, 'applied');
    assert.equal((await userEntry('cursor', 'taken'))?.command, 'shared');

    const updated = await providerMcpCentralService.updateCentralServer(created.server.id, { command: 'shared2', args: ['x'] });
    assert.equal((await userEntry('kiro', 'taken'))?.command, 'shared2');
    assert.deepEqual((await userEntry('cursor', 'taken'))?.args, ['x']);
    assert.ok(updated.server.targets.every((target) => target.state === 'in_sync'));

    await providerMcpCentralService.updateCentralServer(created.server.id, { providers: ['kiro'] });
    assert.equal(await userEntry('cursor', 'taken'), undefined);

    const results = await providerMcpCentralService.deleteCentralServer(created.server.id);
    assert.deepEqual(results.map((result) => result.outcome), ['removed']);
    assert.equal(await userEntry('kiro', 'taken'), undefined);
    assert.equal((await userEntry('kiro', 'unrelated'))?.command, 'keep');
    assert.deepEqual(await providerMcpCentralService.listCentralServers(), []);
  });
});

/** This test covers project scope (needs a workspace) and importing an existing provider entry. */
test('project scope requires a workspace and import links one provider', { concurrency: false }, async () => {
  await withCentralEnvironment(async ({ workspace }) => {
    await assert.rejects(
      providerMcpCentralService.createCentralServer({ name: 'p', scope: 'project', transport: 'stdio', command: 'c' }),
      (error: unknown) => error instanceof AppError && error.code === 'MCP_WORKSPACE_REQUIRED',
    );

    const created = await providerMcpCentralService.createCentralServer({
      name: 'proj', scope: 'project', workspacePath: workspace, transport: 'stdio', command: 'c', providers: ['kiro', 'claude'],
    });
    const kiroProject = JSON.parse(await fs.readFile(path.join(workspace, '.kiro', 'settings', 'mcp.json'), 'utf8'));
    assert.equal(kiroProject.mcpServers.proj.command, 'c');
    assert.ok(created.server.targets.every((target) => target.state === 'in_sync'));

    await providerMcpService.upsertProviderMcpServer('codex', {
      name: 'native', scope: 'user', transport: 'http', url: 'https://example.com/n',
    });
    const imported = await providerMcpCentralService.importFromProvider({ provider: 'codex', name: 'native', scope: 'user' });
    assert.equal(imported.server.url, 'https://example.com/n');
    assert.deepEqual(imported.server.targets.map((target) => [target.provider, target.state]), [['codex', 'in_sync']]);
  });
});
