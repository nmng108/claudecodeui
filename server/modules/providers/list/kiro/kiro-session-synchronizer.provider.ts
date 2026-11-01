import { stat } from 'node:fs/promises';
import path from 'node:path';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  getKiroMessagesPath,
  isSafeKiroSessionId,
  listKiroSessionDirs,
  listKiroWorkspaceDirs,
  readKiroSessionJson,
  type KiroSessionJson,
} from '@/modules/providers/list/kiro/kiro-paths.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import {
  normalizeProjectPath,
  normalizeProviderTimestamp,
  normalizeSessionName,
} from '@/shared/utils.js';

const FALLBACK_TITLE = 'Untitled Kiro Session';

/**
 * Sessions that Kiro created by rewinding or forking another session stay out
 * of the sidebar by default, like OpenCode hides its child sessions; a chain of
 * rewinds is one conversation. Set this variable to `true` or `1` to list them
 * too. Subagent sessions are always hidden.
 */
export const KIRO_SHOW_BRANCH_SESSIONS_ENV = 'CLOUDCLI_KIRO_SHOW_BRANCH_SESSIONS';

const showBranchSessions = (): boolean => {
  const value = process.env[KIRO_SHOW_BRANCH_SESSIONS_ENV]?.trim().toLowerCase();
  return value === 'true' || value === '1';
};

/** `createdReason` values Kiro writes for sessions that are not a person starting a chat. */
const SUBAGENT_REASONS = new Set(['subagent']);
const BRANCH_REASONS = new Set(['rewind', 'fork']);

/** Windows-style absolute paths: `C:\...`, `C:/...` or `\\server\share`. */
const WINDOWS_PATH_PATTERN = /^(?:[a-zA-Z]:[\\/]|\\\\)/;

const readNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Parses a database timestamp; SQLite's `CURRENT_TIMESTAMP` is UTC without a zone suffix. */
function parseDatabaseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return Number.NaN;
  }
  const hasZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value);
  return Date.parse(hasZone ? value : `${value.replace(' ', 'T')}Z`);
}

/** True for sessions that should not appear in the sidebar. */
export function isHiddenKiroSession(session: KiroSessionJson): boolean {
  const reason = readNonEmptyString(session.createdReason)?.toLowerCase();
  if (reason && SUBAGENT_REASONS.has(reason)) {
    return true;
  }
  if (showBranchSessions()) {
    return false;
  }
  return Boolean((reason && BRANCH_REASONS.has(reason)) || readNonEmptyString(session.parentSessionId));
}

/**
 * Picks the project path a session belongs to.
 *
 * Kiro stores `workspacePaths` exactly as its client supplied them (for example
 * the lowercase `c:\users\admin\.kiro-ui\workspace`), while the project list
 * compares paths case-sensitively. For Windows-style paths an existing project
 * that differs only by case is reused, so one folder never becomes two projects.
 */
export function resolveKiroProjectPath(rawPath: string, knownProjectPaths: readonly string[]): string {
  const normalized = normalizeProjectPath(rawPath);
  if (!normalized) {
    return '';
  }

  if (knownProjectPaths.includes(normalized) || !WINDOWS_PATH_PATTERN.test(normalized)) {
    return normalized;
  }

  const lowered = normalized.toLowerCase();
  return knownProjectPaths.find((known) => known.toLowerCase() === lowered) ?? normalized;
}

async function fileMtimeMs(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Session indexer for Kiro's on-disk session store (`~/.kiro/sessions`).
 *
 * Kiro does not advertise ACP `session/list`, and `_kiro.dev/session/list`
 * needs a running `kiro-cli` and an API key, so this reads the files Kiro
 * keeps for every session instead, read-only. `session.json` is authoritative;
 * the `.index/index.json` cache is not read because it can lag.
 */
export class KiroSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'kiro' as const;

  /** Scans every Kiro workspace directory and upserts the sessions changed since `since`. */
  async synchronize(since?: Date): Promise<number> {
    let processed = 0;
    try {
      const knownProjectPaths = this.readKnownProjectPaths();
      const sinceMillis = since?.getTime() ?? null;

      for (const workspaceDir of await listKiroWorkspaceDirs()) {
        for (const sessionDir of await listKiroSessionDirs(workspaceDir)) {
          if (sinceMillis !== null && !(await this.changedSince(sessionDir, sinceMillis))) {
            continue;
          }
          if (await this.upsertSessionDirectory(sessionDir, knownProjectPaths)) {
            processed += 1;
          }
        }
      }
    } catch (error) {
      // A throw here would stop the scan cursor for every provider.
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[KiroProvider] Failed to synchronize sessions:', message);
    }
    return processed;
  }

  /** Handles a watcher event for one `session.json` or `messages.jsonl`. */
  async synchronizeFile(filePath: string): Promise<string | null> {
    const fileName = path.basename(filePath);
    if (fileName !== 'session.json' && fileName !== 'messages.jsonl') {
      return null;
    }

    const sessionDir = path.dirname(filePath);
    if (!isSafeKiroSessionId(path.basename(sessionDir))) {
      return null;
    }

    try {
      return await this.upsertSessionDirectory(sessionDir, this.readKnownProjectPaths());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn('[KiroProvider] Failed to synchronize a session file:', message);
      return null;
    }
  }

  private readKnownProjectPaths(): string[] {
    try {
      return [...projectsDb.getProjectPaths(), ...projectsDb.getArchivedProjectPaths()]
        .map((row) => row.project_path);
    } catch {
      return [];
    }
  }

  private async changedSince(sessionDir: string, sinceMillis: number): Promise<boolean> {
    const mtimes = await Promise.all([
      fileMtimeMs(path.join(sessionDir, 'session.json')),
      fileMtimeMs(getKiroMessagesPath(sessionDir)),
    ]);
    return mtimes.some((mtime) => mtime !== null && mtime >= sinceMillis);
  }

  /** Upserts one session directory; returns the stored session id, or null when it is not listed. */
  private async upsertSessionDirectory(
    sessionDir: string,
    knownProjectPaths: readonly string[],
  ): Promise<string | null> {
    const sessionId = path.basename(sessionDir);
    if (!isSafeKiroSessionId(sessionId)) {
      return null;
    }

    const session = await readKiroSessionJson(sessionDir);
    if (!session || isHiddenKiroSession(session)) {
      return null;
    }

    // A session with no transcript yet has nothing to show, and a stored path
    // to a missing file would be pruned as an orphan on the next scan.
    const messagesPath = getKiroMessagesPath(sessionDir);
    let messagesSize = 0;
    try {
      messagesSize = (await stat(messagesPath)).size;
    } catch {
      return null;
    }
    if (messagesSize === 0) {
      return null;
    }

    const rawProjectPath = [...(session.workspacePaths ?? []), ...(session.rootPaths ?? [])]
      .map(readNonEmptyString)
      .find((value): value is string => Boolean(value));
    const projectPath = rawProjectPath ? resolveKiroProjectPath(rawProjectPath, knownProjectPaths) : '';
    if (!projectPath) {
      return null;
    }

    const createdAt = normalizeProviderTimestamp(session.createdAt);
    const updatedAt = normalizeProviderTimestamp(session.lastModifiedAt ?? session.createdAt);

    // A session started from the app is stored under an app id until Kiro's id
    // is known. Claim that row first so the watcher does not add a second
    // sidebar entry. Only a row that existed when this session began can own it.
    const known = sessionsDb.getSessionByProviderSessionId(sessionId) ?? sessionsDb.getSessionById(sessionId);
    if (!known) {
      const pending = sessionsDb.findLatestPendingAppSession(this.provider, projectPath);
      const pendingCreatedAt = parseDatabaseTimestamp(pending?.created_at);
      if (
        pending
        && !pending.provider_session_id
        && Number.isFinite(pendingCreatedAt)
        && Date.parse(createdAt) >= pendingCreatedAt - 10_000
      ) {
        sessionsDb.assignProviderSessionId(pending.session_id, sessionId);
      }
    }

    return sessionsDb.createSession(
      sessionId,
      this.provider,
      projectPath,
      normalizeSessionName(readNonEmptyString(session.title), FALLBACK_TITLE),
      createdAt,
      updatedAt,
      messagesPath,
    );
  }
}
