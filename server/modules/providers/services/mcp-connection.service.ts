import { spawn } from 'node:child_process';

import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  CheckProviderMcpConnectionInput,
  McpConnectionCheckResult,
  McpConnectionStatus,
  ProviderMcpServer,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** How long a server gets to answer `initialize` before the check reports a timeout. */
const CHECK_TIMEOUT_MS = 10_000;
/** Upper bound on bytes read while waiting for a reply, so a chatty server cannot grow memory. */
const MAX_REPLY_BYTES = 1_000_000;
/** Number of trailing stderr characters kept to explain a stdio failure. */
const STDERR_TAIL_CHARS = 300;
const INITIALIZE_REQUEST_ID = 1;
const MCP_PROTOCOL_VERSION = '2025-03-26';

type ProbeOutcome = Pick<McpConnectionCheckResult, 'status' | 'message' | 'serverInfo'>;

const initializeRequest = {
  jsonrpc: '2.0',
  id: INITIALIZE_REQUEST_ID,
  method: 'initialize',
  params: {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'cloudcli-connection-check', version: '1.0.0' },
  },
};

const failed = (message: string, status: McpConnectionStatus = 'failed'): ProbeOutcome => ({ status, message });

/**
 * Turns one JSON-RPC message into an outcome, or `null` when the message is
 * not the reply to our `initialize` request (notifications, logs, other ids).
 */
const readInitializeReply = (message: unknown): ProbeOutcome | null => {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const reply = message as Record<string, unknown>;
  if (reply.id !== INITIALIZE_REQUEST_ID) {
    return null;
  }

  if (reply.error && typeof reply.error === 'object') {
    const reason = (reply.error as Record<string, unknown>).message;
    return failed(typeof reason === 'string' ? reason : 'The server rejected the initialize request.');
  }

  if (!reply.result || typeof reply.result !== 'object') {
    return failed('The server sent a reply without a result.');
  }

  const info = (reply.result as Record<string, unknown>).serverInfo;
  if (info && typeof info === 'object') {
    const { name, version } = info as Record<string, unknown>;
    return {
      status: 'connected',
      serverInfo: {
        name: typeof name === 'string' ? name : undefined,
        version: typeof version === 'string' ? version : undefined,
      },
    };
  }

  return { status: 'connected' };
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * Starts the configured command, sends `initialize` over stdin and waits for
 * the reply on stdout (newline-delimited JSON). The process is always killed
 * before the promise settles.
 */
function probeStdioServer(server: ProviderMcpServer, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    if (!server.command) {
      resolve(failed('This server has no command configured.'));
      return;
    }

    let settled = false;
    let stdoutBuffer = '';
    let stderrTail = '';
    let timer: NodeJS.Timeout | undefined;

    // Windows resolves `npx`-style .cmd launchers only through a shell.
    const child = spawn(server.command, server.args ?? [], {
      cwd: server.cwd,
      env: { ...process.env, ...server.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      windowsHide: true,
    });

    const finish = (outcome: ProbeOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(outcome);
    };

    timer = setTimeout(
      () => finish(failed(`No reply within ${Math.round(timeoutMs / 1000)} seconds.`, 'timeout')),
      timeoutMs,
    );

    child.on('error', (error) => finish(failed(`Could not start "${server.command}": ${error.message}`)));
    child.on('exit', (code, signal) => {
      const detail = stderrTail.trim() ? ` ${stderrTail.trim()}` : '';
      finish(failed(`The process exited (${code ?? signal}) before replying.${detail}`));
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_CHARS);
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8');
      if (stdoutBuffer.length > MAX_REPLY_BYTES) {
        finish(failed('The server produced too much output before replying.'));
        return;
      }

      const lines = stdoutBuffer.split('\n');
      // The last element is an incomplete line; keep it for the next chunk.
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const outcome = readInitializeReply(parseJson(line.trim()));
        if (outcome) {
          finish(outcome);
          return;
        }
      }
    });

    // A process that exits early closes stdin; the resulting EPIPE is reported via 'exit'.
    child.stdin.on('error', () => {});
    child.stdin.write(`${JSON.stringify(initializeRequest)}\n`);
  });
}

/** Builds request headers: configured headers plus the env-backed ones some providers (Codex) define. */
function buildRemoteHeaders(server: ProviderMcpServer, defaults: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...defaults, ...server.headers };

  if (server.bearerTokenEnvVar) {
    const token = process.env[server.bearerTokenEnvVar];
    if (token && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  for (const [headerName, envName] of Object.entries(server.envHttpHeaders ?? {})) {
    const value = process.env[envName];
    if (value) {
      headers[headerName] = value;
    }
  }

  return headers;
}

/** Reads server-sent events from a response until the `initialize` reply arrives or the stream ends. */
async function readReplyFromEventStream(response: Response): Promise<ProbeOutcome> {
  if (!response.body) {
    return failed('The server sent an empty event stream.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return failed('The event stream ended without an initialize reply.');
    }

    received += value.byteLength;
    buffer += decoder.decode(value, { stream: true });
    if (received > MAX_REPLY_BYTES) {
      return failed('The server produced too much output before replying.');
    }

    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      const outcome = readInitializeReply(parseJson(data));
      if (outcome) {
        return outcome;
      }
    }
  }
}

/**
 * Probes an http (streamable HTTP) or sse (legacy) server. HTTP servers get an
 * `initialize` POST; legacy SSE servers get a GET and count as connected once
 * they answer with an event stream.
 */
async function probeRemoteServer(server: ProviderMcpServer, timeoutMs: number): Promise<ProbeOutcome> {
  if (!server.url) {
    return failed('This server has no URL configured.');
  }

  let url: URL;
  try {
    url = new URL(server.url);
  } catch {
    return failed(`"${server.url}" is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return failed('Only http and https URLs can be checked.');
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const isLegacySse = server.transport === 'sse';
    const response = await fetch(url, isLegacySse
      ? {
        method: 'GET',
        headers: buildRemoteHeaders(server, { Accept: 'text/event-stream' }),
        signal: controller.signal,
      }
      : {
        method: 'POST',
        headers: buildRemoteHeaders(server, {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        }),
        body: JSON.stringify(initializeRequest),
        signal: controller.signal,
      });

    if (response.status === 401 || response.status === 403) {
      return failed(`The server answered HTTP ${response.status}. Sign in to it with the provider's own tool.`, 'auth_required');
    }
    if (!response.ok) {
      return failed(`The server answered HTTP ${response.status}.`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (isLegacySse) {
      return contentType.includes('text/event-stream')
        ? { status: 'connected' }
        : failed('The server did not open an event stream.');
    }

    if (contentType.includes('text/event-stream')) {
      return await readReplyFromEventStream(response);
    }

    const outcome = readInitializeReply(parseJson(await response.text()));
    return outcome ?? failed('The server reply was not a valid initialize response.');
  } catch (error) {
    if (timedOut) {
      return failed(`No reply within ${Math.round(timeoutMs / 1000)} seconds.`, 'timeout');
    }
    return failed(error instanceof Error ? error.message : 'Unknown error');
  } finally {
    clearTimeout(timer);
    // Also closes any event stream still open after we have our answer.
    controller.abort();
  }
}

/**
 * Sends an MCP `initialize` request to one server and reports whether it answered.
 * Exported for the connection-check unit tests, which run it against local fake servers.
 */
export async function probeMcpServer(
  server: ProviderMcpServer,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<McpConnectionCheckResult> {
  const startedAt = Date.now();
  const outcome = server.transport === 'stdio'
    ? await probeStdioServer(server, timeoutMs)
    : await probeRemoteServer(server, timeoutMs);

  return {
    provider: server.provider,
    name: server.name,
    scope: server.scope,
    latencyMs: Date.now() - startedAt,
    ...outcome,
  };
}

// Consumed by provider.routes.ts to serve the "check connection" action in the MCP settings list.
export const providerMcpConnectionService = {
  /**
   * Looks up one configured MCP server of a provider and checks that it answers
   * an MCP handshake. Starts the server's command for stdio servers, so callers
   * must only run it on an explicit user action.
   */
  async checkProviderMcpServerConnection(
    providerName: string,
    input: CheckProviderMcpConnectionInput,
  ): Promise<McpConnectionCheckResult> {
    const provider = providerRegistry.resolveProvider(providerName);
    const scope = input.scope ?? 'user';
    const servers = await provider.mcp.listServersForScope(scope, { workspacePath: input.workspacePath });
    const server = servers.find((candidate) => candidate.name === input.name);

    if (!server) {
      throw new AppError(`MCP server "${input.name}" was not found in ${scope} scope.`, {
        code: 'MCP_SERVER_NOT_FOUND',
        statusCode: 404,
      });
    }

    return probeMcpServer(server);
  },
};
