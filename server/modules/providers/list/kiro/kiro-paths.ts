import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Kiro stores sessions as `~/.kiro/sessions/<wsHash>/<sessionDir>/`. The
 * `<wsHash>` directory name is a 16-hex id of the workspace that cannot be
 * derived from a path, so everything here discovers directories by listing
 * them and reads project paths from the files inside.
 *
 * Session directories are named after the session id: `sess_<uuid>` (ACP and
 * the IDE) or `cli_<uuid>_<rand8>` (kiro-cli chat). The id is what
 * `session/load` takes, prefix included.
 */
const KIRO_WORKSPACE_DIR_PATTERN = /^[0-9a-f]{16}$/;
export const KIRO_SESSION_ID_PATTERN = /^(?:sess|cli)_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type KiroSessionJson = {
  id?: string;
  title?: string | null;
  agentMode?: string;
  workspacePaths?: string[];
  rootPaths?: string[];
  createdAt?: string;
  lastModifiedAt?: string;
  createdReason?: string;
  parentSessionId?: string | null;
  forkedAtMessageId?: string | null;
  rootConversationId?: string | null;
  modelId?: string;
  effortLevel?: string;
  status?: string;
};

/** `~/.kiro/sessions`, resolved on each call so tests can point HOME elsewhere. */
export function getKiroSessionsRoot(): string {
  return path.join(os.homedir(), '.kiro', 'sessions');
}

/** True for ids that can be turned into a session directory name without escaping the sessions root. */
export function isSafeKiroSessionId(value: unknown): value is string {
  return typeof value === 'string' && KIRO_SESSION_ID_PATTERN.test(value);
}

/** Absolute paths of the `<wsHash>` directories; the legacy `cli` store and other entries are skipped. */
export async function listKiroWorkspaceDirs(): Promise<string[]> {
  const root = getKiroSessionsRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && KIRO_WORKSPACE_DIR_PATTERN.test(entry.name))
    .map((entry) => path.join(root, entry.name));
}

/** Absolute paths of the session directories inside one workspace directory. */
export async function listKiroSessionDirs(workspaceDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(workspaceDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && KIRO_SESSION_ID_PATTERN.test(entry.name))
    .map((entry) => path.join(workspaceDir, entry.name));
}

/**
 * Finds the directory of one session by id, or `null` when the id is unsafe or
 * no workspace directory holds it.
 */
export async function findKiroSessionDir(sessionId: string): Promise<string | null> {
  if (!isSafeKiroSessionId(sessionId)) {
    return null;
  }

  for (const workspaceDir of await listKiroWorkspaceDirs()) {
    const candidate = path.join(workspaceDir, sessionId);
    try {
      if ((await stat(candidate)).isDirectory()) {
        return candidate;
      }
    } catch {
      // Not in this workspace directory.
    }
  }
  return null;
}

/** Reads and parses `session.json` from a session directory; `null` when missing or malformed. */
export async function readKiroSessionJson(sessionDir: string): Promise<KiroSessionJson | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(sessionDir, 'session.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as KiroSessionJson) : null;
  } catch {
    return null;
  }
}

/** Absolute path of the transcript inside a session directory. */
export function getKiroMessagesPath(sessionDir: string): string {
  return path.join(sessionDir, 'messages.jsonl');
}
