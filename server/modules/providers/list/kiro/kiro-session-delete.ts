import { readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { isKiroSessionRunning } from '@/modules/providers/list/kiro/kiro-runtime.provider.js';
import {
  getKiroSessionsRoot,
  isSafeKiroSessionId,
  findKiroSessionDir,
} from '@/modules/providers/list/kiro/kiro-paths.js';
import { AppError } from '@/shared/utils.js';

const WORKSPACE_DIR_PATTERN = /^[0-9a-f]{16}$/;

const samePath = (left: string, right: string): boolean =>
  process.platform === 'win32'
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);

/** True when a process with this pid is alive (signal 0 only probes). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Kiro writes `{ pid, started_at }` to `.lock` while a process has the session open. */
async function isSessionLockHeld(sessionDir: string): Promise<boolean> {
  try {
    const lock = JSON.parse(await readFile(path.join(sessionDir, '.lock'), 'utf8')) as { pid?: unknown };
    return typeof lock.pid === 'number' && Number.isInteger(lock.pid) && lock.pid > 0 && isProcessAlive(lock.pid);
  } catch {
    // No lock file, or one that cannot be read: nothing holds the session.
    return false;
  }
}

/**
 * Resolves the directory a Kiro session row points at and proves it is a
 * session directory inside `~/.kiro/sessions/<hash>/`. Returns null when the
 * row has nothing on disk to remove.
 */
async function resolveDeletableSessionDir(
  transcriptPath: string | null | undefined,
  providerSessionId: string | null | undefined,
): Promise<string | null> {
  let sessionDir: string | null = null;
  if (transcriptPath?.trim()) {
    sessionDir = path.dirname(path.resolve(transcriptPath));
  } else if (providerSessionId) {
    sessionDir = await findKiroSessionDir(providerSessionId);
  }
  if (!sessionDir) {
    return null;
  }

  const workspaceDir = path.dirname(sessionDir);
  const looksLikeSession = isSafeKiroSessionId(path.basename(sessionDir))
    && WORKSPACE_DIR_PATTERN.test(path.basename(workspaceDir))
    && samePath(path.dirname(workspaceDir), getKiroSessionsRoot());
  if (!looksLikeSession) {
    throw new AppError('Refusing to delete a path that is not a Kiro session directory.', {
      code: 'KIRO_SESSION_PATH_REJECTED',
      statusCode: 400,
    });
  }

  let realDir: string;
  try {
    if (!(await stat(sessionDir)).isDirectory()) {
      return null;
    }
    realDir = await realpath(sessionDir);
  } catch {
    // Already gone.
    return null;
  }

  // A symlinked session directory must not lead outside the sessions root.
  const realRoot = await realpath(getKiroSessionsRoot()).catch(() => getKiroSessionsRoot());
  const relative = path.relative(realRoot, realDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('Refusing to delete a path outside the Kiro sessions folder.', {
      code: 'KIRO_SESSION_PATH_REJECTED',
      statusCode: 400,
    });
  }

  return realDir;
}

/**
 * Deletes a Kiro session's directory (`session.json`, `messages.jsonl` and the
 * rest), which also removes the session from Kiro and kiro-ui. Used when the
 * user deletes a Kiro session from disk.
 *
 * Refuses, and deletes nothing, when the path is not a session directory, when
 * a live process holds the session's `.lock`, or when CloudCLI is running a
 * turn on it. Kiro's own caches (`.index`, `session-index`, the dashboard
 * database) are left alone; Kiro rebuilds them from the directory listing.
 *
 * @returns true when a directory was removed, false when there was nothing on disk
 */
export async function deleteKiroSessionFromDisk(
  transcriptPath: string | null | undefined,
  providerSessionId?: string | null,
): Promise<boolean> {
  const sessionDir = await resolveDeletableSessionDir(transcriptPath, providerSessionId);
  if (!sessionDir) {
    return false;
  }

  const sessionId = path.basename(sessionDir);
  if (isKiroSessionRunning(sessionId) || await isSessionLockHeld(sessionDir)) {
    throw new AppError('This Kiro session is in use. Stop it before deleting it from disk.', {
      code: 'KIRO_SESSION_IN_USE',
      statusCode: 409,
    });
  }

  await rm(sessionDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  return true;
}
