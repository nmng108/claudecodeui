// Starts the CloudCLI API server against a throwaway sandbox for the browser
// end-to-end tests: its own HOME (so ~/.kiro and ~/.cloudcli are isolated),
// its own database, and a fake `kiro-cli` that speaks the v3 ACP protocol.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = path.join(repoRoot, '.e2e-run');
const SERVER_PORT = process.env.E2E_SERVER_PORT || '3101';

function prepareSandbox() {
  rmSync(SANDBOX, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  const home = path.join(SANDBOX, 'home');
  const bin = path.join(SANDBOX, 'bin');
  const workspace = path.join(home, 'workspace');
  for (const dir of [home, bin, workspace]) {
    mkdirSync(dir, { recursive: true });
  }

  // `kiro-cli acp ...` is the chat integration (a fake ACP agent); any other
  // launch is the interactive CLI the Shell tab opens (a recording stand-in).
  const fixtures = path.join(repoRoot, 'server', 'modules', 'providers', 'tests', 'fixtures');
  const node = (file) =>
    `"${process.execPath}" --experimental-strip-types --disable-warning=ExperimentalWarning "${path.join(fixtures, file)}"`;
  const agent = node('kiro-fake-agent.ts');
  const interactive = node('kiro-fake-interactive.ts');
  let cli;
  if (process.platform === 'win32') {
    cli = path.join(bin, 'kiro-cli.cmd');
    writeFileSync(
      cli,
      `@echo off\r\nif /I "%~1"=="acp" (\r\n${agent} %*\r\n) else (\r\n${interactive} %*\r\n)\r\n`,
    );
  } else {
    cli = path.join(bin, 'kiro-cli');
    writeFileSync(cli, `#!/bin/sh\nif [ "$1" = "acp" ]; then exec ${agent} "$@"; else exec ${interactive} "$@"; fi\n`);
    chmodSync(cli, 0o755);
  }
  // An existing (empty) database file stops the server from copying the legacy
  // install-directory database, which could hold a developer's real users.
  writeFileSync(path.join(SANDBOX, 'auth.db'), '');
  return { home, cli };
}

const { home, cli } = prepareSandbox();
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
const child = spawn('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', 'server/index.ts'], {
  cwd: repoRoot,
  shell: true,
  stdio: 'inherit',
  env: {
    ...process.env,
    // The Shell tab launches a bare `kiro-cli`, so the stand-in must come first on PATH.
    [pathKey]: `${path.join(SANDBOX, 'bin')}${path.delimiter}${process.env[pathKey] ?? ''}`,
    HOST: '127.0.0.1',
    SERVER_PORT,
    PORT: SERVER_PORT,
    DATABASE_PATH: path.join(SANDBOX, 'auth.db'),
    HOME: home,
    USERPROFILE: home,
    KIRO_CLI_PATH: cli,
    KIRO_API_KEY: 'e2e-fake-key',
    KIRO_FAKE_AGENT_HOME_SESSIONS: '1',
  },
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
