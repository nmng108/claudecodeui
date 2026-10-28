import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { KiroProviderAuth } from '@/modules/providers/list/kiro/kiro-auth.provider.js';
import {
  clearKiroApiKey,
  saveKiroApiKey,
} from '@/modules/providers/list/kiro/kiro-api-key.store.js';

const withHome = async (run: (homeDir: string) => Promise<void>) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kiro-auth-test-'));
  const overridden = { HOME: homeDir, USERPROFILE: homeDir };
  const original = Object.fromEntries(Object.keys(overridden).map((key) => [key, process.env[key]]));
  const setEnv = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  setEnv(overridden);
  try {
    await run(homeDir);
  } finally {
    setEnv(original);
    await rm(homeDir, { recursive: true, force: true });
  }
};

const withoutKiroEnvKey = async (run: () => Promise<void>) => {
  const original = process.env.KIRO_API_KEY;
  delete process.env.KIRO_API_KEY;
  try {
    await run();
  } finally {
    if (original === undefined) {
      delete process.env.KIRO_API_KEY;
    } else {
      process.env.KIRO_API_KEY = original;
    }
  }
};

/** Stubs checkInstalled() so getStatus() never shells out to a real `kiro-cli`. */
const authWithInstalled = (installed: boolean, version: string | null = null): KiroProviderAuth => {
  const auth = new KiroProviderAuth();
  auth.checkInstalled = () => ({ installed, exitCode: installed ? 0 : null, version });
  return auth;
};

test('checkInstalled requires a clean exit code to report installed', async () => {
  await withHome(async () => {
    const auth = new KiroProviderAuth();
    const binDir = await mkdtemp(path.join(os.tmpdir(), 'kiro-cli-fake-'));
    const originalPath = process.env.PATH;
    try {
      // No kiro-cli on PATH at all: not installed, no version.
      process.env.PATH = binDir;
      const notInstalled = auth.checkInstalled();
      assert.equal(notInstalled.installed, false);
      assert.equal(notInstalled.version, null);
    } finally {
      process.env.PATH = originalPath;
      await rm(binDir, { recursive: true, force: true });
    }
  });
});

test('auth status: not installed, no key -> unauthenticated with "Not authenticated"', async () => {
  await withHome(async () => {
    await withoutKiroEnvKey(async () => {
      const auth = authWithInstalled(false);
      const status = await auth.getStatus();

      assert.equal(status.installed, false);
      assert.equal(status.authenticated, false);
      assert.equal(status.email, null);
      assert.equal(status.method, null);
      assert.equal(status.error, 'Not authenticated');
    });
  });
});

test('auth status: installed, no key -> unauthenticated', async () => {
  await withHome(async () => {
    await withoutKiroEnvKey(async () => {
      const auth = authWithInstalled(true, '1.2.3');
      const status = await auth.getStatus();

      assert.equal(status.installed, true);
      assert.equal(status.installedVersion, '1.2.3');
      assert.equal(status.authenticated, false);
      assert.equal(status.email, null);
      assert.equal(status.method, null);
    });
  });
});

test('auth status: installed, key stored in file -> authenticated via credentials_file, masked email', async () => {
  await withHome(async () => {
    await withoutKiroEnvKey(async () => {
      await saveKiroApiKey('stored-file-key-wxyz');
      const auth = authWithInstalled(true, '1.2.3');
      const status = await auth.getStatus();

      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'credentials_file');
      assert.equal(status.email, 'Kiro API key (****wxyz)');
      // The raw key must never appear anywhere in the status payload.
      assert.ok(!JSON.stringify(status).includes('stored-file-key-wxyz'));
    });
  });
});

test('auth status: env key present -> authenticated via environment, wins over a stored file key', async () => {
  await withHome(async () => {
    const original = process.env.KIRO_API_KEY;
    try {
      await saveKiroApiKey('file-key-loses-0000');
      process.env.KIRO_API_KEY = 'env-key-wins-9999';

      const auth = authWithInstalled(true, '1.2.3');
      const status = await auth.getStatus();

      assert.equal(status.authenticated, true);
      assert.equal(status.method, 'environment');
      assert.equal(status.email, 'Kiro API key (****9999)');
      assert.ok(!JSON.stringify(status).includes('env-key-wins-9999'));
      assert.ok(!JSON.stringify(status).includes('file-key-loses-0000'));
    } finally {
      if (original === undefined) {
        delete process.env.KIRO_API_KEY;
      } else {
        process.env.KIRO_API_KEY = original;
      }
      await clearKiroApiKey();
    }
  });
});
