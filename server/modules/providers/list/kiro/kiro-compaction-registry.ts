import { AppError } from '@/shared/utils.js';

/** One `/compact` that is running right now. */
type KiroCompaction = {
  /** Id the app and the client use for the session. */
  appSessionId: string;
  startedAt: number;
};

/**
 * Compactions in flight, keyed by Kiro's own session id. `/compact` is a single
 * blocking call that can take minutes, and nothing else tells the rest of the
 * server (or a second browser tab) that the session is busy while it runs.
 */
const activeCompactions = new Map<string, KiroCompaction>();

/**
 * Used by kiro-session-commands to claim a session before compacting it.
 * Throws a 409 when the session is already being compacted, so a repeated
 * `/compact` is refused instead of starting a second ACP client on it.
 * Returns the function that releases the claim; call it in a `finally`.
 */
export function beginKiroCompaction(kiroSessionId: string, appSessionId: string): () => void {
  if (activeCompactions.has(kiroSessionId)) {
    throw new AppError('Kiro is already compacting this conversation.', {
      code: 'KIRO_COMPACT_IN_PROGRESS',
      statusCode: 409,
    });
  }

  const compaction: KiroCompaction = { appSessionId, startedAt: Date.now() };
  activeCompactions.set(kiroSessionId, compaction);
  return () => {
    // A claim is only released by the call that made it.
    if (activeCompactions.get(kiroSessionId) === compaction) {
      activeCompactions.delete(kiroSessionId);
    }
  };
}

/**
 * Used by kiro-runtime (to refuse a chat turn), kiro-session-commands (to
 * refuse other session commands) and kiro-session-delete (to keep the files)
 * while a compaction is rewriting the session.
 */
export function isKiroSessionCompacting(kiroSessionId: string | null | undefined): boolean {
  return Boolean(kiroSessionId) && activeCompactions.has(kiroSessionId as string);
}

/**
 * Used by sessions.service so the running-sessions poll reports compactions.
 * Without this entry the client's own "processing" mark is dropped by the next
 * poll, and a second tab never learns the session is busy.
 */
export function listKiroCompactions(): Array<{ sessionId: string; startedAt: number }> {
  return [...activeCompactions.values()].map(({ appSessionId, startedAt }) => ({
    sessionId: appSessionId,
    startedAt,
  }));
}
