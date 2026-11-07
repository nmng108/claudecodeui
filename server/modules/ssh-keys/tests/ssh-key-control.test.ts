import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAgentSshKeyProvider } from '../agent-ssh-key.provider.js';
import { createControlHandler, createSshKeyCore } from '../ssh-key-core.js';

// The sidecar's control API and the app-side provider talk over a unix socket in
// production; the tests use TCP on loopback, which exercises the same HTTP code.

async function withSidecar(
  run: (context: { provider: ReturnType<typeof createAgentSshKeyProvider>; reloads: number; directory: string; port: number }) => Promise<void>,
) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ssh-sidecar-'));
  const state = { reloads: 0 };
  const core = createSshKeyCore({ sshDirectory: directory, providerName: 'agent' });
  const server = http.createServer(createControlHandler({
    core,
    onKeyChanged: async () => { state.reloads += 1; },
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  const provider = createAgentSshKeyProvider({ endpoint: { host: '127.0.0.1', port } });

  try {
    await run({
      provider,
      get reloads() { return state.reloads; },
      directory,
      port,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
}

test('reports a missing key, creates one on request and loads it into the agent', async () => {
  await withSidecar(async (context) => {
    const missing = await context.provider.getKey();
    assert.equal(missing.status, 'missing');
    assert.equal(missing.provider, 'agent');
    assert.equal(missing.canGenerate, true);

    const created = await context.provider.generateKey();
    assert.equal(created.status, 'present');
    assert.equal(created.origin, 'generated');
    assert.match(created.publicKey ?? '', /^ssh-ed25519 /);
    assert.equal(context.reloads, 1);

    const again = await context.provider.getKey();
    assert.equal(again.fingerprint, created.fingerprint);
  });
});

test('the app can never see or replace the private key through the control API', async () => {
  await withSidecar(async (context) => {
    const created = await context.provider.generateKey();
    assert.equal(created.canReplace, false);
    assert.equal(JSON.stringify(created).includes('PRIVATE KEY'), false);

    await assert.rejects(context.provider.generateKey({ replace: true }), {
      code: 'SSH_KEY_REPLACE_DISABLED',
      statusCode: 403,
    });
    await assert.rejects(context.provider.generateKey(), { code: 'SSH_KEY_EXISTS', statusCode: 409 });
    assert.equal(context.reloads, 1, 'refused requests do not reload the agent');

    // Nothing but /health, /key and /generate is served.
    for (const [method, route] of [['GET', '/keys/id_ed25519'], ['GET', '/private'], ['DELETE', '/key']] as const) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: context.port, method, path: route }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(status, 404, `${method} ${route}`);
    }
  });
});

test('rejects a malformed generate request', async () => {
  await withSidecar(async (context) => {
    const send = (body: string) => new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: context.port, method: 'POST', path: '/generate', headers: { 'content-type': 'application/json' } },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); },
      );
      req.on('error', reject);
      req.end(body);
    });

    assert.equal(await send('{not json'), 400);
    assert.equal(await send(JSON.stringify({ replace: 'yes' })), 400);
    assert.equal(await send('x'.repeat(10_000)), 413);
  });
});

test('answers a health check', async () => {
  await withSidecar(async (context) => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: context.port, path: '/health' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 200);
  });
});

test('reports an unreachable sidecar as 503 instead of hanging', async () => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const provider = createAgentSshKeyProvider({ endpoint: { host: '127.0.0.1', port } });
  await assert.rejects(provider.getKey(), { code: 'SSH_KEY_SERVICE_UNAVAILABLE', statusCode: 503 });
});