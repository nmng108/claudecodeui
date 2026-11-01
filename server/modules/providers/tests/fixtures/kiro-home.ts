import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Default workspace directory name; Kiro uses an underivable 16-hex id. */
export const KIRO_TEST_WORKSPACE_HASH = 'fbc0124c5f60bc89';

/**
 * Runs `run` with HOME/USERPROFILE pointing at a temporary directory, so code
 * that reads `~/.kiro` sees only the fixture. os.homedir() reads HOME on POSIX
 * and USERPROFILE on Windows.
 */
export async function withKiroHome(run: (homeDir: string) => Promise<void>): Promise<void> {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'kiro-home-'));
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
}

export type KiroTestSession = {
  id: string;
  title?: string | null;
  workspacePath?: string;
  createdAt?: string;
  lastModifiedAt?: string;
  createdReason?: string;
  parentSessionId?: string;
  modelId?: string;
  effortLevel?: string;
  status?: string;
  /** Raw `messages.jsonl` lines; objects are serialized, strings are written as-is. */
  messages?: Array<Record<string, unknown> | string>;
  workspaceHash?: string;
  /** Skip `session.json` to simulate a half-written session directory. */
  omitSessionJson?: boolean;
};

/** Writes `sessions/<hash>/<id>/{session.json,messages.jsonl}` and returns the session directory. */
export async function writeKiroSession(homeDir: string, session: KiroTestSession): Promise<string> {
  const sessionDir = path.join(
    homeDir,
    '.kiro',
    'sessions',
    session.workspaceHash ?? KIRO_TEST_WORKSPACE_HASH,
    session.id,
  );
  await mkdir(sessionDir, { recursive: true });

  if (!session.omitSessionJson) {
    await writeFile(
      path.join(sessionDir, 'session.json'),
      JSON.stringify({
        schemaVersion: 1,
        dataModelVersion: 1,
        id: session.id,
        title: session.title === undefined ? `Title of ${session.id}` : session.title,
        agentMode: 'vibe',
        workspacePaths: session.workspacePath ? [session.workspacePath] : [],
        createdAt: session.createdAt ?? '2026-11-01T10:00:00.000Z',
        lastModifiedAt: session.lastModifiedAt ?? '2026-11-01T11:00:00.000Z',
        createdReason: session.createdReason ?? 'human',
        ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
        modelId: session.modelId,
        effortLevel: session.effortLevel,
        status: session.status,
      }),
      'utf8',
    );
  }

  const lines = (session.messages ?? []).map((line) => (typeof line === 'string' ? line : JSON.stringify(line)));
  await writeFile(path.join(sessionDir, 'messages.jsonl'), lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  return sessionDir;
}

/** Writes `sessions/<hash>/.index/index.json` the way Kiro's cache does. */
export async function writeKiroIndex(
  homeDir: string,
  entries: Array<{
    id: string;
    title?: string | null;
    workspacePaths: string[];
    createdAt: string;
    lastModifiedAt: string;
    agentMode?: string;
    status?: string;
  }>,
  workspaceHash: string = KIRO_TEST_WORKSPACE_HASH,
): Promise<string> {
  const indexDir = path.join(homeDir, '.kiro', 'sessions', workspaceHash, '.index');
  await mkdir(indexDir, { recursive: true });
  const indexPath = path.join(indexDir, 'index.json');
  await writeFile(
    indexPath,
    JSON.stringify({ schemaVersion: 2, entries: entries.map((entry) => ({ agentMode: 'vibe', ...entry })), stamps: {} }),
    'utf8',
  );
  return indexPath;
}
