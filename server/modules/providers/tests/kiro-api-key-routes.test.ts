import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import providerRouter from '@/modules/providers/provider.routes.js';
import { AppError } from '@/shared/utils.js';

async function withProviderServer(
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'kiro-api-key-routes-'));
  const homeOverrides = { HOME: tempDirectory, USERPROFILE: tempDirectory };
  const previousHome = Object.fromEntries(Object.keys(homeOverrides).map((key) => [key, process.env[key]]));
  const previousKiroEnvKey = process.env.KIRO_API_KEY;
  delete process.env.KIRO_API_KEY;
  Object.assign(process.env, homeOverrides);

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express().use(express.json()).use('/api/providers', providerRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    for (const [key, value] of Object.entries(previousHome)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (previousKiroEnvKey === undefined) {
      delete process.env.KIRO_API_KEY;
    } else {
      process.env.KIRO_API_KEY = previousKiroEnvKey;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('POST /api/providers/kiro/api-key saves the key and never echoes it back', async () => {
  await withProviderServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/providers/kiro/api-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'a-fresh-stored-key-wxyz' }),
    });
    const payload = await response.json() as { data: { provider: string; source: string; masked: string } };

    assert.equal(response.status, 200);
    assert.equal(payload.data.provider, 'kiro');
    assert.equal(payload.data.source, 'file');
    assert.equal(payload.data.masked, '****wxyz');
    assert.ok(!JSON.stringify(payload).includes('a-fresh-stored-key-wxyz'));

    const statusResponse = await fetch(`${baseUrl}/api/providers/kiro/auth/status`);
    const statusPayload = await statusResponse.json() as { data: { authenticated: boolean; method: string; email: string } };
    assert.equal(statusPayload.data.authenticated, true);
    assert.equal(statusPayload.data.method, 'credentials_file');
    assert.equal(statusPayload.data.email, 'Kiro API key (****wxyz)');
  });
});

test('POST /api/providers/kiro/api-key rejects an invalid key with 400 and does not store it', async () => {
  await withProviderServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/providers/kiro/api-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'short' }),
    });
    const payload = await response.json() as { success: false; error: { code: string } };

    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, 'KIRO_API_KEY_INVALID');

    const statusResponse = await fetch(`${baseUrl}/api/providers/kiro/auth/status`);
    const statusPayload = await statusResponse.json() as { data: { authenticated: boolean } };
    assert.equal(statusPayload.data.authenticated, false);
  });
});

test('POST /api/providers/kiro/api-key rejects a missing apiKey field with 400', async () => {
  await withProviderServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/providers/kiro/api-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = await response.json() as { success: false; error: { code: string } };

    assert.equal(response.status, 400);
    assert.equal(payload.error.code, 'KIRO_API_KEY_REQUIRED');
  });
});

test('DELETE /api/providers/kiro/api-key clears the stored key', async () => {
  await withProviderServer(async (baseUrl) => {
    await fetch(`${baseUrl}/api/providers/kiro/api-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'a-key-that-gets-cleared-0000' }),
    });

    const deleteResponse = await fetch(`${baseUrl}/api/providers/kiro/api-key`, { method: 'DELETE' });
    const deletePayload = await deleteResponse.json() as { data: { provider: string; source: string; masked: string | null } };

    assert.equal(deleteResponse.status, 200);
    assert.equal(deletePayload.data.source, 'none');
    assert.equal(deletePayload.data.masked, null);
    assert.ok(!JSON.stringify(deletePayload).includes('a-key-that-gets-cleared-0000'));

    const statusResponse = await fetch(`${baseUrl}/api/providers/kiro/auth/status`);
    const statusPayload = await statusResponse.json() as { data: { authenticated: boolean } };
    assert.equal(statusPayload.data.authenticated, false);
  });
});

test('DELETE /api/providers/kiro/api-key is a no-op when no key is stored', async () => {
  await withProviderServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/providers/kiro/api-key`, { method: 'DELETE' });
    const payload = await response.json() as { data: { source: string } };

    assert.equal(response.status, 200);
    assert.equal(payload.data.source, 'none');
  });
});
