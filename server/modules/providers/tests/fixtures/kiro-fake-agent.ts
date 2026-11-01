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
import { writeFileSync } from 'node:fs';

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const scenario = process.env.KIRO_FAKE_AGENT_SCENARIO || 'stream';
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

  newSession() {
    return {
      sessionId: 'fake-session-1',
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
    return {
      sessionId: `fake-fork-${forkCounter}-of-${params.sessionId}-at-${(params._meta?.kiro as { messageId?: string } | undefined)?.messageId ?? 'end'}`,
      configOptions: configOptions as never,
    };
  },

  loadSession() {
    return {
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
      models: { currentModelId: 'fake-model', availableModels: [{ modelId: 'fake-model', name: 'Fake Model' }] },
    };
  },

  authenticate() {
    return {};
  },

  async prompt(params: { sessionId: string }) {
    const sessionId = params.sessionId;

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

    if (scenario === 'permission') {
      const outcome = await connection.requestPermission({
        sessionId,
        toolCall: { toolCallId: 'tool-1', title: 'Run a command', kind: 'execute', rawInput: { command: 'echo hi' } },
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
        ],
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
        return { stopReason: 'end_turn' };
      }
      await connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'permission allowed, ran it' } },
      });
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

  async extMethod() {
    return {};
  },

  async extNotification() {
    // The fixture never receives client->agent ext notifications in these tests.
  },
}), makeStream());

void cancelled;

if (scenario === 'echo-key-check') {
  const sink = process.env.KIRO_FAKE_AGENT_KEY_SINK;
  if (sink) {
    // Proves the key reached this child's own environment — the test asserts
    // this file's contents separately from every ACP message/log this
    // process produces, which must never contain it.
    writeFileSync(sink, process.env.KIRO_API_KEY || '', 'utf8');
  }
}
