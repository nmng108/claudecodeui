/**
 * Detects whether the current credentials can read from and push to a
 * repository's remote, without changing anything.
 *
 * - Read: `git ls-remote <remote> HEAD`.
 * - Write: `git push --dry-run --no-verify <remote> HEAD:refs/heads/<branch>`.
 *   A dry run still opens the server's receive-pack endpoint, which is where
 *   GitHub, GitLab and Bitbucket reject missing or read-only credentials. It
 *   sends no objects and updates nothing.
 * - Public: for http(s) remotes the read is repeated anonymously, so a public
 *   repository is told apart from one readable only with credentials.
 *
 * The write result is a strong hint, not a guarantee: branch protection and
 * server-side hooks are only evaluated by a real push.
 *
 * Every probe is non-interactive (no terminal, askpass or SSH prompts) and has
 * a time limit, so it can never block on a credential prompt.
 */

import spawn from 'cross-spawn';

export type GitRemoteTransport = 'ssh' | 'https' | 'http' | 'git' | 'local';

export type GitRemoteAccessState =
  | 'read-write'
  | 'read-only'
  | 'readable'
  | 'no-access'
  | 'not-found'
  | 'host-key'
  | 'unreachable'
  | 'no-remote'
  | 'error';

export type GitRemoteAccess = {
  state: GitRemoteAccessState;
  read: 'ok' | 'denied' | 'unknown';
  write: 'ok' | 'denied' | 'unknown';
  /** `anonymous` when the repository is readable without any credentials (public). */
  readVia: 'anonymous' | 'credentials' | null;
  remote: string | null;
  /** Remote URL with any password removed. */
  url: string | null;
  host: string | null;
  transport: GitRemoteTransport | null;
  branch: string | null;
  /** Sanitized last line of git's error output, for display. */
  message: string | null;
  checkedAt: string;
};

export type GitCommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type GitCommandRunner = (
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<GitCommandResult>;

export type FailureKind = 'auth' | 'host-key' | 'unreachable' | 'not-found' | 'error';

const PROBE_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

/** Default runner: runs `git` and resolves (never rejects) with the outcome. */
export const runGitCommand: GitCommandRunner = (args, { cwd, env, timeoutMs }) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };

    const child = spawn('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.on('error', (error) => {
      stderr += error.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });

/** Parses a remote URL into the facts the UI needs. Credentials are never returned. */
export function describeRemoteUrl(rawUrl: string): {
  transport: GitRemoteTransport;
  host: string | null;
  sanitizedUrl: string;
  anonymousUrl: string;
} {
  const url = rawUrl.trim();

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();
    if (scheme === 'file') {
      return { transport: 'local', host: null, sanitizedUrl: url, anonymousUrl: url };
    }
    try {
      const parsed = new URL(url);
      const transport: GitRemoteTransport =
        scheme === 'https' ? 'https'
        : scheme === 'http' ? 'http'
        : scheme === 'git' ? 'git'
        : 'ssh';
      const host = parsed.hostname || null;
      // The password is dropped. The user name is kept for ssh (it is part of
      // the address, e.g. `git@`) and removed for the anonymous http(s) probe.
      const sanitized = new URL(url);
      sanitized.password = '';
      const anonymous = new URL(url);
      anonymous.username = '';
      anonymous.password = '';
      return {
        transport,
        host,
        sanitizedUrl: sanitized.toString(),
        anonymousUrl: anonymous.toString(),
      };
    } catch {
      return { transport: 'ssh', host: null, sanitizedUrl: url.replace(/:\/\/[^@/]*@/, '://'), anonymousUrl: url };
    }
  }

  // scp-like syntax: [user@]host:path (a drive letter such as C:\ is a local path).
  const scpMatch = /^(?:[^@/\s]+@)?([^:/\s]{2,}):(?!\/\/)/.exec(url);
  if (scpMatch) {
    return { transport: 'ssh', host: scpMatch[1], sanitizedUrl: url, anonymousUrl: url };
  }

  return { transport: 'local', host: null, sanitizedUrl: url, anonymousUrl: url };
}

/** Removes URL credentials from a line of git output before it is shown or logged. */
export function redactCredentials(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1***@');
}

const AUTH_PATTERNS = [
  /permission denied \(/i,
  /authentication failed/i,
  /could not read (username|password)/i,
  /terminal prompts disabled/i,
  /invalid username or password/i,
  /password authentication (was|is) (removed|not supported)/i,
  /returned error: (401|403)/i,
  /\b(401|403)\b.*(unauthorized|forbidden)/i,
  /http basic: access denied/i,
  /access denied/i,
  /permission to .* denied/i,
  /not allowed to push/i,
  /read[- ]only/i,
  /you do not have (the )?(correct )?access rights/i,
];

const HOST_KEY_PATTERNS = [
  /host key verification failed/i,
  /remote host identification has changed/i,
  /no (matching )?host key/i,
];

const UNREACHABLE_PATTERNS = [
  /could not resolve host/i,
  /connection (timed out|refused|reset|closed)/i,
  /network is unreachable/i,
  /no route to host/i,
  /failed to connect/i,
  /operation timed out/i,
  /temporary failure in name resolution/i,
  /ssl (connect|certificate)/i,
  /unable to access .*(timed out|resolve)/i,
];

const NOT_FOUND_PATTERNS = [
  /repository .*not found/i,
  /does not appear to be a git repository/i,
  /\b404\b/i,
  /project .* not found/i,
];

/** Sorts a failed git command into the cause the UI can act on. */
export function classifyGitFailure(stderr: string, timedOut = false): FailureKind {
  if (timedOut) return 'unreachable';
  // "Host key verification failed" is followed by a generic "Could not read
  // from remote repository", so it is checked before the rest.
  if (HOST_KEY_PATTERNS.some((pattern) => pattern.test(stderr))) return 'host-key';
  if (UNREACHABLE_PATTERNS.some((pattern) => pattern.test(stderr))) return 'unreachable';
  if (AUTH_PATTERNS.some((pattern) => pattern.test(stderr))) return 'auth';
  if (NOT_FOUND_PATTERNS.some((pattern) => pattern.test(stderr))) return 'not-found';
  return 'error';
}

/** A rejected non-fast-forward still proves the server accepted the credentials. */
function dryRunReachedReceivePack(result: GitCommandResult): boolean {
  if (result.code === 0) return true;
  return /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(result.stderr);
}

function lastMessage(stderr: string): string | null {
  const lines = redactCredentials(stderr)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const line = lines[lines.length - 1];
  return line ? line.slice(0, 300) : null;
}

type CheckInput = {
  /** Directory of the repository to check. */
  repositoryPath: string;
  /** Skip the cache. */
  force?: boolean;
};

export type RemoteAccessChecker = (input: CheckInput) => Promise<GitRemoteAccess>;

type CheckerDependencies = {
  run?: GitCommandRunner;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

/**
 * Creates a checker with its own short-lived cache, keyed by repository, remote
 * and branch. Concurrent checks of the same key share one probe.
 */
export function createRemoteAccessChecker(dependencies: CheckerDependencies = {}): RemoteAccessChecker {
  const run = dependencies.run ?? runGitCommand;
  const baseEnv = dependencies.env ?? process.env;
  const now = dependencies.now ?? Date.now;
  const cache = new Map<string, { at: number; value: GitRemoteAccess }>();
  const inflight = new Map<string, Promise<GitRemoteAccess>>();

  async function probe(repositoryPath: string): Promise<{ key: string; compute: () => Promise<GitRemoteAccess> }> {
    const git = (args: string[], env: NodeJS.ProcessEnv = baseEnv, timeoutMs = PROBE_TIMEOUT_MS) =>
      run(args, { cwd: repositoryPath, env, timeoutMs });

    const remotesResult = await git(['remote']);
    const remotes = remotesResult.stdout.split('\n').map((line) => line.trim()).filter(Boolean);

    const branchResult = await git(['symbolic-ref', '--short', '-q', 'HEAD']);
    const branch = branchResult.code === 0 ? branchResult.stdout.trim() || null : null;

    let remote: string | null = null;
    if (remotes.length > 0) {
      const upstream = branch
        ? await git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])
        : null;
      const upstreamRemote = upstream && upstream.code === 0 ? upstream.stdout.trim().split('/')[0] : '';
      remote = upstreamRemote && remotes.includes(upstreamRemote)
        ? upstreamRemote
        : remotes.includes('origin') ? 'origin' : remotes[0];
    }

    const urlResult = remote ? await git(['remote', 'get-url', remote]) : null;
    const rawUrl = urlResult && urlResult.code === 0 ? urlResult.stdout.trim() : null;
    const key = `${repositoryPath}\u0000${remote ?? ''}\u0000${rawUrl ?? ''}\u0000${branch ?? ''}`;

    const compute = async (): Promise<GitRemoteAccess> => {
      const base = {
        remote,
        branch,
        checkedAt: new Date(now()).toISOString(),
      };

      if (!remote || !rawUrl) {
        return {
          ...base,
          state: 'no-remote',
          read: 'unknown',
          write: 'unknown',
          readVia: null,
          url: null,
          host: null,
          transport: null,
          message: null,
        };
      }

      const described = describeRemoteUrl(rawUrl);

      // Non-interactive, English output (so the failure patterns match), and a
      // non-blocking SSH unless the user configured their own command.
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        LC_ALL: 'C',
        LANGUAGE: 'C',
      };
      delete env.SSH_ASKPASS_REQUIRE;
      if (described.transport === 'ssh') {
        let sshCommand = env.GIT_SSH_COMMAND?.trim() || '';
        if (!sshCommand) {
          const configured = await git(['config', '--get', 'core.sshCommand'], env);
          sshCommand = configured.code === 0 ? configured.stdout.trim() : '';
        }
        sshCommand ||= 'ssh';
        if (/^"?(.*[\\/])?ssh(\.exe)?"?(\s|$)/i.test(sshCommand)) {
          env.GIT_SSH_COMMAND = `${sshCommand} -o BatchMode=yes -o ConnectTimeout=8`;
        } else {
          env.GIT_SSH_COMMAND = sshCommand;
        }
      }

      const withDetails = (partial: Pick<GitRemoteAccess, 'state' | 'read' | 'write' | 'readVia' | 'message'>): GitRemoteAccess => ({
        ...base,
        ...partial,
        url: described.sanitizedUrl,
        host: described.host,
        transport: described.transport,
      });

      const read = await git(['ls-remote', remote, 'HEAD'], env);
      if (read.code !== 0) {
        const kind = classifyGitFailure(read.stderr, read.timedOut);
        const state: GitRemoteAccessState =
          kind === 'auth' ? 'no-access'
          : kind === 'not-found' ? 'not-found'
          : kind === 'host-key' ? 'host-key'
          : kind === 'unreachable' ? 'unreachable'
          : 'error';
        return withDetails({
          state,
          read: kind === 'auth' || kind === 'not-found' ? 'denied' : 'unknown',
          write: 'unknown',
          readVia: null,
          message: read.timedOut ? 'The remote did not answer in time' : lastMessage(read.stderr),
        });
      }

      const canTestWrite = Boolean(branch) && (await git(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
      const isHttp = described.transport === 'https' || described.transport === 'http';

      const [write, anonymous] = await Promise.all([
        canTestWrite
          ? git(['push', '--dry-run', '--no-verify', remote, `HEAD:refs/heads/${branch}`], env)
          : Promise.resolve(null),
        isHttp
          ? git(['-c', 'credential.helper=', 'ls-remote', described.anonymousUrl, 'HEAD'], env)
          : Promise.resolve(null),
      ]);

      const readVia: GitRemoteAccess['readVia'] = anonymous ? (anonymous.code === 0 ? 'anonymous' : 'credentials') : null;

      if (!write) {
        return withDetails({
          state: 'readable',
          read: 'ok',
          write: 'unknown',
          readVia,
          message: branch ? 'No commits yet, so push access cannot be tested' : 'Detached HEAD, so push access cannot be tested',
        });
      }

      if (dryRunReachedReceivePack(write)) {
        return withDetails({ state: 'read-write', read: 'ok', write: 'ok', readVia, message: null });
      }

      const writeKind = classifyGitFailure(write.stderr, write.timedOut);
      if (writeKind === 'auth' || writeKind === 'not-found') {
        return withDetails({
          state: 'read-only',
          read: 'ok',
          write: 'denied',
          readVia,
          message: lastMessage(write.stderr),
        });
      }

      return withDetails({
        state: 'readable',
        read: 'ok',
        write: 'unknown',
        readVia,
        message: write.timedOut ? 'The remote did not answer in time' : lastMessage(write.stderr),
      });
    };

    return { key, compute };
  }

  return async ({ repositoryPath, force = false }) => {
    const { key, compute } = await probe(repositoryPath);

    if (!force) {
      const cached = cache.get(key);
      if (cached && now() - cached.at < CACHE_TTL_MS) {
        return cached.value;
      }
    }

    const running = inflight.get(key);
    if (running) return running;

    const promise = compute()
      .then((value) => {
        cache.set(key, { at: now(), value });
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  };
}

/** Process-wide checker used by the git routes. */
export const checkRemoteAccess = createRemoteAccessChecker();
