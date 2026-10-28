import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';

/**
 * Stub session synchronizer. Kiro session discovery (`session/list` ->
 * `jsonl_path: null` upsert per `docs/kiro/design.md`) lands with T5; until
 * then no sessions are indexed from disk.
 */
export class KiroSessionSynchronizer implements IProviderSessionSynchronizer {
  async synchronize(_since?: Date): Promise<number> {
    return 0;
  }

  async synchronizeFile(_filePath: string): Promise<string | null> {
    return null;
  }
}
