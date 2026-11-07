import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  classifyGitFailure,
  createRemoteAccessChecker,
  describeRemoteUrl,
  redactCredentials,
  type GitCommandResult,
  type GitCommandRunner,
} from '../git-remote-access.service.js';

const ok = (stdout = ''): GitCommandResult => ({ code: 0, stdout, stderr: '', timedOut: false });
const fail = (stderr: string, code = 128): GitCommandResult => ({ code, stdout: '', stderr, timedOut: false });

type Script = {
  remotes?: string[];
  url?: string;
  branch?: string | null;
  hasCommits?: boolean;
  read?: GitCommandResult;
  write?: GitCommandResult;
  anonymous?: GitCommandResult;
};

/** Builds a git runner that answers from a script and records every call. */
function scriptedRunner(script: Script) {
  const calls: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const run: GitCommandRunner = async (args, options) => {
    calls.push(args);
    envs.push(options.env);
    const [command] = args;
    if (command === 'remote' && args[1] === 'get-url') return ok(`${script.url ?? 'https://example.com/a/b.git'}\n`);
    if (command === 'remote') return ok((script.remotes ?? ['origin']).join('\n'));
    if (command === 'symbolic-ref') {
      return script.branch === null ? fail('', 1) : ok(`${script.branch ?? 'main'}\n`);
    }
    if (command === 'rev-parse' && args.includes('--verify')) {
      return script.hasCommits === false ? fail('', 1) : ok('abc\n');
    }
    if (command === 'rev-parse') return fail('no upstream');
    if (command === 'config') return fail('', 1);
    if (command === 'ls-remote') return script.read ?? ok('abc\tHEAD\n');
    if (command === 'push') return script.write ?? ok();
    if (command === '-c') return script.anonymous ?? fail('could not read Username');
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
  return { run, calls, envs };
}

const check = (script: Script, extra: { force?: boolean } = {}) => {
  const { run, calls, envs } = scriptedRunner(script);
  const checker = createRemoteAccessChecker({ run, env: {}, now: () => 1_000 });
  return checker({ repositoryPath: '/repo', ...extra }).then((result) => ({ result, calls, envs }));
};

test('a repository with credentials that can push is read-write', async () => {
  const { result } = await check({});
  assert.equal(result.state, 'read-write');
  assert.equal(result.read, 'ok');
  assert.equal(result.write, 'ok');
  assert.equal(result.remote, 'origin');
  assert.equal(result.transport, 'https');
  assert.equal(result.host, 'example.com');
  assert.equal(result.readVia, 'credentials');
});

test('a public repository without push rights is read-only and readable anonymously', async () => {
  const { result } = await check({
    write: fail("remote: Permission to a/b.git denied to someone.\nfatal: unable to access 'https://example.com/a/b.git/': The requested URL returned error: 403"),
    anonymous: ok('abc\tHEAD\n'),
  });
  assert.equal(result.state, 'read-only');
  assert.equal(result.read, 'ok');
  assert.equal(result.write, 'denied');
  assert.equal(result.readVia, 'anonymous');
});

test('a read-only deploy key over ssh is read-only', async () => {
  const { result } = await check({
    url: 'git@github.com:a/b.git',
    write: fail('ERROR: The key you are authenticated with has been marked as read only.\nfatal: Could not read from remote repository.'),
  });
  assert.equal(result.state, 'read-only');
  assert.equal(result.transport, 'ssh');
  assert.equal(result.host, 'github.com');
  // The anonymous probe only makes sense for http(s).
  assert.equal(result.readVia, null);
});

test('a rejected non-fast-forward dry run still proves push access', async () => {
  const { result } = await check({
    write: fail(' ! [rejected]        HEAD -> main (non-fast-forward)\nerror: failed to push some refs', 1),
  });
  assert.equal(result.state, 'read-write');
});

test('a private repository without credentials has no access', async () => {
  const { result } = await check({
    read: fail("fatal: could not read Username for 'https://example.com': terminal prompts disabled"),
  });
  assert.equal(result.state, 'no-access');
  assert.equal(result.read, 'denied');
  assert.equal(result.write, 'unknown');
});

test('an unknown ssh host key is reported separately from a rejected key', async () => {
  const { result } = await check({
    url: 'ssh://git@example.com/a/b.git',
    read: fail('Host key verification failed.\nfatal: Could not read from remote repository.'),
  });
  assert.equal(result.state, 'host-key');
});

test('a timeout is reported as unreachable', async () => {
  const { run } = scriptedRunner({});
  const timedOut: GitCommandRunner = async (args, options) =>
    args[0] === 'ls-remote' ? { code: null, stdout: '', stderr: '', timedOut: true } : run(args, options);
  const checker = createRemoteAccessChecker({ run: timedOut, env: {} });
  const result = await checker({ repositoryPath: '/repo' });
  assert.equal(result.state, 'unreachable');
  assert.equal(result.read, 'unknown');
});

test('a repository without commits is readable but its push access is unknown', async () => {
  const { result, calls } = await check({ hasCommits: false });
  assert.equal(result.state, 'readable');
  assert.equal(result.write, 'unknown');
  assert.equal(calls.some((args) => args[0] === 'push'), false);
});

test('a repository without a remote has nothing to check', async () => {
  const { result, calls } = await check({ remotes: [] });
  assert.equal(result.state, 'no-remote');
  assert.equal(calls.some((args) => args[0] === 'ls-remote'), false);
});

test('probes never prompt and never push anything', async () => {
  const { calls, envs } = await check({ url: 'git@example.com:a/b.git' });
  const push = calls.find((args) => args[0] === 'push');
  assert.ok(push);
  assert.ok(push.includes('--dry-run'));
  assert.ok(push.includes('--no-verify'));
  const probeEnv = envs[calls.findIndex((args) => args[0] === 'ls-remote')];
  assert.equal(probeEnv.GIT_TERMINAL_PROMPT, '0');
  assert.equal(probeEnv.GCM_INTERACTIVE, 'never');
  assert.match(String(probeEnv.GIT_SSH_COMMAND), /^ssh .*BatchMode=yes/);
});

test('a configured ssh command keeps its options and gains batch mode', async () => {
  const { run, envs, calls } = scriptedRunner({ url: 'git@example.com:a/b.git' });
  const checker = createRemoteAccessChecker({
    run,
    env: { GIT_SSH_COMMAND: 'ssh -i /keys/deploy' },
  });
  await checker({ repositoryPath: '/repo' });
  const env = envs[calls.findIndex((args) => args[0] === 'ls-remote')];
  assert.equal(env.GIT_SSH_COMMAND, 'ssh -i /keys/deploy -o BatchMode=yes -o ConnectTimeout=8');
});

test('results are cached for a minute and refreshed on demand', async () => {
  let clock = 1_000;
  const { run, calls } = scriptedRunner({});
  const checker = createRemoteAccessChecker({ run, env: {}, now: () => clock });
  const probes = () => calls.filter((args) => args[0] === 'ls-remote').length;

  await checker({ repositoryPath: '/repo' });
  await checker({ repositoryPath: '/repo' });
  assert.equal(probes(), 1);

  await checker({ repositoryPath: '/repo', force: true });
  assert.equal(probes(), 2);

  clock += 61_000;
  await checker({ repositoryPath: '/repo' });
  assert.equal(probes(), 3);
});

test('error output never carries URL credentials', async () => {
  const { result } = await check({
    url: 'https://user:s3cret@example.com/a/b.git',
    read: fail("fatal: unable to access 'https://user:s3cret@example.com/a/b.git/': Could not resolve host: example.com"),
  });
  assert.equal(JSON.stringify(result).includes('s3cret'), false);
  assert.equal(result.url, 'https://user@example.com/a/b.git');
});

test('classifyGitFailure sorts common failures', () => {
  const cases: Array<[string, ReturnType<typeof classifyGitFailure>]> = [
    ['git@github.com: Permission denied (publickey).', 'auth'],
    ["fatal: Authentication failed for 'https://github.com/a/b.git/'", 'auth'],
    ['remote: HTTP Basic: Access denied', 'auth'],
    ['remote: You are not allowed to push code to this project.', 'auth'],
    ['remote: Repository not found.\nfatal: repository \'https://github.com/a/b.git/\' not found', 'not-found'],
    ['ssh: Could not resolve hostname nope: Name or service not known\nCould not resolve host', 'unreachable'],
    ['ssh: connect to host example.com port 22: Connection timed out', 'unreachable'],
    ['Host key verification failed.', 'host-key'],
    ['@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@', 'host-key'],
    ['fatal: something unexpected', 'error'],
  ];
  for (const [stderr, expected] of cases) {
    assert.equal(classifyGitFailure(stderr), expected, stderr);
  }
  assert.equal(classifyGitFailure('', true), 'unreachable');
});

test('describeRemoteUrl understands the common remote syntaxes', () => {
  assert.deepEqual(
    (({ transport, host }) => ({ transport, host }))(describeRemoteUrl('https://github.com/a/b.git')),
    { transport: 'https', host: 'github.com' },
  );
  assert.deepEqual(
    (({ transport, host }) => ({ transport, host }))(describeRemoteUrl('git@gitlab.com:a/b.git')),
    { transport: 'ssh', host: 'gitlab.com' },
  );
  assert.deepEqual(
    (({ transport, host }) => ({ transport, host }))(describeRemoteUrl('ssh://git@host:2222/a/b.git')),
    { transport: 'ssh', host: 'host' },
  );
  assert.equal(describeRemoteUrl('C:\\repos\\b.git').transport, 'local');
  assert.equal(describeRemoteUrl('/srv/git/b.git').transport, 'local');
  assert.equal(describeRemoteUrl('file:///srv/git/b.git').transport, 'local');

  const withPassword = describeRemoteUrl('https://user:pw@example.com/a/b.git');
  assert.equal(withPassword.sanitizedUrl, 'https://user@example.com/a/b.git');
  assert.equal(withPassword.anonymousUrl, 'https://example.com/a/b.git');
});

test('redactCredentials strips passwords from any URL in a message', () => {
  assert.equal(
    redactCredentials("fatal: unable to access 'https://user:pw@example.com/x.git/'"),
    "fatal: unable to access 'https://***@example.com/x.git/'",
  );
});

test('against a real local remote, a clone can push', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'remote-access-'));
  try {
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    const bare = path.join(root, 'remote.git');
    const work = path.join(root, 'work');
    git(root, 'init', '--bare', '-b', 'main', bare);
    git(root, 'clone', bare, work);
    git(work, 'config', 'user.email', 't@example.com');
    git(work, 'config', 'user.name', 't');
    writeFileSync(path.join(work, 'a.txt'), 'a');
    git(work, 'add', '.');
    git(work, 'commit', '-m', 'init');
    git(work, 'push', '-u', 'origin', 'HEAD:main');

    const result = await createRemoteAccessChecker()({ repositoryPath: work });
    assert.equal(result.state, 'read-write');
    assert.equal(result.transport, 'local');
    assert.equal(result.remote, 'origin');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
