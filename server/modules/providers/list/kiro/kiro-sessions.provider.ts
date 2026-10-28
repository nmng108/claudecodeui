import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';

/**
 * Stub sessions adapter. The real ACP event normalizer and `session/load`
 * history reader land with the runtime and sessions tasks (T4/T5); until
 * then this reports no live events and empty history rather than guessing at
 * a shape no runtime produces yet.
 */
export class KiroSessionsProvider implements IProviderSessions {
  normalizeMessage(_raw: unknown, _sessionId: string | null): NormalizedMessage[] {
    return [];
  }

  async fetchHistory(
    _sessionId: string,
    _options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
  }
}
