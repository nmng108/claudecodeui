import { AppError } from '@/shared/utils.js';

import { createSshKeyCore, SshKeyError, type SshKeyCoreOptions } from './ssh-key-core.js';
import type { GenerateSshKeyOptions, SshKeyInfo, SshKeyProvider } from './ssh-key-provider.js';

export { parsePublicKey } from './ssh-key-core.js';
export type { KeygenRunner, KeygenResult } from './ssh-key-core.js';

/** Turns the core's errors into the server's, so the API answers with their status and code. */
function toAppError(error: unknown): unknown {
  if (error instanceof SshKeyError) {
    return new AppError(error.message, { code: error.code, statusCode: error.statusCode, details: error.details });
  }
  return error;
}

/**
 * Manages the key files of the current user (`~/.ssh`, or the directory given)
 * with the system `ssh-keygen`.
 *
 * An existing key is only ever read. A key is created only when none exists and
 * the caller asked for it, and only a key created here can be replaced.
 */
export function createNativeSshKeyProvider(options: SshKeyCoreOptions = {}): SshKeyProvider {
  const core = createSshKeyCore({ ...options, providerName: 'native' });
  return {
    getKey: (): Promise<SshKeyInfo> => core.getKey().catch((error) => { throw toAppError(error); }),
    generateKey: (generateOptions?: GenerateSshKeyOptions): Promise<SshKeyInfo> =>
      core.generateKey(generateOptions).catch((error) => { throw toAppError(error); }),
  };
}