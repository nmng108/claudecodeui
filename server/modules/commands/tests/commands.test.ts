import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createCommandsRouter } from '../commands.routes.js';

/**
 * Stands in for `providerModelsService`. `resolveSessionModel` mirrors the real
 * precedence closely enough for the command handlers: a model recorded for the
 * session wins, otherwise the client's requested model, otherwise the catalog
 * default.
 */
function createModelsService(sessionModels: Record<string, string> = {}) {
  return {
    getProviderModels: async () => ({
      OPTIONS: [{ value: 'default', label: 'Default' }],
      DEFAULT: 'default',
    }),
    getCurrentActiveModel: async () => ({ model: 'default' }),
    setSessionModel: () => null,
    resolveSessionModel: async (
      provider: string,
      options: { sessionId?: string | null; requestedModel?: string | null } = {},
    ) => {
      const recorded = options.sessionId ? sessionModels[options.sessionId] : undefined;
      const model = recorded || options.requestedModel || 'default';
      return {
        provider,
        sessionId: options.sessionId ?? null,
        model,
        source: model === 'default' ? 'default' : 'session',
      };
    },
    resolveResumeModel: async () => undefined,
  };
}

type KiroStub = Parameters<typeof createCommandsRouter>[0]['kiro'];

const noKiro: KiroStub = {
  compact: async () => undefined,
  context: async () => ({ usagePercentage: null, sections: [] }),
};

/** Mounts the commands router on a throwaway server and runs `work` against its base URL. */
async function withCommandsServer<T>(
  work: (baseUrl: string) => Promise<T>,
  kiro: KiroStub = noKiro,
  sessionModels: Record<string, string> = {},
): Promise<T> {
  const router = createCommandsRouter({
    fileSystem: {
      readFile: async () => JSON.stringify({ name: 'claude-code-ui', version: '0.0.0-test' }),
      access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      readdir: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService(sessionModels) as never,
    kiro,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await work(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/commands`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function executeCommand(
  commandName: string,
  context: Record<string, unknown>,
  sessionModels: Record<string, string> = {},
  kiro: KiroStub = noKiro,
  args: string[] = [],
): Promise<Record<string, unknown>> {
  return withCommandsServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandName, context, args }),
    });
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
  }, kiro, sessionModels);
}

async function listCommands(provider: string | undefined): Promise<{ builtIn: Array<{ name: string }>; custom: unknown[] }> {
  return withCommandsServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/list`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: '/project', provider }),
    });
    assert.equal(response.status, 200);
    return await response.json() as { builtIn: Array<{ name: string }>; custom: unknown[] };
  });
}

test('models command returns models only for the active provider using injected catalog', async () => {
  const result = await executeCommand('/models', { provider: 'codex' });
  const data = result.data as Record<string, unknown>;
  assert.deepEqual(Object.keys(data.available as object), ['codex']);
});

test('models command falls back to claude for unsupported providers', async () => {
  const result = await executeCommand('/models', { provider: 'unknown-provider' });
  const data = result.data as { current: { provider: string } };
  assert.equal(data.current.provider, 'claude');
});

test('models command reports the model recorded for the session', async () => {
  const result = await executeCommand(
    '/models',
    { provider: 'claude', sessionId: 'session-1', model: 'sonnet' },
    { 'session-1': 'haiku' },
  );

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('models command reports the composer model for a chat with no session yet', async () => {
  const result = await executeCommand('/models', { provider: 'claude', model: 'haiku' });

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('cost and status commands report the same resolved model as /models', async () => {
  const context = { provider: 'claude', sessionId: 'session-1', model: 'sonnet' };
  const sessionModels = { 'session-1': 'haiku' };

  const cost = await executeCommand('/cost', context, sessionModels);
  const status = await executeCommand('/status', context, sessionModels);

  assert.equal((cost.data as { model: string }).model, 'haiku');
  assert.equal((status.data as { model: string }).model, 'haiku');
});

test('the command list is provider specific: Kiro gets its own set and no Claude-only commands', async () => {
  const kiro = (await listCommands('kiro')).builtIn.map((command) => command.name);
  const claude = (await listCommands('claude')).builtIn.map((command) => command.name);
  const unspecified = (await listCommands(undefined)).builtIn.map((command) => command.name);

  assert.ok(['/effort', '/plan', '/context', '/compact'].every((name) => kiro.includes(name)));
  assert.ok(!kiro.includes('/memory'), 'CLAUDE.md memory is a Claude command');
  assert.ok(claude.includes('/memory'));
  assert.ok(!claude.includes('/effort') && !claude.includes('/compact'));
  assert.deepEqual(unspecified, claude, 'a client that sends no provider keeps the Claude list');
});

test('Kiro help lists the Kiro commands, not Claude Code ones', async () => {
  const result = await executeCommand('/help', { provider: 'kiro' });
  const content = (result.data as { content: string }).content;
  assert.match(content, /# Kiro Commands/);
  assert.match(content, /\/compact/);
  assert.doesNotMatch(content, /CLAUDE\.md/);
});

test('/effort and /plan hand their action to the client', async () => {
  const effort = await executeCommand('/effort', { provider: 'kiro' }, {}, noKiro, ['HIGH']);
  assert.equal(effort.action, 'effort');
  assert.deepEqual(effort.data, { level: 'high' });
  assert.equal((await executeCommand('/plan', { provider: 'kiro' })).action, 'plan');
});

test('/compact and /context call Kiro with the session and report back', async () => {
  const calls: string[] = [];
  const kiro: KiroStub = {
    compact: async (sessionId: string | null | undefined) => { calls.push(`compact:${sessionId}`); },
    context: async (sessionId: string | null | undefined) => {
      calls.push(`context:${sessionId}`);
      return { usagePercentage: 12.5, sections: [{ name: 'contextFiles', tokens: 1200, percent: 3, items: 2 }] };
    },
  };

  const compact = await executeCommand('/compact', { provider: 'kiro', sessionId: 's1' }, {}, kiro);
  assert.equal(compact.action, 'notice');
  const context = await executeCommand('/context', { provider: 'kiro', sessionId: 's1' }, {}, kiro);
  assert.equal(context.action, 'notice');
  const text = (context.data as { message: string }).message;
  assert.match(text, /12\.5%/);
  assert.match(text, /Context files/);
  assert.deepEqual(calls, ['compact:s1', 'context:s1']);
});

test('Kiro-only commands are refused for other providers', async () => {
  await withCommandsServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandName: '/compact', context: { provider: 'claude' } }),
    });
    assert.equal(response.status, 500);
  });
});

test('/cost reports Kiro credits as credits', async () => {
  const result = await executeCommand('/cost', {
    provider: 'kiro',
    tokenUsage: { used: 0.42, unit: 'credit', contextPercentage: 8.9 },
  });
  const usage = (result.data as { tokenUsage: { used: number; unit?: string; contextPercentage?: number } }).tokenUsage;
  assert.equal(usage.unit, 'credit');
  assert.equal(usage.used, 0.42);
  assert.equal(usage.contextPercentage, 8.9);
});
