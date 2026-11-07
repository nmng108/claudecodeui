import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { AppError } from '@/shared/utils.js';

import type { SshKeyInfo, SshKeyProvider } from '../ssh-key-provider.js';
import { createSshKeysRouter } from '../ssh-keys.routes.js';

const present: SshKeyInfo = {
  status: 'present',
  origin: 'generated',
  type: 'ED25519',
  publicKey: 'ssh-ed25519 AAAA cloudcli@host',
  fingerprint: 'SHA256:abc',
  comment: 'cloudcli@host',
  location: '~/.ssh/id_ed25519',
  canGenerate: false,
  canReplace: true,
  reason: null,
  provider: 'native',
};

async function withRouter(provider: SshKeyProvider, run: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  app.use('/api/ssh-keys', createSshKeysRouter(provider));
  app.use((error: AppError, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? 500).json({ success: false, error: { code: error.code, message: error.message } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ssh-keys`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET returns the key state', async () => {
  await withRouter({ getKey: async () => present, generateKey: async () => present }, async (base) => {
    const body = await (await fetch(base)).json() as { success: boolean; data: SshKeyInfo };
    assert.equal(body.success, true);
    assert.equal(body.data.fingerprint, 'SHA256:abc');
  });
});

test('POST /generate passes replace through and only accepts a boolean', async () => {
  const calls: unknown[] = [];
  const provider: SshKeyProvider = {
    getKey: async () => present,
    generateKey: async (options) => { calls.push(options); return present; },
  };
  await withRouter(provider, async (base) => {
    const post = (body: unknown) => fetch(`${base}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

    assert.equal((await post({})).status, 200);
    assert.equal((await post({ replace: true })).status, 200);
    assert.equal((await post({ replace: 'yes' })).status, 400);
    assert.deepEqual(calls, [{ replace: false }, { replace: true }]);
  });
});

test('provider errors keep their status', async () => {
  const provider: SshKeyProvider = {
    getKey: async () => present,
    generateKey: async () => { throw new AppError('exists', { code: 'SSH_KEY_EXISTS', statusCode: 409 }); },
  };
  await withRouter(provider, async (base) => {
    const response = await fetch(`${base}/generate`, { method: 'POST' });
    assert.equal(response.status, 409);
  });
});