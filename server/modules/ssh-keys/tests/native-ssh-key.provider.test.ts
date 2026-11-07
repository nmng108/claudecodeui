import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createNativeSshKeyProvider, parsePublicKey } from '../native-ssh-key.provider.js';

function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ssh-keys-'));
  return run(directory).finally(() => rmSync(directory, { recursive: true, force: true }));
}

const keygen = (...args: string[]) => execFileSync('ssh-keygen', args, { stdio: 'pipe' }).toString();

test('reports a missing key and that one can be generated', async () => {
  await withDirectory(async (directory) => {
    const info = await createNativeSshKeyProvider({ sshDirectory: path.join(directory, '.ssh') }).getKey();
    assert.equal(info.status, 'missing');
    assert.equal(info.canGenerate, true);
    assert.equal(info.publicKey, null);
  });
});

test('generates an ed25519 key whose fingerprint matches ssh-keygen and never exposes the private key', async () => {
  await withDirectory(async (directory) => {
    const sshDirectory = path.join(directory, '.ssh');
    const provider = createNativeSshKeyProvider({ sshDirectory, hostname: () => 'my host' });

    const info = await provider.generateKey();

    assert.equal(info.status, 'present');
    assert.equal(info.origin, 'generated');
    assert.equal(info.type, 'ED25519');
    assert.equal(info.canReplace, true);
    assert.equal(info.canGenerate, false);
    assert.match(info.publicKey ?? '', /^ssh-ed25519 \S+ cloudcli@my-host$/);

    const expected = keygen('-lf', path.join(sshDirectory, 'id_ed25519.pub')).split(' ')[1];
    assert.equal(info.fingerprint, expected);

    const serialized = JSON.stringify(info);
    assert.equal(serialized.includes('PRIVATE KEY'), false);
    const privateBody = readFileSync(path.join(sshDirectory, 'id_ed25519'), 'utf8');
    assert.ok(privateBody.includes('PRIVATE KEY'));
    assert.equal(serialized.includes(privateBody.split('\n')[1]), false);

    if (process.platform !== 'win32') {
      assert.equal(statSync(path.join(sshDirectory, 'id_ed25519')).mode & 0o777, 0o600);
      assert.equal(statSync(sshDirectory).mode & 0o777, 0o700);
    }
    // Only the key pair is left; no temporary files.
    assert.deepEqual(readdirSync(sshDirectory).sort(), ['id_ed25519', 'id_ed25519.pub']);
  });
});

test('refuses to generate over an existing key unless replacing a generated one', async () => {
  await withDirectory(async (directory) => {
    const provider = createNativeSshKeyProvider({ sshDirectory: path.join(directory, '.ssh') });
    const first = await provider.generateKey();

    await assert.rejects(provider.generateKey(), { code: 'SSH_KEY_EXISTS', statusCode: 409 });

    const second = await provider.generateKey({ replace: true });
    assert.equal(second.status, 'present');
    assert.notEqual(second.fingerprint, first.fingerprint);
  });
});

test('never touches a key the user brought', async () => {
  await withDirectory(async (directory) => {
    const sshDirectory = path.join(directory, '.ssh');
    keygen('-q', '-t', 'ed25519', '-N', '', '-C', 'me@laptop', '-f', path.join(directory, 'id_ed25519'));
    const { mkdirSync, copyFileSync } = await import('node:fs');
    mkdirSync(sshDirectory);
    copyFileSync(path.join(directory, 'id_ed25519'), path.join(sshDirectory, 'id_ed25519'));
    copyFileSync(path.join(directory, 'id_ed25519.pub'), path.join(sshDirectory, 'id_ed25519.pub'));
    const before = readFileSync(path.join(sshDirectory, 'id_ed25519'), 'utf8');

    const provider = createNativeSshKeyProvider({ sshDirectory });
    const info = await provider.getKey();

    assert.equal(info.status, 'present');
    assert.equal(info.origin, 'existing');
    assert.equal(info.comment, 'me@laptop');
    assert.equal(info.canReplace, false);
    assert.equal(info.canGenerate, false);

    await assert.rejects(provider.generateKey({ replace: true }), { code: 'SSH_KEY_NOT_REPLACEABLE', statusCode: 403 });
    await assert.rejects(provider.generateKey(), { code: 'SSH_KEY_EXISTS' });
    assert.equal(readFileSync(path.join(sshDirectory, 'id_ed25519'), 'utf8'), before);
  });
});

test('derives the public key when only the private key is present', async () => {
  await withDirectory(async (directory) => {
    keygen('-q', '-t', 'ed25519', '-N', '', '-C', 'orphan', '-f', path.join(directory, 'id_ed25519'));
    rmSync(path.join(directory, 'id_ed25519.pub'));

    const info = await createNativeSshKeyProvider({ sshDirectory: directory }).getKey();
    assert.equal(info.status, 'present');
    assert.match(info.publicKey ?? '', /^ssh-ed25519 /);
  });
});

test('a passphrase-protected key without a .pub file is reported as unreadable, not prompted for', async () => {
  await withDirectory(async (directory) => {
    keygen('-q', '-t', 'ed25519', '-N', 'secret phrase', '-f', path.join(directory, 'id_ed25519'));
    rmSync(path.join(directory, 'id_ed25519.pub'));

    const info = await createNativeSshKeyProvider({ sshDirectory: directory }).getKey();
    assert.equal(info.status, 'unreadable');
    assert.equal(info.reason, 'passphrase-or-unreadable');
    assert.equal(info.publicKey, null);
    assert.equal(info.canGenerate, false);
  });
});

test('reports a missing ssh-keygen instead of failing obscurely', async () => {
  await withDirectory(async (directory) => {
    const provider = createNativeSshKeyProvider({
      sshDirectory: path.join(directory, '.ssh'),
      runKeygen: async () => ({ stdout: '', stderr: '', code: null, missing: true }),
    });
    await assert.rejects(provider.generateKey(), { code: 'SSH_KEYGEN_MISSING', statusCode: 501 });
    assert.equal(existsSync(path.join(directory, '.ssh', 'id_ed25519')), false);
  });
});

test('a failed generation leaves no key and no temporary files', async () => {
  await withDirectory(async (directory) => {
    const sshDirectory = path.join(directory, '.ssh');
    const provider = createNativeSshKeyProvider({
      sshDirectory,
      runKeygen: async (args) => {
        // Behave like a keygen that wrote the private half and then died.
        writeFileSync(args[args.indexOf('-f') + 1], 'partial');
        return { stdout: '', stderr: 'disk full', code: 1, missing: false };
      },
    });
    await assert.rejects(provider.generateKey(), { code: 'SSH_KEYGEN_FAILED' });
    assert.deepEqual(readdirSync(sshDirectory), []);
  });
});

test('two simultaneous generate requests create one key', async () => {
  await withDirectory(async (directory) => {
    const provider = createNativeSshKeyProvider({ sshDirectory: path.join(directory, '.ssh') });
    const results = await Promise.allSettled([provider.generateKey(), provider.generateKey()]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    assert.equal((rejected.reason as { code: string }).code, 'SSH_KEY_EXISTS');
  });
});

test('parsePublicKey rejects anything that is not a public key', () => {
  assert.equal(parsePublicKey(''), null);
  assert.equal(parsePublicKey('hello world'), null);
  assert.equal(parsePublicKey('-----BEGIN OPENSSH PRIVATE KEY-----'), null);
  assert.equal(parsePublicKey('ssh-ed25519 not*base64'), null);
  assert.equal(parsePublicKey('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host')?.type, 'ED25519');
});