import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

/** `~/.cloudcli` directory mode: owner read/write/execute only. */
const CLOUDCLI_DIR_MODE = 0o700;
/** Stored key file mode: owner read/write only. */
const KIRO_AUTH_FILE_MODE = 0o600;

const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 4096;

/** Where a resolved Kiro API key came from, mirroring `ProviderAuthStatus.method`. */
export type KiroApiKeySource = 'environment' | 'file' | 'none';

export type KiroApiKeyState = {
  source: KiroApiKeySource;
  /** Last-4-chars masked form, e.g. `****abcd`. Never the raw key. */
  masked: string | null;
};

type KiroAuthFileContents = {
  apiKey: string;
};

/**
 * Resolves `~/.cloudcli`. CloudCLI has no shared home/data-dir helper today
 * (other modules call `os.homedir()` directly, e.g. the global image assets
 * folder), so this follows the same convention.
 */
function getCloudCliHomeDir(): string {
  return path.join(os.homedir(), '.cloudcli');
}

function getKiroAuthFilePath(): string {
  return path.join(getCloudCliHomeDir(), 'kiro-auth.json');
}

/**
 * Masks a key to its last 4 characters, e.g. `sk-...xyz1` -> `****xyz1`.
 * Never logs or otherwise exposes the raw key.
 */
function maskApiKey(apiKey: string): string {
  const tail = apiKey.slice(-4);
  return `****${tail}`;
}

/**
 * Validates a raw API key value. Must be a trimmed string of 8..4096
 * characters with no whitespace or control characters anywhere in it.
 */
function assertValidKiroApiKey(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AppError('apiKey must be a string.', {
      code: 'KIRO_API_KEY_INVALID',
      statusCode: 400,
    });
  }

  const trimmed = value.trim();
  if (trimmed !== value) {
    throw new AppError('apiKey must not have leading or trailing whitespace.', {
      code: 'KIRO_API_KEY_INVALID',
      statusCode: 400,
    });
  }

  if (trimmed.length < MIN_KEY_LENGTH || trimmed.length > MAX_KEY_LENGTH) {
    throw new AppError(
      `apiKey must be between ${MIN_KEY_LENGTH} and ${MAX_KEY_LENGTH} characters.`,
      { code: 'KIRO_API_KEY_INVALID', statusCode: 400 },
    );
  }

  // Scanning for control characters is intentional here.
  if (/[\s\x00-\x1F\x7F]/.test(trimmed)) {
    throw new AppError('apiKey must not contain whitespace or control characters.', {
      code: 'KIRO_API_KEY_INVALID',
      statusCode: 400,
    });
  }

  return trimmed;
}

/** Reads `KIRO_API_KEY` from the environment, trimmed; undefined when unset or blank. */
function readEnvironmentKiroApiKey(): string | undefined {
  const raw = process.env.KIRO_API_KEY;
  if (typeof raw !== 'string') {
    return undefined;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Reads the stored key from `~/.cloudcli/kiro-auth.json`, or undefined when
 * the file does not exist or cannot be parsed into a usable key.
 */
async function readStoredKiroApiKey(): Promise<string | undefined> {
  try {
    const raw = await readFile(getKiroAuthFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<KiroAuthFileContents> | null;
    const apiKey = parsed && typeof parsed.apiKey === 'string' ? parsed.apiKey.trim() : '';
    return apiKey.length > 0 ? apiKey : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return undefined;
    }
    // A corrupt or unreadable file is treated the same as "no key stored"
    // rather than surfaced to the caller as an error; it never logs content.
    return undefined;
  }
}

/**
 * Resolves the Kiro API key this server should use, or undefined when none is
 * configured. The environment variable always wins over the stored file, per
 * R2.3: a pre-set `KIRO_API_KEY` is reported as method `environment`.
 */
export async function resolveKiroApiKey(): Promise<string | undefined> {
  return readEnvironmentKiroApiKey() ?? (await readStoredKiroApiKey());
}

/**
 * Reports where the active Kiro API key comes from and its masked form. Never
 * returns, logs, or otherwise exposes the raw key.
 */
export async function getKiroApiKeyState(): Promise<KiroApiKeyState> {
  const envKey = readEnvironmentKiroApiKey();
  if (envKey) {
    return { source: 'environment', masked: maskApiKey(envKey) };
  }

  const fileKey = await readStoredKiroApiKey();
  if (fileKey) {
    return { source: 'file', masked: maskApiKey(fileKey) };
  }

  return { source: 'none', masked: null };
}

/**
 * Saves a Kiro API key to `~/.cloudcli/kiro-auth.json`.
 *
 * The parent directory is created with mode 0700 if missing (and re-asserted
 * on every save, since `mkdir` does not change an existing directory's mode).
 * The write is atomic: content lands in a temp file in the same directory
 * first, which is given mode 0600 before the rename so the key is never
 * briefly world- or group-readable.
 */
export async function saveKiroApiKey(apiKey: unknown): Promise<void> {
  const validated = assertValidKiroApiKey(apiKey);
  const cloudCliDir = getCloudCliHomeDir();
  const targetPath = getKiroAuthFilePath();

  await mkdir(cloudCliDir, { recursive: true });
  await chmod(cloudCliDir, CLOUDCLI_DIR_MODE);

  const tempPath = path.join(cloudCliDir, `.kiro-auth.json.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const contents: KiroAuthFileContents = { apiKey: validated };

  try {
    await writeFile(tempPath, `${JSON.stringify(contents, null, 2)}\n`, { mode: KIRO_AUTH_FILE_MODE });
    // writeFile's mode option is ignored for a pre-existing file and is not
    // guaranteed against the umask on all platforms, so it is reasserted here.
    await chmod(tempPath, KIRO_AUTH_FILE_MODE);
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

/** Removes the stored Kiro API key file, if any. A missing file is not an error. */
export async function clearKiroApiKey(): Promise<void> {
  await rm(getKiroAuthFilePath(), { force: true });
}

/** Exposed for tests that need to assert on the on-disk file directly. */
export function getKiroAuthFilePathForTesting(): string {
  return getKiroAuthFilePath();
}

export async function statKiroAuthFileForTesting(): ReturnType<typeof stat> {
  return stat(getKiroAuthFilePath());
}
