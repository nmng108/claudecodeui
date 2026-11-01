import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { KiroAcpClient } from '@/modules/providers/list/kiro/kiro-acp.client.js';

/**
 * Drives `KiroAcpClient` against the fake agent fixture
 * (`fixtures/kiro-fake-agent.ts`), run directly by `process.execPath` with
 * Node's own `--experimental-strip-types` — `command`/`commandArgs` exist on
 * `KiroAcpClient` only for this purpose; production always resolves a bare
 * `kiro-cli` (or `KIRO_CLI_PATH`) with no extra args. (`tsx` was tried first,
 * but its tsconfig auto-discovery resolves against the *child's* `cwd` —
 * which production correctly sets to the project directory, e.g. a test's
 * temp dir, not this repo — and fails there; Node's native stripping has no
 * such dependency.)
 */
const FIXTURE_PATH = path.resolve('server/modules/providers/tests/fixtures/kiro-fake-agent.ts');
const SILENT_FIXTURE_PATH = path.resolve('server/modules/providers/tests/fixtures/kiro-fake-agent-silent.ts');
const NODE_TYPE_STRIP_ARGS = ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'];

function makeClient(overrides: {
  scenario?: string;
  cwd: string;
  apiKey?: string;
  events?: ConstructorParameters<typeof KiroAcpClient>[0]['events'];
  extraEnv?: Record<string, string>;
  engine?: 'v2' | 'v3';
}): KiroAcpClient {
  if (overrides.scenario || overrides.extraEnv) {
    Object.assign(process.env, {
      KIRO_FAKE_AGENT_SCENARIO: overrides.scenario,
      ...overrides.extraEnv,
    });
  }
  return new KiroAcpClient({
    cwd: overrides.cwd,
    apiKey: overrides.apiKey,
    command: process.execPath,
    commandArgs: [...NODE_TYPE_STRIP_ARGS, FIXTURE_PATH],
    initTimeoutMs: 5000,
    events: overrides.events,
    // Most cases run the default (v3) engine; v2-specific ones pass engine: 'v2'.
    engine: overrides.engine,
  });
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kiro-acp-client-'));
  try {
    return await run(dir);
  } finally {
    try {
      await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch {
      // Windows can keep a just-killed child's cwd locked briefly; temp cleanup is best-effort.
    }
  }
}

test('v2: connects, starts a session, and streams a full prompt turn', async () => {
  await withTempDir(async (cwd) => {
    const events: unknown[] = [];
    const client = makeClient({
      scenario: 'stream',
      cwd,
      engine: 'v2',
      events: {
        onSessionUpdate: (event) => events.push(event),
        onExtNotification: (event) => events.push(event),
      },
    });

    const { initializeResponse } = await client.connect();
    assert.ok(initializeResponse.agentCapabilities, 'initialize response capabilities are exposed');

    const { sessionId, raw } = await client.startSession();
    assert.equal(sessionId, 'fake-session-1');
    assert.ok(raw.modes, 'session/new response exposes modes for T5/T6');
    assert.ok(raw.models, 'session/new response exposes models for T5/T6');

    const { stopReason } = await client.prompt('hi');
    assert.equal(stopReason, 'end_turn');

    // Ext notifications are dispatched independently of the prompt response, so wait for them.
    for (let i = 0; i < 40 && events.length < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 100)); // room for a (wrongly) forwarded unknown one

    const kinds = events.map((event) => (event as { type?: string; method?: string }).type
      ?? (event as { method?: string }).method);
    assert.deepEqual(kinds, [
      'agent_thought_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      '_kiro.dev/metadata',
    ]);

    await client.close();
  });
});

test('permission request is bridged and the allow decision reaches the agent', async () => {
  await withTempDir(async (cwd) => {
    const updates: string[] = [];
    let permissionSeen: { title: string; options: Array<{ optionId: string }> } | null = null;

    const client = makeClient({
      scenario: 'permission',
      cwd,
      events: {
        onSessionUpdate: (event) => {
          if (event.type === 'agent_message_chunk') {
            updates.push(event.text);
          }
        },
        onPermissionRequest: async (event) => {
          permissionSeen = { title: event.title, options: event.options };
          return { optionId: 'allow_once' };
        },
      },
    });

    await client.connect();
    await client.startSession();
    const { stopReason } = await client.prompt('run the command');

    assert.equal(stopReason, 'end_turn');
    assert.ok(permissionSeen, 'the permission bridge was invoked');
    assert.equal((permissionSeen as { title: string }).title, 'Run a command');
    assert.deepEqual(updates, ['permission allowed, ran it']);

    await client.close();
  });
});

test('permission request denied reaches the agent as a rejection, not a hang', async () => {
  await withTempDir(async (cwd) => {
    const updates: string[] = [];
    const client = makeClient({
      scenario: 'permission',
      cwd,
      events: {
        onSessionUpdate: (event) => {
          if (event.type === 'agent_message_chunk') {
            updates.push(event.text);
          }
        },
        onPermissionRequest: async () => ({ optionId: 'reject_once' }),
      },
    });

    await client.connect();
    await client.startSession();
    const { stopReason } = await client.prompt('run the command');

    assert.equal(stopReason, 'end_turn');
    assert.deepEqual(updates, ['permission denied']);

    await client.close();
  });
});

test('abort cancels a pending permission request as well as the turn', async () => {
  await withTempDir(async (cwd) => {
    let resolvePermission: ((decision: { cancelled: true }) => void) | null = null;
    const client = makeClient({
      scenario: 'permission',
      cwd,
      events: {
        onPermissionRequest: () => new Promise((resolve) => {
          resolvePermission = resolve;
        }),
      },
    });

    await client.connect();
    await client.startSession();
    const promptPromise = client.prompt('run the command');

    // Give the agent time to issue session/request_permission before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(client.listPendingPermissionIds().length, 1);

    await client.cancel();
    void resolvePermission;

    const { stopReason } = await promptPromise;
    assert.equal(stopReason, 'cancelled');
    assert.equal(client.listPendingPermissionIds().length, 0);

    await client.close();
  });
});

test('cancel makes an in-flight prompt resolve with stopReason cancelled', async () => {
  await withTempDir(async (cwd) => {
    const client = makeClient({ scenario: 'cancel', cwd });

    await client.connect();
    await client.startSession();
    const promptPromise = client.prompt('do something slow');

    await new Promise((resolve) => setTimeout(resolve, 200));
    await client.cancel();

    const { stopReason } = await promptPromise;
    assert.equal(stopReason, 'cancelled');

    await client.close();
  });
});

test('a crash mid-turn is reported via onCrash without hanging the caller', async () => {
  await withTempDir(async (cwd) => {
    let crashInfo: { code: number | null; signal: string | null; stderrTail: string } | null = null;
    const streamed: string[] = [];
    const client = makeClient({
      scenario: 'crash-mid-turn',
      cwd,
      events: {
        onSessionUpdate: (event) => {
          if (event.type === 'agent_message_chunk') {
            streamed.push(event.text);
          }
        },
        onCrash: (info) => {
          crashInfo = info;
        },
      },
    });

    await client.connect();
    await client.startSession();

    await assert.rejects(client.prompt('trigger a crash'));

    assert.deepEqual(streamed, ['partial output before crash']);
    assert.ok(crashInfo, 'onCrash fired');
    const crash = crashInfo as { code: number | null; signal: string | null; stderrTail: string };
    assert.equal(crash.code, 7);
    assert.ok(!crash.stderrTail.includes('KIRO_API_KEY'), 'crash report never names the key env var');

    await client.close();
  });
});

test('a missing kiro-cli binary surfaces a clear, specific error', async () => {
  await withTempDir(async (cwd) => {
    const client = new KiroAcpClient({
      cwd,
      apiKey: 'test-key',
      command: path.join(cwd, 'this-binary-does-not-exist'),
      initTimeoutMs: 2000,
    });

    await assert.rejects(client.connect(), (error: unknown) => {
      assert.match((error as Error).message, /not found/i);
      return true;
    });
  });
});

test('initialize that never responds times out with a clear error, not a hang', async () => {
  await withTempDir(async (cwd) => {
    Object.assign(process.env, { KIRO_FAKE_AGENT_SCENARIO: 'stream' });
    const client = new KiroAcpClient({
      cwd,
      apiKey: 'test-key',
      command: process.execPath,
      // The fixture expects its own path as an arg; pointing at a script with
      // no ACP agent listening at all exercises the same "nothing answers
      // initialize" path without adding a second fixture file.
      commandArgs: [...NODE_TYPE_STRIP_ARGS, SILENT_FIXTURE_PATH],
      initTimeoutMs: 300,
    });

    await assert.rejects(client.connect(), (error: unknown) => {
      assert.match((error as Error).message, /did not respond/i);
      return true;
    });

    await client.close();
  });
});

test('the API key is injected into the child env and never appears in any emitted event', async () => {
  await withTempDir(async (cwd) => {
    const sinkPath = path.join(cwd, 'key-sink.txt');
    const secret = 'kiro-secret-abc123XYZ';
    const events: unknown[] = [];

    const client = makeClient({
      scenario: 'echo-key-check',
      cwd,
      apiKey: secret,
      extraEnv: { KIRO_FAKE_AGENT_KEY_SINK: sinkPath },
      events: {
        onSessionUpdate: (event) => events.push(event),
        onExtNotification: (event) => events.push(event),
        onCrash: (info) => events.push(info),
      },
    });

    await client.connect();
    await client.startSession();
    await client.prompt('anything');
    await client.close();

    const sunk = await readFile(sinkPath, 'utf8');
    assert.equal(sunk, secret, 'the child process itself received the key via its env');

    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(secret), 'no emitted client-visible event contains the key');
  });
});

test.after(() => {
  delete process.env.KIRO_FAKE_AGENT_SCENARIO;
  delete process.env.KIRO_FAKE_AGENT_KEY_SINK;
});

test('v2: setModel is accepted and setEffort runs its own turn without reaching the chat', async () => {
  await withTempDir(async (cwd) => {
    const events: unknown[] = [];
    const client = makeClient({
      scenario: 'stream',
      cwd,
      engine: 'v2',
      events: { onSessionUpdate: (event) => events.push(event) },
    });
    try {
      await client.connect();
      await client.startSession();

      await client.setModel('fake-model');
      await client.setEffort('high');
      assert.equal(events.length, 0, 'the /effort turn is muted');

      await client.prompt('hello');
      assert.ok(events.length > 0, 'updates flow again after the effort turn');

      await assert.rejects(() => client.setEffort('high; rm -rf'), /Invalid Kiro effort level/);
    } finally {
      await client.close();
    }
  });
});

test('v3: advertises forking and exposes the model option on session/new', async () => {
  await withTempDir(async (cwd) => {
    const client = makeClient({ scenario: 'stream', cwd, engine: 'v3' });
    try {
      assert.equal(client.getEngine(), 'v3');
      await client.connect();
      assert.equal(client.supportsFork(), true);
      const { raw } = await client.startSession();
      const options = raw.configOptions as Array<{ id: string }>;
      assert.deepEqual(options.map((option) => option.id), ['model', 'effortLevel']);
    } finally {
      await client.close();
    }
  });
});

test('v3: maps session_info_update and keeps tool progress updates', async () => {
  await withTempDir(async (cwd) => {
    const events: Array<{ type: string; kind?: string; status?: string }> = [];
    const client = makeClient({
      scenario: 'stream',
      cwd,
      engine: 'v3',
      events: { onSessionUpdate: (event) => events.push(event as { type: string }) },
    });
    try {
      await client.connect();
      await client.startSession();
      await client.prompt('hi');
      const describe = (event: { type: string; kind?: string; status?: string }) =>
        event.type === 'session_info' ? `session_info:${event.kind}` : `${event.type}:${event.status ?? ''}`;
      assert.deepEqual(events.map(describe), [
        'agent_thought_chunk:',
        'agent_message_chunk:',
        'tool_call:pending',
        'tool_call_update:in_progress',
        'tool_call_update:completed',
        'session_info:context_usage',
        'session_info:turn_completion',
      ]);
    } finally {
      await client.close();
    }
  });
});
test('v3: setModel and setEffort use config options and do not run a turn', async () => {
  await withTempDir(async (cwd) => {
    const events: unknown[] = [];
    const client = makeClient({ scenario: 'stream', cwd, engine: 'v3', events: { onSessionUpdate: (event) => events.push(event) } });
    try {
      await client.connect();
      await client.startSession();
      await client.setModel('fake-model');
      await client.setEffort('high');
      assert.equal(events.length, 0);
      const options = await client.setConfigOption('effortLevel', 'low');
      assert.equal((options as Array<{ id: string; currentValue: string }>).find((o) => o.id === 'effortLevel')?.currentValue, 'low');
      await assert.rejects(() => client.setEffort('high; rm -rf'), /Invalid Kiro effort level/);
    } finally {
      await client.close();
    }
  });
});

test('v3: forkSession sends the message id under _meta.kiro', async () => {
  await withTempDir(async (cwd) => {
    const client = makeClient({ scenario: 'stream', cwd, engine: 'v3' });
    try {
      await client.connect();
      await client.startSession();
      assert.match((await client.forkSession({ messageId: 'msg-1' })).sessionId, /at-msg-1$/);
      assert.match((await client.forkSession()).sessionId, /at-end$/);
    } finally {
      await client.close();
    }
  });
});

test('v2: forking is not offered', async () => {
  await withTempDir(async (cwd) => {
    const client = makeClient({ scenario: 'stream', cwd, engine: 'v2' });
    try {
      await client.connect();
      await client.startSession();
      assert.equal(client.supportsFork(), false);
      await assert.rejects(() => client.forkSession(), /does not support forking/);
    } finally {
      await client.close();
    }
  });
});
