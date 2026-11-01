/**
 * Kiro ACP client.
 *
 * Spawns `kiro-cli acp` (newline-delimited JSON-RPC over stdio, per
 * `docs/kiro/acp-protocol` notes and the kiro-ui reference implementation —
 * `server.ts` / `src/server/ws-handler.ts` in that repo) and wraps the
 * connection behind a small, test-friendly surface: `initialize`, start or
 * resume a session, send a prompt, cancel, and bridge `session/request_permission`
 * to a caller-supplied resolver.
 *
 * The API key never touches `process.env` or a log line: it is injected only
 * into the spawned child's own environment object.
 */
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import crossSpawn from 'cross-spawn';

import { resolveKiroApiKey } from '@/modules/providers/list/kiro/kiro-api-key.store.js';
import { AppError } from '@/shared/utils.js';

/** Override for tests and non-standard installs; documented in docs/kiro/design.md. */
const KIRO_CLI_PATH_ENV = 'KIRO_CLI_PATH';
/** How long `initialize` may take before the child is treated as unresponsive. */
const DEFAULT_INIT_TIMEOUT_MS = 20_000;
/** Grace period between SIGTERM and SIGKILL when tearing a session down. */
const KILL_GRACE_MS = 3000;
/** Env var that selects the CLI engine; anything but `v2` means v3. */
const KIRO_ENGINE_ENV = 'CLOUDCLI_KIRO_ENGINE';

/**
 * Which `kiro-cli acp` server generation to speak to. V3 is the default; v2 is
 * kept as an opt-out (`CLOUDCLI_KIRO_ENGINE=v2`) for installs that predate it.
 * The two differ in launch flags, model/effort selection and session updates.
 */
export type KiroEngine = 'v2' | 'v3';

export function resolveKiroEngine(): KiroEngine {
  return process.env[KIRO_ENGINE_ENV]?.trim().toLowerCase() === 'v2' ? 'v2' : 'v3';
}

export type KiroPermissionOption = { optionId: string; name: string; kind: string };

export type KiroPermissionRequestEvent = {
  requestId: string;
  toolCallId: string;
  title: string;
  kind: string | undefined;
  options: KiroPermissionOption[];
  rawInput: unknown;
};

export type KiroSessionUpdateEvent =
  | { type: 'agent_message_chunk'; text: string; isThought?: boolean }
  | { type: 'agent_thought_chunk'; text: string }
  | { type: 'user_message_chunk'; text: string }
  | {
      type: 'tool_call';
      toolCallId: string;
      title: string;
      kind?: string;
      status?: string;
      content?: unknown;
      rawInput?: unknown;
      locations?: unknown;
    }
  | {
      type: 'tool_call_update';
      toolCallId: string;
      title?: string;
      status?: string;
      content?: unknown;
      rawOutput?: unknown;
      locations?: unknown;
    }
  | { type: 'plan'; entries: unknown[] }
  /** v3 `session_info_update`: `kind` is `_meta.kiro.kind` (context_usage, turn_completion, ...). */
  | { type: 'session_info'; kind: string; title?: string; meta: Record<string, unknown> }
  /** v3 `config_option_update`: the full, current list of config options. */
  | { type: 'config_option_update'; configOptions: unknown[] }  | { type: 'tool_call_chunk'; toolCallId?: string; title?: string; kind?: string; content?: unknown }
  | { type: 'retry_warning'; attempt?: number; maxAttempts?: number; delaySecs?: number; message?: string }
  | { type: 'unknown'; sessionUpdate: string; raw: unknown };

export type KiroExtNotificationEvent = {
  method: string;
  params: Record<string, unknown>;
};

export type KiroAcpClientEvents = {
  onSessionUpdate?(event: KiroSessionUpdateEvent): void;
  onExtNotification?(event: KiroExtNotificationEvent): void;
  /** Resolves the user's decision; `null`/`undefined` is treated as cancelled. */
  onPermissionRequest?(
    event: KiroPermissionRequestEvent,
  ): Promise<{ optionId: string } | { cancelled: true } | null | undefined>;
  /** The child exited or the pipe closed without the client tearing it down itself. */
  onCrash?(info: { code: number | null; signal: string | null; stderrTail: string }): void;
};

export type KiroAcpClientOptions = {
  /** Project working directory for the spawned `kiro-cli acp` process. */
  cwd: string;
  /** Overrides environment-based resolution; tests call this directly. */
  apiKey?: string | undefined;
  /** Overrides `probeKiroCliCommand()`; tests point this at the fake agent fixture. */
  command?: string;
  /**
   * Extra arguments spawned before the fixed `acp` subcommand. Empty in
   * production (`kiro-cli acp`); tests point `command` at `process.execPath`
   * and use this to insert the fake agent fixture's path (`node fixture.js acp`)
   * without changing the real `kiro-cli acp` invocation shape.
   */
  commandArgs?: string[];
  initTimeoutMs?: number;
  events?: KiroAcpClientEvents;
  /** Defaults to esolveKiroEngine(). */
  engine?: KiroEngine;
};

/**
 * Resolves the `kiro-cli` invocation. `KIRO_CLI_PATH` (documented in
 * docs/kiro/design.md) lets tests and non-PATH installs point at a specific
 * binary — including the ndjson fake-agent fixture used by this task's
 * tests — the same way other runtimes expose a CLI-path override
 * (`CLAUDE_CLI_PATH`, etc.). Falls back to the bare `kiro-cli` command, which
 * cross-spawn resolves from PATH (and `.cmd` shims on Windows).
 */
export function resolveKiroCliCommand(): string {
  const override = process.env[KIRO_CLI_PATH_ENV];
  return override && override.trim() ? override.trim() : 'kiro-cli';
}

function toSessionUpdateEvent(update: Record<string, unknown>): KiroSessionUpdateEvent {
  const kind = update.sessionUpdate as string;
  switch (kind) {
    case 'agent_message_chunk': {
      const content = update.content as Record<string, unknown> | undefined;
      return {
        type: 'agent_message_chunk',
        text: (content?.text as string) || '',
        isThought: content?.type === 'thinking',
      };
    }
    case 'agent_thought_chunk': {
      const content = update.content as Record<string, unknown> | undefined;
      return { type: 'agent_thought_chunk', text: (content?.text as string) || (update.text as string) || '' };
    }
    case 'user_message_chunk': {
      const content = update.content as Record<string, unknown> | undefined;
      return { type: 'user_message_chunk', text: (content?.text as string) || '' };
    }
    case 'tool_call':
      return {
        type: 'tool_call',
        toolCallId: update.toolCallId as string,
        title: (update.title as string) || '',
        kind: update.kind as string | undefined,
        status: update.status as string | undefined,
        content: update.content,
        rawInput: update.rawInput,
        locations: update.locations,
      };
    case 'tool_call_update':
      return {
        type: 'tool_call_update',
        toolCallId: update.toolCallId as string,
        title: update.title as string | undefined,
        status: update.status as string | undefined,
        content: update.content,
        rawOutput: update.rawOutput,
        locations: update.locations,
      };
    case 'session_info_update': {
      const meta = ((update._meta as Record<string, unknown> | undefined)?.kiro ?? {}) as Record<string, unknown>;
      return {
        type: 'session_info',
        kind: typeof meta.kind === 'string' ? meta.kind : '',
        ...(typeof update.title === 'string' ? { title: update.title } : {}),
        meta,
      };
    }
    case 'config_option_update':
      return {
        type: 'config_option_update',
        configOptions: Array.isArray(update.configOptions) ? update.configOptions : [],
      };
    case 'plan':
      return { type: 'plan', entries: (update.entries as unknown[]) || [] };
    case 'tool_call_chunk':
      return {
        type: 'tool_call_chunk',
        toolCallId: update.toolCallId as string | undefined,
        title: update.title as string | undefined,
        kind: update.kind as string | undefined,
        content: update.content,
      };
    case 'retry_warning':
      return {
        type: 'retry_warning',
        attempt: update.attempt as number | undefined,
        maxAttempts: update.maxAttempts as number | undefined,
        delaySecs: update.delaySecs as number | undefined,
        message: update.message as string | undefined,
      };
    default:
      return { type: 'unknown', sessionUpdate: kind, raw: update };
  }
}

/** Ext notification methods this task's client actively interprets; everything else is just forwarded/logged. */
const KNOWN_EXT_NOTIFICATIONS = new Set([
  '_kiro.dev/metadata',
  '_kiro.dev/commands/available',
  '_kiro.dev/session/list_update',
]);

/**
 * One live `kiro-cli acp` child process and its ACP connection.
 *
 * Owns exactly one ACP session for its lifetime: callers that need a second
 * session create a second client. `newSession`/`loadSession` are exposed
 * separately from the constructor so a caller can inspect the spawn/`initialize`
 * outcome before committing to a session.
 */
export class KiroAcpClient {
  private readonly cwd: string;
  private readonly apiKeyOverride: string | undefined;
  private readonly command: string;
  private readonly commandArgs: string[];
  private readonly initTimeoutMs: number;
  private readonly events: KiroAcpClientEvents;
  private readonly engine: KiroEngine;

  private child: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private sessionId: string | null = null;
  private stderrTail = '';
  private initializeResponse: Record<string, unknown> | null = null;
  private closed = false;
  private crashNotified = false;
  /** While true, session updates are dropped (used for the internal `/effort` turn). */
  private muted = false;
  private spawnFailure: AppError | null = null;
  private readonly pendingPermissions = new Map<
    string,
    (decision: { optionId: string } | { cancelled: true }) => void
  >();

  constructor(options: KiroAcpClientOptions) {
    this.cwd = options.cwd;
    this.apiKeyOverride = options.apiKey;
    this.command = options.command ?? resolveKiroCliCommand();
    this.commandArgs = options.commandArgs ?? [];
    this.initTimeoutMs = options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.events = options.events ?? {};
    this.engine = options.engine ?? resolveKiroEngine();
  }

  /** The engine this client speaks. */
  getEngine(): KiroEngine {
    return this.engine;
  }

  /** The initialize response, once connected. */
  getInitializeResponse(): Record<string, unknown> | null {
    return this.initializeResponse;
  }

  /** True when the agent advertised session/fork during initialize. */
  supportsFork(): boolean {
    const caps = this.initializeResponse?.agentCapabilities as { sessionCapabilities?: { fork?: unknown } } | undefined;
    return Boolean(caps?.sessionCapabilities?.fork);
  }

  /** The ACP session id, once a session has been created or loaded. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** True once the child has exited or the connection has been torn down. */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Spawns `kiro-cli acp` and completes the ACP `initialize` handshake.
   * Does not create a session; call `startSession` or `resumeSession` next.
   */
  async connect(): Promise<{ initializeResponse: Record<string, unknown> }> {
    const apiKey = this.apiKeyOverride ?? (await resolveKiroApiKey());

    const child = crossSpawn(this.command, [...this.commandArgs, 'acp', ...(this.engine === 'v3' ? ['--agent-engine=v3'] : [])], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // The key is layered onto a copy of the host env for this child only;
      // it is never assigned to process.env and nothing here logs it.
      env: apiKey ? { ...process.env, KIRO_API_KEY: apiKey } : { ...process.env },
    });
    this.child = child;

    // `spawn`'s 'error' event (ENOENT, EACCES, ...) fires asynchronously —
    // often not until the next tick — so a synchronous check right after
    // `crossSpawn` returns would almost always miss it and fall through to
    // `initialize()`, which then hangs against a child that never started
    // until the stream itself reports closed with a useless generic error.
    // Racing a one-time listener against the rest of the handshake below
    // means a spawn failure is reported with its own clear error no matter
    // when Node gets around to emitting it.
    const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
      child.once('error', (error: Error) => {
        this.spawnFailure = this.wrapSpawnError(error);
        reject(this.spawnFailure);
      });
    });

    // `withTimeout`'s `finally` only clears its own timer; a listener on a
    // promise nothing ultimately awaits (the happy path never rejects this
    // one) still needs a handler attached eagerly so Node never reports it
    // as unhandled before the race above has a chance to attach its own.
    spawnErrorPromise.catch(() => {});

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // Keep only a tail: a crash report should not carry megabytes of noise,
      // and must never carry the API key — kiro-cli has no reason to echo
      // it, but the slice below bounds the blast radius either way.
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    child.on('exit', (code, signal) => {
      this.closed = true;
      if (!this.crashNotified) {
        this.crashNotified = true;
        this.rejectAllPendingPermissions();
        this.events.onCrash?.({ code, signal, stderrTail: this.stderrTail });
      }
    });

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    const connection = new ClientSideConnection((_agent) => ({
      requestPermission: (params) => this.handlePermissionRequest(params),
      sessionUpdate: async (params) => {
        if (this.muted) {
          return;
        }
        const update = params.update as Record<string, unknown>;
        this.events.onSessionUpdate?.(toSessionUpdateEvent(update));
      },
      extNotification: async (method, params) => {
        // Unknown extension notifications are ignored.
        if (this.muted || !KNOWN_EXT_NOTIFICATIONS.has(method)) {
          return;
        }
        this.events.onExtNotification?.({ method, params: params as Record<string, unknown> });
      },
    }), stream);
    this.connection = connection;

    const initializePromise = connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'cloudcli', version: '1.0.0' },
    } as Parameters<ClientSideConnection['initialize']>[0]);

    let initializeResponse: unknown;
    try {
      initializeResponse = await this.withTimeout(
        Promise.race([initializePromise, spawnErrorPromise]),
        this.initTimeoutMs,
        'Kiro CLI did not respond to the ACP handshake in time.',
      );
    } catch (error) {
      // A failed spawn closes the stream too; whichever rejection arrives
      // first, the spawn error is the one worth reporting.
      const deadline = Date.now() + 2000;
      while (!this.spawnFailure && Date.now() < deadline && this.child?.exitCode == null && this.child?.signalCode == null) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      // cross-spawn reports ENOENT on Windows by replacing the child's exit
      // event with an 'error' event, so give that a moment to land.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const failure = this.spawnFailure ?? error;
      await this.close();
      throw failure;
    }

    this.initializeResponse = initializeResponse as unknown as Record<string, unknown>;
    return { initializeResponse: this.initializeResponse };
  }

  /** Creates a brand-new ACP session and returns its id plus whatever models/modes kiro-cli advertised. */
  async startSession(): Promise<{ sessionId: string; raw: Record<string, unknown> }> {
    const connection = this.requireConnection();
    const result = await connection.newSession({ cwd: this.cwd, mcpServers: [] } as Parameters<
      ClientSideConnection['newSession']
    >[0]);
    const raw = result as unknown as Record<string, unknown>;
    this.sessionId = raw.sessionId as string;
    return { sessionId: this.sessionId, raw };
  }

  /** Resumes a known provider-native session id via `session/load`. */
  async resumeSession(providerSessionId: string): Promise<{ sessionId: string; raw: Record<string, unknown> }> {
    const connection = this.requireConnection();
    // The agent replays the whole transcript as live-looking updates while it
    // loads; the UI already has that history, so the replay is dropped.
    this.muted = true;
    let result;
    try {
      result = await connection.loadSession({
        sessionId: providerSessionId,
        cwd: this.cwd,
        mcpServers: [],
      } as Parameters<ClientSideConnection['loadSession']>[0]);
    } finally {
      this.muted = false;
    }
    const raw = result as unknown as Record<string, unknown>;
    this.sessionId = providerSessionId;
    return { sessionId: providerSessionId, raw };
  }

  /**
   * Switches the session's model: v3 through the advertised `model` config
   * option, v2 through `session/set_model` (which the SDK no longer wraps, so it
   * goes out as a raw extension request).
   */
  async setModel(modelId: string): Promise<void> {
    if (this.engine === 'v3') {
      await this.setConfigOption('model', modelId);
      return;
    }
    const connection = this.requireConnection();
    const sessionId = this.requireSessionId();
    await connection.extMethod('session/set_model', { sessionId, modelId });
  }

  /**
   * Sets the reasoning level: v3 through the `effortLevel` config option, v2
   * with Kiro's `/effort <level>` command (run as a muted prompt turn, the way
   * kiro-ui does it).
   */
  async setEffort(level: string): Promise<void> {
    if (!/^[a-z]{1,20}$/.test(level)) {
      throw new AppError('Invalid Kiro effort level.', { code: 'KIRO_INVALID_EFFORT', statusCode: 400 });
    }
    if (this.engine === 'v3') {
      await this.setConfigOption('effortLevel', level);
      return;
    }
    this.muted = true;
    try {
      await this.prompt(`/effort ${level}`);
    } finally {
      this.muted = false;
    }
  }

  /** v3 `session/set_config_option`; resolves with the updated option list. */
  async setConfigOption(configId: string, value: string): Promise<unknown[]> {
    const connection = this.requireConnection();
    const sessionId = this.requireSessionId();
    const response = await connection.setSessionConfigOption({
      sessionId,
      configId,
      value,
    } as Parameters<ClientSideConnection['setSessionConfigOption']>[0]);
    const options = (response as unknown as { configOptions?: unknown[] }).configOptions;
    return Array.isArray(options) ? options : [];
  }

  /**
   * v3 `session/fork`: copies the current session into a new one. With
   * `messageId` (a user message id from the transcript) the copy ends after
   * that message's turn, answer included; Kiro reads it from `_meta.kiro`
   * (a top-level `messageId` is ignored and would copy everything).
   */
  async forkSession(options: { messageId?: string } = {}): Promise<{ sessionId: string; raw: Record<string, unknown> }> {
    if (!this.supportsFork()) {
      throw new AppError('This Kiro CLI does not support forking sessions.', {
        code: 'KIRO_FORK_UNSUPPORTED',
        statusCode: 501,
      });
    }
    const connection = this.requireConnection();
    const sessionId = this.requireSessionId();
    const response = await connection.unstable_forkSession({
      sessionId,
      cwd: this.cwd,
      mcpServers: [],
      ...(options.messageId ? { _meta: { kiro: { messageId: options.messageId } } } : {}),
    } as Parameters<ClientSideConnection['unstable_forkSession']>[0]);
    const raw = response as unknown as Record<string, unknown>;
    return { sessionId: raw.sessionId as string, raw };
  }
  /** Sends one prompt turn and resolves with its stop reason once the agent finishes (or is cancelled). */
  async prompt(text: string): Promise<{ stopReason: string }> {
    const connection = this.requireConnection();
    const sessionId = this.requireSessionId();
    let result;
    try {
      result = await connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text }],
      } as Parameters<ClientSideConnection['prompt']>[0]);
    } catch (error) {
      // The pipe usually closes a moment before the child's 'exit' event; give
      // onCrash a chance to report the exit code and stderr first.
      await this.waitForExit(1000);
      throw error;
    }
    return { stopReason: (result as unknown as { stopReason: string }).stopReason };
  }

  private async waitForExit(timeoutMs: number): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Sends `session/cancel`. Resolves any permission request still pending on this session as cancelled. */
  async cancel(): Promise<void> {
    if (!this.connection || !this.sessionId || this.closed) {
      return;
    }
    this.rejectAllPendingPermissions();
    try {
      await this.connection.cancel({ sessionId: this.sessionId } as Parameters<ClientSideConnection['cancel']>[0]);
    } catch {
      // The child may already be gone; cancel is best-effort.
    }
  }

  /** Resolves a pending `session/request_permission` call by its request id. */
  resolvePermission(requestId: string, decision: { optionId: string } | { cancelled: true }): void {
    const resolver = this.pendingPermissions.get(requestId);
    if (!resolver) {
      return;
    }
    this.pendingPermissions.delete(requestId);
    resolver(decision);
  }

  /** The request ids this client is still waiting on a UI decision for. */
  listPendingPermissionIds(): string[] {
    return Array.from(this.pendingPermissions.keys());
  }

  /** Sends an arbitrary Kiro extension request (`_kiro.dev/*`) and returns its result. */
  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const connection = this.requireConnection();
    return connection.extMethod(method, params);
  }

  /**
   * Kills the child (SIGTERM, then SIGKILL after a grace period) and tears
   * down the connection. Safe to call more than once and after a crash.
   */
  async close(): Promise<void> {
    this.closed = true;
    // A deliberate shutdown is not a crash; suppress onCrash for the exit it causes.
    this.crashNotified = true;
    this.rejectAllPendingPermissions();
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('exit', finish);
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => {
        if (!settled && child.exitCode === null) {
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS);
      killTimer.unref?.();
      // Backstop so close() never hangs the caller if 'exit' never fires.
      const giveUpTimer = setTimeout(finish, KILL_GRACE_MS + 1000);
      giveUpTimer.unref?.();
    });
  }

  private async handlePermissionRequest(
    params: Record<string, unknown>,
  ): Promise<{ outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } }> {
    const toolCall = (params.toolCall as Record<string, unknown>) || {};
    const requestId = (toolCall.toolCallId as string) || '';
    const options = ((params.options as Array<Record<string, unknown>>) || []).map((option) => ({
      optionId: option.optionId as string,
      name: option.name as string,
      kind: option.kind as string,
    }));

    if (!this.events.onPermissionRequest) {
      // No bridge configured: deny by default rather than hang the turn forever.
      return { outcome: { outcome: 'cancelled' } };
    }

    const decisionPromise = new Promise<{ optionId: string } | { cancelled: true }>((resolve) => {
      this.pendingPermissions.set(requestId, resolve);
    });

    // The bridge both registers how the UI's own answer eventually arrives
    // (resolvePermission) and may itself resolve immediately (an
    // auto-approve policy, trust rule). Whichever settles first wins.
    // Racing against decisionPromise lets cancel()/close() release a bridge
    // that is still waiting on the UI.
    const bridgePromise = Promise.resolve(this.events.onPermissionRequest({
      requestId,
      toolCallId: requestId,
      title: (toolCall.title as string) || '',
      kind: toolCall.kind as string | undefined,
      options,
      rawInput: toolCall.rawInput,
    })).then(
      (result) => result ?? decisionPromise,
      () => ({ cancelled: true }) as const,
    );

    const decision = await Promise.race([bridgePromise, decisionPromise]);
    this.pendingPermissions.delete(requestId);
    return this.toPermissionOutcome(decision);
  }

  private toPermissionOutcome(
    decision: { optionId: string } | { cancelled: true } | null | undefined,
  ): { outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } } {
    if (!decision || 'cancelled' in decision) {
      return { outcome: { outcome: 'cancelled' } };
    }
    return { outcome: { outcome: 'selected', optionId: decision.optionId } };
  }

  private rejectAllPendingPermissions(): void {
    for (const [requestId, resolver] of this.pendingPermissions) {
      resolver({ cancelled: true });
      this.pendingPermissions.delete(requestId);
    }
  }

  private requireConnection(): ClientSideConnection {
    if (!this.connection) {
      throw new AppError('Kiro ACP client is not connected.', { code: 'KIRO_ACP_NOT_CONNECTED', statusCode: 500 });
    }
    return this.connection;
  }

  private requireSessionId(): string {
    if (!this.sessionId) {
      throw new AppError('Kiro ACP client has no active session.', {
        code: 'KIRO_ACP_NO_SESSION',
        statusCode: 500,
      });
    }
    return this.sessionId;
  }

  private wrapSpawnError(error: Error): AppError {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return new AppError(
        `Kiro CLI was not found (command: "${this.command}"). Install kiro-cli or set ${KIRO_CLI_PATH_ENV}.`,
        { code: 'KIRO_CLI_NOT_FOUND', statusCode: 503 },
      );
    }
    // Never include raw spawn error internals that could echo env contents.
    return new AppError('Failed to start the Kiro CLI process.', { code: 'KIRO_CLI_SPAWN_FAILED', statusCode: 500 });
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new AppError(message, { code: 'KIRO_ACP_INIT_TIMEOUT', statusCode: 504 }));
        }, timeoutMs);
        promise.then(resolve, reject);
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
