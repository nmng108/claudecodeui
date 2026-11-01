import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { kiroRuntime } from '@/modules/providers/list/kiro/kiro-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

const FIXTURE_PATH = path.resolve('server/modules/providers/tests/fixtures/kiro-fake-agent.ts');
const SECRET = 'kiro-runtime-secret-QWERTY987';

type Sent = Record<string, any>;

/** Writes a `kiro-cli` stand-in that runs the fake ACP agent fixture, and points KIRO_CLI_PATH at it. */
async function installFakeCli(dir: string): Promise<string> {
  const nodeArgs = `"${process.execPath}" --experimental-strip-types --disable-warning=ExperimentalWarning "${FIXTURE_PATH}"`;
  if (process.platform === 'win32') {
    const cli = path.join(dir, 'kiro-cli.cmd');
    await writeFile(cli, `@echo off\r\n${nodeArgs} %*\r\n`);
    return cli;
  }
  const cli = path.join(dir, 'kiro-cli');
  await writeFile(cli, `#!/bin/sh\nexec ${nodeArgs} "$@"\n`);
  await chmod(cli, 0o755);
  return cli;
}

function makeContext(installed = true): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'fake-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'fake-model' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => installed,
  } as unknown as ProviderRuntimeContext;
}

async function withFakeCli<T>(
  scenario: string,
  run: (ctx: { dir: string; messages: Sent[]; ws: any }) => Promise<T>,
  env: Record<string, string> = {},
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kiro-runtime-'));
  const saved = {
    cli: process.env.KIRO_CLI_PATH,
    scenario: process.env.KIRO_FAKE_AGENT_SCENARIO,
    key: process.env.KIRO_API_KEY,
  };
  try {
    process.env.KIRO_CLI_PATH = await installFakeCli(dir);
    process.env.KIRO_FAKE_AGENT_SCENARIO = scenario;
    process.env.KIRO_API_KEY = SECRET;
    Object.assign(process.env, env);
    const messages: Sent[] = [];
    const ws = { isWebSocketWriter: true, send: (message: Sent) => messages.push(message) };
    return await run({ dir, messages, ws });
  } finally {
    for (const [name, value] of [
      ['KIRO_CLI_PATH', saved.cli],
      ['KIRO_FAKE_AGENT_SCENARIO', saved.scenario],
      ['KIRO_API_KEY', saved.key],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete process.env.KIRO_FAKE_AGENT_KEY_SINK;
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch {
      // best-effort temp cleanup on Windows
    }
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('Kiro runtime streams message, thought, tool call and result, then completes', async () => {
  await withFakeCli('stream', async ({ dir, messages, ws }) => {
    await kiroRuntime.run('hello', { cwd: dir, sessionId: 'app-1' }, ws, makeContext());

    const kinds = messages.map((m) => m.kind);
    assert.ok(kinds.includes('session_created'));
    assert.equal(messages.find((m) => m.kind === 'session_created')?.newSessionId, 'fake-session-1');
    assert.ok(kinds.includes('thinking'));
    assert.ok(messages.some((m) => m.kind === 'stream_delta' && m.content === 'Hello from the fake agent'));
    assert.ok(messages.some((m) => m.kind === 'tool_use' && m.toolId === 'tool-1' && m.toolName === 'List files'));
    // Only the finished tool produces a result, and it carries plain-text content.
    const results = messages.filter((m) => m.kind === 'tool_result' && m.toolId === 'tool-1');
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'file1.txt\nfile2.txt');
    assert.equal(results[0].isError, false);
    assert.ok(messages.filter((m) => m.kind === 'tool_use').every((m) => m.content === undefined));
    // Kiro reports credits and the context share, not tokens.
    const budgets = messages.filter((m) => m.kind === 'status' && m.text === 'token_budget');
    assert.equal(budgets.at(-1)?.tokenBudget.unit, 'credit');
    assert.equal(budgets.at(-1)?.tokenBudget.used, 0.25);
    assert.equal(budgets.at(-1)?.tokenBudget.contextPercentage, 12.5);
    assert.ok(messages.some((m) => m.kind === 'status' && m.stopReason === 'end_turn'));
    const complete = messages.filter((m) => m.kind === 'complete');
    assert.equal(complete.length, 1);
    assert.equal(complete[0].exitCode, 0);
    assert.ok(!messages.some((m) => m.kind === 'error'));
  });
});

for (const [label, allow, expected] of [['allow', true, 'permission allowed, ran it'], ['deny', false, 'permission denied']] as const) {
  test(`Kiro runtime permission round trip: ${label}`, async () => {
    await withFakeCli('permission', async ({ dir, messages, ws }) => {
      const run = kiroRuntime.run('run it', { cwd: dir, sessionId: 'app-2' }, ws, makeContext());
      await waitFor(() => messages.some((m) => m.kind === 'permission_request'));
      const request = messages.find((m) => m.kind === 'permission_request')!;
      assert.equal(request.requestId, 'tool-1');
      assert.equal((kiroRuntime.permissions!.listPending('fake-session-1') as unknown[]).length, 1);

      kiroRuntime.permissions!.resolve(request.requestId, { allow });
      await run;

      assert.ok(messages.some((m) => m.kind === 'stream_delta' && m.content === expected));
      assert.ok(messages.some((m) => m.kind === 'permission_resolved'));
      assert.equal(messages.filter((m) => m.kind === 'complete')[0].exitCode, 0);
    });
  });
}

test('Kiro runtime auto-approves under bypassPermissions', async () => {
  await withFakeCli('permission', async ({ dir, messages, ws }) => {
    await kiroRuntime.run('run it', { cwd: dir, sessionId: 'app-3', permissionMode: 'bypassPermissions' }, ws, makeContext());
    assert.ok(!messages.some((m) => m.kind === 'permission_request'));
    assert.ok(messages.some((m) => m.kind === 'stream_delta' && m.content === 'permission allowed, ran it'));
  });
});

test('Kiro runtime abort cancels the turn and leaves the terminal complete to the abort handler', async () => {
  await withFakeCli('cancel', async ({ dir, messages, ws }) => {
    const run = kiroRuntime.run('slow', { cwd: dir, sessionId: 'app-4' }, ws, makeContext());
    await waitFor(() => messages.some((m) => m.kind === 'stream_delta'));
    assert.equal(kiroRuntime.abort('app-4'), true);
    await run;
    assert.ok(!messages.some((m) => m.kind === 'complete'), 'abort handler owns the aborted complete');
    assert.equal(kiroRuntime.abort('app-4'), false, 'session is deregistered after the run');
  });
});

test('Kiro runtime reports a crash mid-turn as an error followed by a failed complete', async () => {
  await withFakeCli('crash-mid-turn', async ({ dir, messages, ws }) => {
    await kiroRuntime.run('boom', { cwd: dir, sessionId: 'app-5' }, ws, makeContext());
    assert.ok(messages.some((m) => m.kind === 'error'));
    const complete = messages.filter((m) => m.kind === 'complete');
    assert.equal(complete.length, 1);
    assert.equal(complete[0].exitCode, 1);
  });
});

test('Kiro runtime reports a missing binary as a not-installed error', async () => {
  await withFakeCli('stream', async ({ dir, messages, ws }) => {
    process.env.KIRO_CLI_PATH = path.join(dir, 'does-not-exist');
    await kiroRuntime.run('hi', { cwd: dir, sessionId: 'app-6' }, ws, makeContext(false));
    const error = messages.find((m) => m.kind === 'error');
    assert.match(error?.content ?? '', /not installed/i);
    assert.equal(messages.filter((m) => m.kind === 'complete')[0].exitCode, 1);
  });
});

test('Kiro runtime gives the child the API key but never emits it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kiro-runtime-sink-'));
  const sink = path.join(dir, 'sink.txt');
  try {
    await withFakeCli('echo-key-check', async ({ messages, ws }) => {
      await kiroRuntime.run('hi', { cwd: dir, sessionId: 'app-7' }, ws, makeContext());
      assert.equal(await readFile(sink, 'utf8'), SECRET);
      assert.ok(!JSON.stringify(messages).includes(SECRET));
    }, { KIRO_FAKE_AGENT_KEY_SINK: sink });
  } finally {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch {
      // best-effort
    }
  }
});
