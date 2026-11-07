import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { KiroProviderAuth } from '@/modules/providers/list/kiro/kiro-auth.provider.js';
import {
  buildKiroLoginArgs,
  cancelKiroLogin,
  getKiroCliLogin,
  getKiroLoginState,
  logoutKiroCli,
  parseKiroLoginOutput,
  resetKiroLoginForTesting,
  startKiroLogin,
} from '@/modules/providers/list/kiro/kiro-login.service.js';
import { AppError } from '@/shared/utils.js';

const FIXTURE_PATH = path.resolve('server/modules/providers/tests/fixtures/kiro-fake-login-cli.mjs');

async function installFakeCli(dir: string): Promise<string> {
  const run = `"${process.execPath}" "${FIXTURE_PATH}"`;
  if (process.platform === 'win32') {
    const cli = path.join(dir, 'kiro-cli.cmd');
    await writeFile(cli, `@echo off\r\n${run} %*\r\n`);
    return cli;
  }
  const cli = path.join(dir, 'kiro-cli');
  await writeFile(cli, `#!/bin/sh\nexec ${run} "$@"\n`);
  await chmod(cli, 0o755);
  return cli;
}

async function withFakeCli(mode: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'kiro-login-'));
  const names = ['KIRO_CLI_PATH', 'KIRO_FAKE_LOGIN_MODE', 'KIRO_FAKE_LOGIN_DIR', 'KIRO_API_KEY'] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    process.env.KIRO_CLI_PATH = await installFakeCli(dir);
    process.env.KIRO_FAKE_LOGIN_MODE = mode;
    process.env.KIRO_FAKE_LOGIN_DIR = dir;
    process.env.KIRO_API_KEY = 'must-not-reach-the-login-command';
    resetKiroLoginForTesting();
    await run(dir);
  } finally {
    resetKiroLoginForTesting();
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
}

async function waitForStatus(status: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getKiroLoginState().status !== status) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${status}, got ${getKiroLoginState().status}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test('parseKiroLoginOutput reads the URL and code and ignores colour codes', () => {
  const output = '\u001b[1mConfirm\u001b[0m\nCode: RKLZ-RDPX\n\nOpen this URL: https://view.awsapps.com/start/#/device?user_code=RKLZ-RDPX\n';
  assert.deepEqual(parseKiroLoginOutput(output), {
    verificationUrl: 'https://view.awsapps.com/start/#/device?user_code=RKLZ-RDPX',
    userCode: 'RKLZ-RDPX',
  });
  assert.deepEqual(parseKiroLoginOutput('Logging in...'), { verificationUrl: null, userCode: null });
  // A non-https link is never offered to the user.
  assert.equal(parseKiroLoginOutput('Open this URL: http://evil.example/x').verificationUrl, null);
});

test('buildKiroLoginArgs: Builder ID needs no input, Identity Center validates URL and region', () => {
  assert.deepEqual(buildKiroLoginArgs({ method: 'builder-id' }), ['login', '--license', 'free', '--use-device-flow']);
  assert.deepEqual(
    buildKiroLoginArgs({ method: 'identity-center', startUrl: ' https://d-123.awsapps.com/start ', region: 'eu-central-1' }),
    ['login', '--license', 'pro', '--identity-provider', 'https://d-123.awsapps.com/start', '--region', 'eu-central-1', '--use-device-flow'],
  );

  const rejected = (input: Parameters<typeof buildKiroLoginArgs>[0]) =>
    assert.throws(() => buildKiroLoginArgs(input), (error) => error instanceof AppError && error.statusCode === 400);
  rejected({ method: 'identity-center', region: 'us-east-1' });
  rejected({ method: 'identity-center', startUrl: 'https://d-1.awsapps.com/start' });
  rejected({ method: 'identity-center', startUrl: 'http://d-1.awsapps.com/start', region: 'us-east-1' });
  rejected({ method: 'identity-center', startUrl: 'https://user:pw@d-1.awsapps.com/start', region: 'us-east-1' });
  rejected({ method: 'identity-center', startUrl: 'https://d-1.awsapps.com/start', region: 'US EAST; rm -rf' });
  rejected({ method: 'nope' as never });
});

test('sign-in succeeds: URL and code are reported, then the CLI login shows up', async () => {
  await withFakeCli('success', async (dir) => {
    assert.equal(await getKiroCliLogin(), null);

    const started = await startKiroLogin({ method: 'builder-id' });
    assert.equal(started.status, 'awaiting_confirmation');
    assert.equal(started.userCode, 'ABCD-EFGH');
    assert.equal(started.verificationUrl, 'https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH');

    await waitForStatus('succeeded');
    assert.equal(getKiroLoginState().error, null);
    assert.deepEqual(await getKiroCliLogin(), { label: 'dev@example.com' });

    const [recorded] = (await readFile(path.join(dir, 'login-args.txt'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(recorded.args, ['--license', 'free', '--use-device-flow']);
    assert.equal(recorded.hasApiKey, false, 'KIRO_API_KEY must not be passed to the login command');

    await logoutKiroCli();
    assert.equal(await getKiroCliLogin(), null);
    assert.equal(getKiroLoginState().status, 'idle');
  });
});

test('sign-in failure reports the CLI error, without progress-bar noise', async () => {
  await withFakeCli('fail', async () => {
    await startKiroLogin({ method: 'builder-id' });
    await waitForStatus('failed');
    assert.equal(getKiroLoginState().error, 'error: the device code expired');
  });
});

test('cancelling stops the CLI and a new sign-in replaces a running one', async () => {
  await withFakeCli('hang', async () => {
    const first = await startKiroLogin({ method: 'builder-id' });
    assert.equal(first.status, 'awaiting_confirmation');

    const cancelled = cancelKiroLogin();
    assert.equal(cancelled.status, 'cancelled');

    const second = await startKiroLogin({ method: 'builder-id' });
    assert.equal(second.status, 'awaiting_confirmation');
    cancelKiroLogin();
    assert.equal(getKiroLoginState().status, 'cancelled');
  });
});

test('a missing kiro-cli fails the sign-in with a clear message', async () => {
  await withFakeCli('success', async (dir) => {
    process.env.KIRO_CLI_PATH = path.join(dir, 'does-not-exist');
    const state = await startKiroLogin({ method: 'builder-id' });
    assert.equal(state.status, 'failed');
    assert.match(state.error ?? '', /not found/i);
  });
});

test('auth status: a CLI sign-in counts when no API key is set, and an API key wins over it', async () => {
  await withFakeCli('success', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'kiro-login-home-'));
    const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      await startKiroLogin({ method: 'builder-id' });
      await waitForStatus('succeeded');

      const auth = new KiroProviderAuth();
      auth.checkInstalled = () => ({ installed: true, exitCode: 0, version: '2.37.1' });

      delete process.env.KIRO_API_KEY;
      const viaLogin = await auth.getStatus();
      assert.equal(viaLogin.authenticated, true);
      assert.equal(viaLogin.method, 'cli_login');
      assert.equal(viaLogin.email, 'Kiro sign-in (dev@example.com)');

      process.env.KIRO_API_KEY = 'env-key-wins-9999';
      const viaKey = await auth.getStatus();
      assert.equal(viaKey.method, 'environment');
    } finally {
      for (const [name, value] of Object.entries(savedHome)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(home, { recursive: true, force: true });
    }
  });
});