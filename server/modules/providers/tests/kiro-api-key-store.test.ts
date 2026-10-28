import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  clearKiroApiKey,
  getKiroApiKeyState,
  getKiroAuthFilePathForTesting,
  resolveKiroApiKey,
  saveKiroApiKey,
} from '@/modules/providers/list/kiro/kiro-api-key.store.js';
import { AppError } from '@/shared/utils.js';

// os.homedir() reads HOME on POSIX and USERPROFILE on Windows.
const withHome = async (run: (homeDir: string) => Promise<void>) => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kiro-api-key-store-'));
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

test('saveKiroApiKey writes an atomic file with restrictive modes (POSIX)', { skip: process.platform === 'win32' }, async () => {
  await withHome(async (homeDir) => {
    await withoutKiroEnvKey(async () => {
      await saveKiroApiKey('a-valid-key-1234');

      const filePath = getKiroAuthFilePathForTesting();
      assert.equal(filePath, path.join(homeDir, '.cloudcli', 'kiro-auth.json'));

      const fileStats = await stat(filePath);
      assert.equal(fileStats.mode & 0o777, 0o600);

      const dirStats = await stat(path.dirname(filePath));
      assert.equal(dirStats.mode & 0o777, 0o700);

      // No stray temp file left behind after a successful atomic write.
      const siblingEntries = await import('node:fs/promises').then((fs) => fs.readdir(path.dirname(filePath)));
      assert.deepEqual(siblingEntries, ['kiro-auth.json']);
    });
  });
});

test('getKiroApiKeyState reports "none" when neither env nor file has a key', async () => {
  await withHome(async () => {
    await withoutKiroEnvKey(async () => {
      const state = await getKiroApiKeyState();
      assert.deepEqual(state, { source: 'none', masked: null });
      assert.equal(await resolveKiroApiKey(), undefined);
    });
  });
});

test('getKiroApiKeyState reports "file" with a masked key after saveKiroApiKey', async () => {
  await withHome(async () => {
    await withoutKiroEnvKey(async () => {
      await saveKiroApiKey('abcd-very-secret-key-wxyz');

      const state = await getKiroApiKeyState();
      assert.equal(state.source, 'file');
      assert.equal(state.masked, '****wxyz');
      assert.equal(await resolveKiroApiKey(), 'abcd-very-secret-key-wxyz');
    });
  });
});

test('environment key takes precedence over a stored file key', async () => {
  await withHome(async () => {
    const original = process.env.KIRO_API_KEY;
    try {
      await saveKiroApiKey('file-key-should-lose-0000');
      process.env.KIRO_API_KEY = 'env-key-should-win-9999';

      const state = await getKiroApiKeyState();
      assert.equal(state.source, 'environment');
      assert.equal(state.masked, '****9999');
      assert.equal(await resolveKiroApiKey(), 'env-key-should-win-9999');
    } finally {
      if (original === undefined) {
        delete process.env.KIRO_API_KEY;
      } else {
        process.env.KIRO_API_KEY = original;
      }
    }
  });
});

test('saveKiroApiKey rejects keys that are too short, too long, or contain whitespace/control characters', async () => {
  await withHome(async () => {
    await withoutKiroEnvKey(async () => {
      await assert.rejects(
        () => saveKiroApiKey('short'),
        (error: unknown) => error instanceof AppError && error.code === 'KIRO_API_KEY_INVALID',
      );
      await assert.rejects(
        () => saveKiroApiKey('a'.repeat(4097)),
        (error: unknown) => error instanceof AppError && error.code === 'KIRO_API_KEY_INVALID',
      );
      await assert.rejects(
        () => saveKiroApiKey('has a space in it 1234'),
        (error: unknown) => error instanceof AppError && error.code === 'KIRO_API_KEY_INVALID',
      );
      await assert.rejects(
        () => saveKiroApiKey('has-a-tab\t-character-1'),
        (error: unknown) => error instanceof AppError && error.code === 'KIRO_API_KEY_INVALID',
      );
      await assert.rejects(
        () => saveKiroApiKey('  leading-and-trailing-space  '),
        (error: unknown) => error instanceof AppError && error.code === 'KIRO_API_KEY_INVALID',
      );
      await assert.rejects(
        () => saveKiroApiKey(12345678),
        (error: unknown) => error instanceof AppError && error.code === 'KIRO_API_KEY_INVALID',
      );

      // None of the rejected attempts should have written a file.
      assert.deepEqual(await getKiroApiKeyState(), { source: 'none', masked: null });
    });
  });
});

test('saveKiroApiKey overwrites an existing stored key atomically', async () => {
  await withHome(async () => {
    await withoutKiroEnvKey(async () => {
      await saveKiroApiKey('first-stored-key-aaaa');
      assert.equal((await getKiroApiKeyState()).masked, '****aaaa');

      await saveKiroApiKey('second-stored-key-bbbb');
      const state = await getKiroApiKeyState();
      assert.equal(state.masked, '****bbbb');
      assert.equal(await resolveKiroApiKey(), 'second-stored-key-bbbb');
    });
  });
});

test('clearKiroApiKey removes the stored file and is a no-op when none exists', async () => {
  await withHome(async () => {
    await withoutKiroEnvKey(async () => {
      await saveKiroApiKey('a-key-to-be-cleared-1234');
      assert.equal((await getKiroApiKeyState()).source, 'file');

      await clearKiroApiKey();
      assert.deepEqual(await getKiroApiKeyState(), { source: 'none', masked: null });

      // Clearing again (nothing stored) must not throw.
      await clearKiroApiKey();
    });
  });
});

test('clearKiroApiKey never affects an environment-provided key', async () => {
  await withHome(async () => {
    const original = process.env.KIRO_API_KEY;
    try {
      process.env.KIRO_API_KEY = 'env-key-stays-after-clear';
      await saveKiroApiKey('file-key-gets-cleared-0000');

      await clearKiroApiKey();

      const state = await getKiroApiKeyState();
      assert.equal(state.source, 'environment');
      assert.equal(await resolveKiroApiKey(), 'env-key-stays-after-clear');
    } finally {
      if (original === undefined) {
        delete process.env.KIRO_API_KEY;
      } else {
        process.env.KIRO_API_KEY = original;
      }
    }
  });
});
