/**
 * Fake `kiro-cli acp` agent for `kiro-acp.client.test.ts` and
 * `kiro-runtime.test.ts`.
 *
 * Spawned exactly like the real binary (ndjson over stdio) via
 * `KiroAcpClient`'s `command`/`commandArgs` test hooks: tests set
 * `command: process.execPath`, `commandArgs: [thisFile, '--loader', ...]`
 * (through `tsx`) so the fixture receives the same single `acp` argument the
 * real CLI does.
 *
 * Behavior is selected through `KIRO_FAKE_AGENT_SCENARIO` so each test can
 * spawn a differently-behaving "CLI" without separate fixture files:
 *
 * - `stream`           - initialize, new session, stream agent_message_chunk
 *                        + agent_thought_chunk + a tool_call/tool_call_update
 *                        pair + an ext notification, then resolve the prompt.
 * - `permission`       - requests permission mid-turn; replies according to
 *                        the client's decision (`end_turn` on allow,
 *                        `cancelled` stop reason when the client cancels).
 * - `cancel`           - never resolves the prompt on its own; waits for
 *                        `session/cancel` and then resolves with
 *                        `stopReason: 'cancelled'`.
 * - `crash-mid-turn`   - streams one chunk, then exits nonzero without
 *                        responding to the prompt.
 * - `echo-key-check`   - fails initialize (so the test ends fast) after
 *                        writing whatever it saw in `KIRO_API_KEY` to a file
 *                        at `KIRO_FAKE_AGENT_KEY_SINK` — this is the
 *                        "child env has the key" half of the key-leak test;
 *                        the other half (never emitted/logged) is asserted by
 *                        the test reading this process's own stdout/stderr
 *                        and the ACP messages instead.
 * - default (`stream`) when unset.
 */
import { Readable, Writable } from 'node:stream';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const defaultScenario = process.env.KIRO_FAKE_AGENT_SCENARIO || 'stream';
/** The real CLI is launched with `--agent-engine=v3`; without it this fake behaves like the v2 server. */
const isV3 = process.argv.includes('--agent-engine=v3');

/** Config options as the v3 server advertises them (shape recorded from kiro-cli 2.37.0). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const configOptions: Array<Record<string, any>> = [
  {
    type: 'select',
    id: 'model',
    name: 'Model',
    category: 'model',
    currentValue: 'fake-model',
    options: [
      { value: 'auto', name: 'Auto', _meta: { kiro: { rateMultiplier: 1, rateUnit: 'Credit', hasEffort: false } } },
      {
        value: 'fake-model',
        name: 'Fake Model',
        description: 'A model used by tests',
        _meta: {
          kiro: {
            rateMultiplier: 1.3,
            rateUnit: 'Credit',
            hasEffort: true,
            effortLevels: ['low', 'medium', 'high'],
            defaultEffortLevel: 'medium',
          },
        },
      },
    ],
  },
  {
    type: 'select',
    id: 'effortLevel',
    name: 'Effort',
    category: 'thought_level',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
];
let forkCounter = 0;

/**
 * Browser end-to-end mode (`KIRO_FAKE_AGENT_HOME_SESSIONS=1`): every session gets a
 * unique id and is written under `~/.kiro/sessions/<cwd hash>/<id>/` the way the
 * real CLI does, so the app's sidebar, history and delete paths see real files.
 * A prompt can pick its own scenario with a `[scenario:<name>]` marker.
 */
const writeHomeSessions = process.env.KIRO_FAKE_AGENT_HOME_SESSIONS === '1';
const sessionCwds = new Map<string, string>();

function sessionDirFor(cwd: string, sessionId: string): string {
  const hash = createHash('sha1').update(cwd.toLowerCase()).digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.kiro', 'sessions', hash, sessionId);
}

function createSessionOnDisk(sessionId: string, cwd: string): void {
  if (!writeHomeSessions) return;
  sessionCwds.set(sessionId, cwd);
  const dir = sessionDirFor(cwd, sessionId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    schemaVersion: '1.0.0',
    id: sessionId,
    title: 'New Session',
    agentMode: 'vibe',
    workspacePaths: [cwd],
    rootPaths: [cwd],
    createdAt: now,
    lastModifiedAt: now,
    modelId: 'fake-model',
    status: 'idle',
  }, null, 2));
}

function appendTranscript(sessionId: string, lines: Array<Record<string, unknown>>): void {
  const cwd = sessionCwds.get(sessionId);
  if (!writeHomeSessions || !cwd) return;
  const dir = sessionDirFor(cwd, sessionId);
  const stamp = new Date().toISOString();
  appendFileSync(
    path.join(dir, 'messages.jsonl'),
    lines.map((payload) => JSON.stringify({ id: (payload.id as string) ?? randomUUID(), timestamp: stamp, payload })).join('\n') + '\n',
  );
}

/** Copies a session up to and including the turn of `messageId` (all of it without one). */
function forkOnDisk(sourceId: string, forkId: string, messageId: string | undefined): void {
  const cwd = sessionCwds.get(sourceId);
  if (!writeHomeSessions || !cwd) return;
  const from = sessionDirFor(cwd, sourceId);
  createSessionOnDisk(forkId, cwd);
  const source = existsSync(path.join(from, 'messages.jsonl'))
    ? readFileSync(path.join(from, 'messages.jsonl'), 'utf8').split('\n').filter(Boolean)
    : [];
  const kept: string[] = [];
  let passedAnchor = false;
  for (const line of source) {
    const row = JSON.parse(line) as { id: string; payload: { type: string } };
    if (passedAnchor && row.payload.type === 'user') break;
    kept.push(line);
    if (messageId && row.id === messageId) passedAnchor = true;
  }
  writeFileSync(path.join(sessionDirFor(cwd, forkId), 'messages.jsonl'), kept.join('\n') + (kept.length ? '\n' : ''));
}

let pendingCancel: (() => void) | null = null;
let cancelled = false;

function makeStream() {
  return ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const connection = new AgentSideConnection((_client) => ({
  initialize() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        ...(isV3 ? { sessionCapabilities: { list: {}, close: {}, fork: { _meta: { kiro: { messageId: true } } } } } : {}),
      },
      authMethods: [],
    };
  },

  newSession(params: { cwd: string }) {
    const sessionId = writeHomeSessions ? `sess_${randomUUID()}` : 'fake-session-1';
    createSessionOnDisk(sessionId, params.cwd);
    return {
      sessionId,
      modes: {
        currentModeId: 'default',
        availableModes: [{ id: 'default', name: 'Default' }],
      },
      ...(isV3
        ? { configOptions: configOptions as never }
        : {
            models: {
              currentModelId: 'fake-model',
              availableModels: [{ modelId: 'fake-model', name: 'Fake Model' }],
            },
          }),
    };
  },

  setSessionConfigOption(params: { configId: string; value: string | boolean }) {
    return {
      configOptions: configOptions.map((option) =>
        option.id === params.configId ? { ...option, currentValue: params.value } : option) as never,
    };
  },

  unstable_forkSession(params: { sessionId: string; _meta?: { [key: string]: unknown } | null }) {
    forkCounter += 1;
    const messageId = (params._meta?.kiro as { messageId?: string } | undefined)?.messageId;
    const forkId = writeHomeSessions
      ? `sess_${randomUUID()}`
      : `fake-fork-${forkCounter}-of-${params.sessionId}-at-${messageId ?? 'end'}`;
    forkOnDisk(params.sessionId, forkId, messageId);
    return {
      sessionId: forkId,
      configOptions: configOptions as never,
    };
  },

  loadSession(params: { sessionId: string; cwd: string }) {
    // A resumed session lives on disk already; remember where for later appends and forks.
    if (writeHomeSessions) sessionCwds.set(params.sessionId, params.cwd);
    return {
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      models: { currentModelId: 'fake-model', availableModels: [{ modelId: 'fake-model', name: 'Fake Model' }] },
    };
  },

  authenticate() {
    return {};
  },

  async prompt(params: { sessionId: string; prompt?: Array<{ type: string; text?: string }> }) {
    const sessionId = params.sessionId;
    const promptText = params.prompt?.find((block) => block.type === 'text')?.text ?? '';
    const scenario = /\[scenario:([\w-]+)\]/.exec(promptText)?.[1] ?? defaultScenario;
    const userLineId = randomUUID();
    appendTranscript(sessionId, [{ id: userLineId, type: 'user', content: promptText }]);

    if (scenario === 'crash-mid-turn') {
      await connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial output before crash' } },
      });
      // Exit without ever responding to this prompt call; the client must
      // treat this as a crash, not a hang.
      process.exit(7);
    }

    if (scenario === 'cancel') {
      await connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working...' } },
      });
      await new Promise<void>((resolve) => {
        pendingCancel = resolve;
      });
      return { stopReason: 'cancelled' };
    }

    if (scenario === 'permission' || scenario === 'permission-read') {
      const outcome = await connection.requestPermission({
        sessionId,
        toolCall: { toolCallId: 'tool-1', title: 'Run a command', kind: 'execute', rawInput: { command: 'echo hi' } },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
        // v3 labels each request with what it touches; the app decides auto-approval from it.
        _meta: { kiro: { consent: { capability: scenario === 'permission-read' ? 'read' : 'shell' } } },
      } as never);

      const selected = (outcome as { outcome: { outcome: string; optionId?: string } }).outcome;
      if (selected.outcome === 'cancelled') {
        return { stopReason: 'cancelled' };
      }
      if (selected.optionId === 'reject_once') {
        await connection.sessionUpdate({
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'permission denied' } },
        });
        appendTranscript(sessionId, [{ type: 'assistant', operationType: 'Say', content: 'permission denied' }]);
        return { stopReason: 'end_turn' };
      }
      await connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'permission allowed, ran it' } },
      });
      appendTranscript(sessionId, [
        { type: 'assistant', operationType: 'Say', content: 'permission allowed, ran it' },
        { type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage: 0.1 }] },
      ]);
      return { stopReason: 'end_turn' };
    }

    if (scenario === 'echo-key-check') {
      // Never reached: initialize() does not fail in this scenario anymore —
      // kept as a no-op branch so an unexpected prompt call after an
      // intentionally-failed initialize is still well-defined.
      return { stopReason: 'end_turn' };
    }

    // Default: 'stream' — the full event-kind tour the runtime test asserts
    // normalizes correctly: thought, message text, a tool call + its update,
    // and a known Kiro ext notification.
    await connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about it' } },
    });
    await connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello from the fake agent' } },
    });
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'List files',
        kind: 'execute',
        status: isV3 ? 'pending' : 'in_progress',
        rawInput: { command: 'ls' },
      },
    });
    if (isV3) {
      // v3 sends progress updates that carry neither output nor content.
      await connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'in_progress' },
      });
    }
    await connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        status: 'completed',
        rawOutput: 'file1.txt\nfile2.txt',
      },
    });
    if (isV3) {
      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: { kiro: { kind: 'context_usage', usagePercentage: 12.5, contextUsage: { usagePercentage: 12.5 } } },
        },
      });
      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: {
            kiro: {
              kind: 'turn_completion',
              status: 'success',
              promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage: 0.25 }],
            },
          },
        },
      });
    }
    await connection.extNotification('_kiro.dev/metadata', { contextUsagePercentage: 12, turnDurationMs: 42 });
    await connection.extNotification('_kiro.dev/some_unknown_notification', { ignored: true });
    appendTranscript(sessionId, [
      { type: 'assistant', operationType: 'Say', content: 'Hello from the fake agent' },
      { type: 'tool_call', toolCallId: 'tool-1', toolName: 'List files', args: { command: 'ls' } },
      { type: 'tool_result', toolCallId: 'tool-1', content: 'file1.txt\nfile2.txt', success: true },
      { type: 'usage_summary', promptTurnSummaries: [{ unit: 'credit', unitPlural: 'credits', usage: 0.25 }] },
    ]);

    return { stopReason: 'end_turn' };
  },

  cancel() {
    cancelled = true;
    if (pendingCancel) {
      pendingCancel();
      pendingCancel = null;
    }
    return Promise.resolve();
  },

  async extMethod(method: string, params: Record<string, unknown>) {
    if (method === '_kiro/session/compact') {
      return { success: true };
    }
    if (method === '_kiro/session/context') {
      // The real server answers with null and reports the numbers as an update.
      await connection.sessionUpdate({
        sessionId: params.sessionId as string,
        update: {
          sessionUpdate: 'session_info_update',
          _meta: {
            kiro: {
              contextUsage: { usagePercentage: 12.5 },
              breakdown: {
                contextFiles: { tokens: 1200, percent: 3, items: [{ name: 'a' }, { name: 'b' }] },
                tools: { tokens: 5300, percent: 0.5, items: [] },
              },
            },
          },
        },
      } as never);
      return null as never;
    }
    return {};
  },

  async extNotification() {
    // The fixture never receives client->agent ext notifications in these tests.
  },
}), makeStream());

void cancelled;

if (defaultScenario === 'echo-key-check') {
  const sink = process.env.KIRO_FAKE_AGENT_KEY_SINK;
  if (sink) {
    // Proves the key reached this child's own environment — the test asserts
    // this file's contents separately from every ACP message/log this
    // process produces, which must never contain it.
    writeFileSync(sink, process.env.KIRO_API_KEY || '', 'utf8');
  }
}
