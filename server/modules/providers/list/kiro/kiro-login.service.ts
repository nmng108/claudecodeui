import type { ChildProcess } from 'node:child_process';

import spawn from 'cross-spawn';

import { resolveKiroCliCommand } from '@/modules/providers/list/kiro/kiro-acp.client.js';
import { AppError } from '@/shared/utils.js';

/**
 * Browser sign-in for Kiro CLI through the OAuth *device flow*.
 *
 * `kiro-cli login --use-device-flow` needs no browser on the machine that runs
 * it (a container, an SSH host): it prints a verification URL and a one-time
 * code, then waits until the user confirms them in any browser. This service
 * runs that command as a child process, reads the URL and code from its
 * output for the UI, and reports when the CLI exits. The CLI stores the
 * resulting token itself (`~/.local/share/kiro-cli`); nothing is stored here.
 *
 * Only one sign-in runs at a time. Starting another cancels the previous one.
 */

export type KiroLoginMethod = 'builder-id' | 'identity-center';

export type KiroLoginStatus =
  | 'idle'
  | 'starting'
  | 'awaiting_confirmation'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type KiroLoginState = {
  status: KiroLoginStatus;
  method: KiroLoginMethod | null;
  /** Page where the user confirms the code. Always `https`. */
  verificationUrl: string | null;
  /** One-time code to confirm; null when the URL already carries it. */
  userCode: string | null;
  error: string | null;
};

export type KiroLoginInput = {
  method: KiroLoginMethod;
  /** IAM Identity Center start URL; required for `identity-center`. */
  startUrl?: string;
  /** AWS region of the Identity Center directory; required for `identity-center`. */
  region?: string;
};

/** Device codes expire after about 10 minutes; give up a little later than that. */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const WHOAMI_TIMEOUT_MS = 10_000;
const WHOAMI_CACHE_MS = 5_000;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_START_URL_LENGTH = 512;
const REGION_PATTERN = /^[a-z]{2,3}(?:-[a-z]+)+-\d{1,2}$/;
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const USER_CODE_PATTERN = /Code:\s*([A-Z0-9]{3,}(?:-[A-Z0-9]{3,})+)/;
const OPEN_URL_PATTERN = /Open this URL:\s*(https:\/\/\S+)/;
const ANY_HTTPS_URL_PATTERN = /(https:\/\/[^\s"'<>]+)/;

const IDLE_STATE: KiroLoginState = {
  status: 'idle',
  method: null,
  verificationUrl: null,
  userCode: null,
  error: null,
};

type ActiveLogin = {
  child: ChildProcess;
  output: string;
  timeout: NodeJS.Timeout;
  cancelled: boolean;
  /** Set once the outcome is recorded, so a late close after error cannot overwrite it. */
  finished: boolean;
};

let state: KiroLoginState = IDLE_STATE;
let active: ActiveLogin | null = null;
let whoamiCache: { at: number; value: KiroCliLogin | null } | null = null;

/** Stops the CLI. On Windows kiro-cli may be a .cmd shim, so the whole process tree is ended. */
function killProcess(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
    return;
  }
  child.kill();
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** Validates the Identity Center inputs and returns the CLI arguments for the chosen method. */
export function buildKiroLoginArgs(input: KiroLoginInput): string[] {
  if (input.method === 'builder-id') {
    return ['login', '--license', 'free', '--use-device-flow'];
  }

  if (input.method !== 'identity-center') {
    throw new AppError('method must be "builder-id" or "identity-center".', {
      code: 'KIRO_LOGIN_INVALID',
      statusCode: 400,
    });
  }

  const startUrl = typeof input.startUrl === 'string' ? input.startUrl.trim() : '';
  const region = typeof input.region === 'string' ? input.region.trim() : '';
  if (!startUrl || !region) {
    throw new AppError('The Identity Center start URL and region are required.', {
      code: 'KIRO_LOGIN_INVALID',
      statusCode: 400,
    });
  }

  let parsed: URL;
  try {
    parsed = new URL(startUrl);
  } catch {
    parsed = new URL('invalid:');
  }
  if (
    startUrl.length > MAX_START_URL_LENGTH
    || parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || /\s/.test(startUrl)
  ) {
    throw new AppError('The start URL must be a valid https:// URL.', {
      code: 'KIRO_LOGIN_INVALID',
      statusCode: 400,
    });
  }

  if (!REGION_PATTERN.test(region)) {
    throw new AppError('The region must look like "us-east-1".', {
      code: 'KIRO_LOGIN_INVALID',
      statusCode: 400,
    });
  }

  return [
    'login',
    '--license', 'pro',
    '--identity-provider', startUrl,
    '--region', region,
    '--use-device-flow',
  ];
}

/** Pulls the verification URL and code out of the CLI's (ANSI-stripped) output. */
export function parseKiroLoginOutput(rawOutput: string): { verificationUrl: string | null; userCode: string | null } {
  const text = stripAnsi(rawOutput);
  const url = OPEN_URL_PATTERN.exec(text)?.[1] ?? ANY_HTTPS_URL_PATTERN.exec(text)?.[1] ?? null;
  const userCode = USER_CODE_PATTERN.exec(text)?.[1] ?? null;
  return { verificationUrl: url, userCode };
}

/** The last meaningful line of the output, for the message shown when the CLI fails. */
function summarizeFailure(rawOutput: string): string {
  const lines = stripAnsi(rawOutput)
    .split(/\r?\n/)
    .map((line) => line.trim())
    // Progress-bar redraws ("Logging in...") are not errors.
    .filter((line) => line && !/Logging in|^[▰▱\s]+$/.test(line));
  const errorLine = [...lines].reverse().find((line) => /error|fail|denied|expired|invalid/i.test(line));
  return (errorLine ?? lines[lines.length - 1] ?? 'Kiro sign-in did not complete.').slice(0, 300);
}

function setState(next: Partial<KiroLoginState>): void {
  state = { ...state, ...next };
}

function finish(login: ActiveLogin, next: Partial<KiroLoginState>): void {
  if (login.finished) {
    return;
  }
  login.finished = true;
  clearTimeout(login.timeout);
  if (active === login) {
    active = null;
  }
  setState(next);
}

/** Starts a sign-in (cancelling a running one) and returns the state once the CLI printed the URL, or failed. */
export async function startKiroLogin(input: KiroLoginInput): Promise<KiroLoginState> {
  const args = buildKiroLoginArgs(input);
  cancelKiroLogin();
  whoamiCache = null;

  // An API key in the environment would make the CLI skip the interactive login.
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', TERM: 'dumb' };
  delete env.KIRO_API_KEY;

  const child = spawn(resolveKiroCliCommand(), args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const login: ActiveLogin = {
    child,
    output: '',
    cancelled: false,
    finished: false,
    timeout: setTimeout(() => {
      login.cancelled = true;
      killProcess(child);
      finish(login, { status: 'failed', error: 'The sign-in timed out. Start it again.' });
    }, LOGIN_TIMEOUT_MS),
  };
  active = login;
  state = { ...IDLE_STATE, status: 'starting', method: input.method };

  const onData = (chunk: Buffer) => {
    login.output = (login.output + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS);
    if (state.status !== 'starting' || active !== login) {
      return;
    }
    const { verificationUrl, userCode } = parseKiroLoginOutput(login.output);
    if (verificationUrl) {
      setState({ status: 'awaiting_confirmation', verificationUrl, userCode });
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  child.on('error', (error) => {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    finish(login, {
      status: 'failed',
      error: missing ? 'Kiro CLI was not found on the server.' : `Could not start Kiro CLI: ${error.message}`,
    });
  });

  child.on('close', (code) => {
    if (login.cancelled || login.finished) {
      return;
    }
    whoamiCache = null;
    if (code === 0) {
      finish(login, { status: 'succeeded', error: null });
    } else {
      finish(login, { status: 'failed', error: summarizeFailure(login.output) });
    }
  });

  // Wait briefly for the URL so the first response already carries it.
  const deadline = Date.now() + 15_000;
  while (state.status === 'starting' && active === login && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return getKiroLoginState();
}

export function getKiroLoginState(): KiroLoginState {
  return { ...state };
}

/** Stops a running sign-in. A finished one is left as it is. */
export function cancelKiroLogin(): KiroLoginState {
  const login = active;
  if (login) {
    login.cancelled = true;
    killProcess(login.child);
    finish(login, { ...IDLE_STATE, status: 'cancelled', method: state.method });
  }
  return getKiroLoginState();
}

export type KiroCliLogin = {
  /** Short text for the UI, such as the email or the Identity Center start URL. */
  label: string;
};

function describeAccount(account: unknown): string {
  if (typeof account === 'string' && account.trim()) {
    return account.trim();
  }
  if (account && typeof account === 'object') {
    const record = account as Record<string, unknown>;
    for (const key of ['email', 'emailAddress', 'username', 'startUrl', 'accountType', 'authMethod', 'loginType']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }
  return 'Kiro account';
}

/** Runs a short `kiro-cli` command and collects its output; null when it cannot run or times out. */
function runKiroCli(args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string } | null> {
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (value: { code: number | null; stdout: string } | null) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    };
    const child = spawn(resolveKiroCliCommand(), args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      killProcess(child);
      done(null);
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS);
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done({ code, stdout }));
  });
}

/**
 * Whether `kiro-cli` holds a sign-in (`kiro-cli whoami --format json` reports
 * an account). Cached for a few seconds because auth status is polled.
 */
export async function getKiroCliLogin(): Promise<KiroCliLogin | null> {
  if (whoamiCache && Date.now() - whoamiCache.at < WHOAMI_CACHE_MS) {
    return whoamiCache.value;
  }

  const result = await runKiroCli(['whoami', '--format', 'json'], WHOAMI_TIMEOUT_MS);
  let value: KiroCliLogin | null = null;
  if (result) {
    try {
      const parsed = JSON.parse(result.stdout.trim()) as { account?: unknown } | null;
      if (parsed && parsed.account) {
        value = { label: describeAccount(parsed.account) };
      }
    } catch {
      value = null;
    }
  }
  whoamiCache = { at: Date.now(), value };
  return value;
}

/** Signs the CLI out (`kiro-cli logout`). Rejects when the CLI is missing or fails. */
export async function logoutKiroCli(): Promise<void> {
  cancelKiroLogin();
  const result = await runKiroCli(['logout'], WHOAMI_TIMEOUT_MS);
  whoamiCache = null;
  state = IDLE_STATE;
  if (!result || result.code !== 0) {
    throw new AppError('Could not sign out of Kiro CLI.', { code: 'KIRO_LOGOUT_FAILED', statusCode: 500 });
  }
}

/** Test hook: forget everything between tests. */
export function resetKiroLoginForTesting(): void {
  cancelKiroLogin();
  state = IDLE_STATE;
  whoamiCache = null;
}
