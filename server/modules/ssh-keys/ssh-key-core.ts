import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { GenerateSshKeyOptions, SshKeyInfo, SshKeyProvider } from './ssh-key-provider.js';

/** Raised for failures the caller can act on; statusCode is the HTTP status it maps to. */
export class SshKeyError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: string;

  constructor(message: string, options: { code: string; statusCode: number; details?: string }) {
    super(message);
    this.name = 'SshKeyError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.details = options.details;
  }
}

/** Key files looked up in the SSH directory, in the order OpenSSH offers them. */
export const KEY_FILE_NAMES = ['id_ed25519', 'id_ecdsa', 'id_rsa'] as const;

/** The file name and comment used for keys generated here. */
const GENERATED_KEY_NAME = 'id_ed25519';
const GENERATED_COMMENT_PREFIX = 'cloudcli@';

const KEYGEN_TIMEOUT_MS = 15_000;

export type KeygenResult = { stdout: string; stderr: string; code: number | null; missing: boolean };
export type KeygenRunner = (args: string[]) => Promise<KeygenResult>;

const runSshKeygen: KeygenRunner = (args) =>
  new Promise((resolve) => {
    execFile('ssh-keygen', args, { timeout: KEYGEN_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout: String(stdout), stderr: String(stderr), code: 0, missing: false });
        return;
      }
      const failure = error as NodeJS.ErrnoException & { code?: string | number };
      resolve({
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        code: typeof failure.code === 'number' ? failure.code : null,
        missing: failure.code === 'ENOENT',
      });
    });
  });

const KEY_TYPE_LABELS: Record<string, string> = {
  'ssh-ed25519': 'ED25519',
  'ssh-rsa': 'RSA',
  'ecdsa-sha2-nistp256': 'ECDSA',
  'ecdsa-sha2-nistp384': 'ECDSA',
  'ecdsa-sha2-nistp521': 'ECDSA',
};

/** Splits an OpenSSH public key line into its parts; null when it is not one. */
export function parsePublicKey(line: string): {
  algorithm: string;
  blob: string;
  comment: string | null;
  type: string;
  fingerprint: string;
  publicKey: string;
} | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [algorithm, blob, ...rest] = parts;
  if (!/^(ssh-|ecdsa-|sk-)/.test(algorithm)) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return null;

  const decoded = Buffer.from(blob, 'base64');
  if (decoded.length === 0) return null;
  // The fingerprint git servers show: SHA-256 of the key blob, base64 without padding.
  const fingerprint = `SHA256:${createHash('sha256').update(decoded).digest('base64').replace(/=+$/, '')}`;
  const comment = rest.join(' ') || null;
  return {
    algorithm,
    blob,
    comment,
    type: KEY_TYPE_LABELS[algorithm] ?? algorithm,
    fingerprint,
    publicKey: [algorithm, blob, comment].filter(Boolean).join(' '),
  };
}

function sanitizeHostname(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 63) || 'host';
}

function abbreviateHome(target: string): string {
  const home = os.homedir();
  return target.startsWith(home) ? `~${target.slice(home.length).replace(/\\/g, '/')}` : target;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function isWritable(directory: string): Promise<boolean> {
  // A directory that does not exist yet is writable when its nearest parent is.
  let current = directory;
  for (;;) {
    try {
      await fs.access(current, (await fs.stat(current)).isDirectory() ? 2 : 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

export type SshKeyCoreOptions = {
  /** Reported in provider; the sidecar passes gent. */
  providerName?: SshKeyInfo['provider'];
  /** Directory holding the key files. Defaults to `~/.ssh`. */
  sshDirectory?: string;
  /** Overridable for tests. */
  runKeygen?: KeygenRunner;
  hostname?: () => string;
};

/**
 * Manages the key files of one directory with the system `ssh-keygen`.
 *
 * An existing key is only ever read. A key is created only when none exists and
 * the caller asked for it, and only a key created here can be replaced.
 */
export function createSshKeyCore(options: SshKeyCoreOptions = {}): SshKeyProvider {
  const sshDirectory = options.sshDirectory ?? path.join(os.homedir(), '.ssh');
  const runKeygen = options.runKeygen ?? runSshKeygen;
  const hostname = options.hostname ?? os.hostname;
  let queue: Promise<unknown> = Promise.resolve();

  /** Runs one generate at a time so two clicks can never write the same files. */
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  async function findPrivateKey(): Promise<string | null> {
    for (const name of KEY_FILE_NAMES) {
      const candidate = path.join(sshDirectory, name);
      if (await exists(candidate)) return candidate;
    }
    return null;
  }

  const emptyInfo = (patch: Partial<SshKeyInfo>): SshKeyInfo => ({
    status: 'missing',
    origin: null,
    type: null,
    publicKey: null,
    fingerprint: null,
    comment: null,
    location: null,
    canGenerate: false,
    canReplace: false,
    reason: null,
    provider: options.providerName ?? 'native',
    ...patch,
  });

  async function getKey(): Promise<SshKeyInfo> {
    const privateKeyPath = await findPrivateKey();

    if (!privateKeyPath) {
      const writable = await isWritable(sshDirectory);
      return emptyInfo({
        canGenerate: writable,
        reason: writable ? null : 'read-only',
        location: abbreviateHome(sshDirectory),
      });
    }

    const location = abbreviateHome(privateKeyPath);
    let publicLine: string | null = null;
    try {
      publicLine = (await fs.readFile(`${privateKeyPath}.pub`, 'utf8')).split(/\r?\n/)[0] ?? null;
    } catch {
      // No .pub file; ask ssh-keygen to derive it. An empty passphrase makes it fail instead of prompting.
      const derived = await runKeygen(['-y', '-P', '', '-f', privateKeyPath]);
      publicLine = derived.code === 0 ? derived.stdout.split(/\r?\n/)[0] : null;
    }

    const parsed = publicLine ? parsePublicKey(publicLine) : null;
    if (!parsed) {
      return emptyInfo({ status: 'unreadable', origin: 'existing', location, reason: 'passphrase-or-unreadable' });
    }

    const generated = path.basename(privateKeyPath) === GENERATED_KEY_NAME
      && Boolean(parsed.comment?.startsWith(GENERATED_COMMENT_PREFIX));
    return emptyInfo({
      status: 'present',
      origin: generated ? 'generated' : 'existing',
      type: parsed.type,
      publicKey: parsed.publicKey,
      fingerprint: parsed.fingerprint,
      comment: parsed.comment,
      location,
      canReplace: generated && (await isWritable(sshDirectory)),
    });
  }

  async function generateKey({ replace = false }: GenerateSshKeyOptions = {}): Promise<SshKeyInfo> {
    return serialize(async () => {
      const current = await getKey();

      if (current.status !== 'missing') {
        if (!replace) {
          throw new SshKeyError('An SSH key already exists', { code: 'SSH_KEY_EXISTS', statusCode: 409 });
        }
        if (!current.canReplace) {
          throw new SshKeyError('Only a key generated by this app can be replaced', {
            code: 'SSH_KEY_NOT_REPLACEABLE',
            statusCode: 403,
          });
        }
      } else if (!current.canGenerate) {
        throw new SshKeyError('The SSH directory is read-only', { code: 'SSH_DIRECTORY_READ_ONLY', statusCode: 409 });
      }

      await fs.mkdir(sshDirectory, { recursive: true, mode: 0o700 });

      // Generated beside the final name and moved into place, so a failure never
      // leaves a half-written key where the old one was.
      const temporary = path.join(sshDirectory, `.cloudcli-new-${randomBytes(6).toString('hex')}`);
      const target = path.join(sshDirectory, GENERATED_KEY_NAME);
      try {
        const result = await runKeygen([
          '-q',
          '-t', 'ed25519',
          '-N', '',
          '-C', `${GENERATED_COMMENT_PREFIX}${sanitizeHostname(hostname())}`,
          '-f', temporary,
        ]);
        if (result.missing) {
          throw new SshKeyError('ssh-keygen is not installed', { code: 'SSH_KEYGEN_MISSING', statusCode: 501 });
        }
        if (result.code !== 0) {
          throw new SshKeyError('Could not generate the SSH key', {
            code: 'SSH_KEYGEN_FAILED',
            statusCode: 500,
            details: result.stderr.trim().slice(0, 300),
          });
        }

        await fs.chmod(temporary, 0o600).catch(() => undefined);
        await fs.rename(temporary, target);
        await fs.rename(`${temporary}.pub`, `${target}.pub`);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        await fs.rm(`${temporary}.pub`, { force: true }).catch(() => undefined);
      }

      return getKey();
    });
  }

  return { getKey, generateKey };
}

// ---------------------------------------------------------------------------
// Control API of the ssh-agent sidecar
// ---------------------------------------------------------------------------
//
// The sidecar container holds the private key. The app asks it for the public
// half and for a key to be created through this small HTTP API, served on a
// unix socket that only the app container shares. There is deliberately no way
// to read, import, delete or replace a key through it: the agents running next
// to the app can reach the same socket.

type ControlHandlerOptions = {
  core: SshKeyProvider;
  /** Runs after a key was created, to load it into the agent. */
  onKeyChanged: () => Promise<void>;
};

const MAX_CONTROL_BODY_BYTES = 4096;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_CONTROL_BODY_BYTES) {
      throw new SshKeyError('Request body is too large', { code: 'REQUEST_TOO_LARGE', statusCode: 413 });
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new SshKeyError('Request body is not valid JSON', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
  }
}

/** What the sidecar reports: the agent provider, and never a replaceable key (see the note above). */
function asAgentInfo(info: SshKeyInfo): SshKeyInfo {
  return { ...info, provider: 'agent', canReplace: false };
}

/**
 * Request handler for the sidecar's control API.
 *
 * - `GET /health` answers 200 once the service is up.
 * - `GET /key` returns the key state (public half only).
 * - `POST /generate` creates a key when none exists. `replace` is refused: a key
 *   is rotated from the host with `rotate-key`, not from a socket the agents share.
 */
export function createControlHandler({ core, onKeyChanged }: ControlHandlerOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;

      if (req.method === 'GET' && pathname === '/health') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && pathname === '/key') {
        sendJson(res, 200, asAgentInfo(await core.getKey()));
        return;
      }

      if (req.method === 'POST' && pathname === '/generate') {
        const body = await readJsonBody(req);
        if (body.replace !== undefined && typeof body.replace !== 'boolean') {
          throw new SshKeyError('replace must be a boolean', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
        }
        if (body.replace === true) {
          throw new SshKeyError(
            'A key cannot be replaced from the app. Run "rotate-key" in the ssh-agent container.',
            { code: 'SSH_KEY_REPLACE_DISABLED', statusCode: 403 },
          );
        }
        const info = await core.generateKey();
        await onKeyChanged();
        sendJson(res, 200, asAgentInfo(info));
        return;
      }

      sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (error) {
      if (error instanceof SshKeyError) {
        sendJson(res, error.statusCode, { error: { code: error.code, message: error.message, details: error.details } });
        return;
      }
      sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Internal error' } });
    }
  };
}
