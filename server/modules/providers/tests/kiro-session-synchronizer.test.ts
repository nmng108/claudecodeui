import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import {
  isHiddenKiroSession,
  KIRO_SHOW_BRANCH_SESSIONS_ENV,
  KiroSessionSynchronizer,
  resolveKiroProjectPath,
} from '@/modules/providers/list/kiro/kiro-session-synchronizer.provider.js';
import {
  kiroMessageLine,
  withKiroDatabase,
  withKiroHome,
  writeKiroIndex,
  writeKiroSession,
} from '@/modules/providers/tests/fixtures/kiro-home.js';
import { normalizeProjectPath } from '@/shared/utils.js';

const LOWERCASE_WORKSPACE = 'c:\\users\\admin\\.kiro-ui\\workspace';
const PROJECT_PATH = 'C:\\Users\\ADMIN\\.kiro-ui\\workspace';
const CLI_SESSION = 'cli_0e8a9031-b6d1-4d2b-823b-1ee6fc59d6c8_5Lo7PJn5';
const IDE_SESSION = 'sess_4c480f3b-074f-4960-8401-abe0a696740e';
const REWIND_SESSION = 'sess_c78d1a7b-bfc4-44de-b1c7-2547c2ebd9f4';

const chat = [kiroMessageLine('m1', { type: 'user', content: 'hello' })];

const withFixture = async (run: (homeDir: string) => Promise<void>) => {
  await withKiroHome(async (homeDir) => {
    await withKiroDatabase(() => run(homeDir));
  });
};

test('isHiddenKiroSession hides subagents, rewinds and forks but not human sessions', () => {
  assert.equal(isHiddenKiroSession({ createdReason: 'human' }), false);
  assert.equal(isHiddenKiroSession({}), false);
  assert.equal(isHiddenKiroSession({ createdReason: 'subagent' }), true);
  assert.equal(isHiddenKiroSession({ createdReason: 'rewind', parentSessionId: 'sess_x' }), true);
  assert.equal(isHiddenKiroSession({ createdReason: 'fork' }), true);
  assert.equal(isHiddenKiroSession({ createdReason: 'human', parentSessionId: 'sess_x' }), true);
  assert.equal(isHiddenKiroSession({ createdReason: 'Rewind' }), true);

  // The default can be switched off to list rewinds and forks; subagents stay hidden.
  const previous = process.env[KIRO_SHOW_BRANCH_SESSIONS_ENV];
  process.env[KIRO_SHOW_BRANCH_SESSIONS_ENV] = 'true';
  try {
    assert.equal(isHiddenKiroSession({ createdReason: 'rewind', parentSessionId: 'sess_x' }), false);
    assert.equal(isHiddenKiroSession({ createdReason: 'fork' }), false);
    assert.equal(isHiddenKiroSession({ createdReason: 'subagent' }), true);
  } finally {
    if (previous === undefined) {
      delete process.env[KIRO_SHOW_BRANCH_SESSIONS_ENV];
    } else {
      process.env[KIRO_SHOW_BRANCH_SESSIONS_ENV] = previous;
    }
  }
});

test('resolveKiroProjectPath reuses a project that differs only by case on Windows paths', () => {
  const known = [PROJECT_PATH, '/home/me/app'];
  assert.equal(resolveKiroProjectPath(LOWERCASE_WORKSPACE, known), PROJECT_PATH);
  assert.equal(resolveKiroProjectPath('c:/users/admin/.kiro-ui/workspace/', known), PROJECT_PATH);
  assert.equal(resolveKiroProjectPath('\\\\?\\c:\\users\\admin\\.kiro-ui\\workspace', known), PROJECT_PATH);
  assert.equal(resolveKiroProjectPath(PROJECT_PATH, known), PROJECT_PATH);
  // No project yet: the path is kept as Kiro wrote it.
  assert.equal(resolveKiroProjectPath('d:\\code\\projects', known), 'd:\\code\\projects');
  // POSIX paths are case-sensitive, so they are never matched loosely.
  assert.equal(resolveKiroProjectPath('/home/ME/app', known), normalizeProjectPath('/home/ME/app'));
  assert.notEqual(resolveKiroProjectPath('/home/ME/app', known), '/home/me/app');
  assert.equal(resolveKiroProjectPath('   ', known), '');
});

test('sessions of a lowercase workspace land in the existing project, hiding rewinds and stubs', async () => {
  await withFixture(async (homeDir) => {
    projectsDb.createProjectPath(PROJECT_PATH);

    await writeKiroSession(homeDir, {
      id: CLI_SESSION,
      title: 'Continue the Kiro work',
      workspacePath: LOWERCASE_WORKSPACE,
      messages: chat,
      createdAt: '2026-10-27T21:22:23.000Z',
      lastModifiedAt: '2026-11-01T14:20:47.000Z',
    });
    await writeKiroSession(homeDir, { id: IDE_SESSION, title: 'Plan the models', workspacePath: LOWERCASE_WORKSPACE, messages: chat });
    await writeKiroSession(homeDir, {
      id: REWIND_SESSION,
      workspacePath: LOWERCASE_WORKSPACE,
      messages: chat,
      createdReason: 'rewind',
      parentSessionId: IDE_SESSION,
    });
    await writeKiroSession(homeDir, {
      id: 'sess_subagent-1',
      workspacePath: LOWERCASE_WORKSPACE,
      messages: chat,
      createdReason: 'subagent',
    });
    await writeKiroSession(homeDir, { id: 'sess_empty', workspacePath: LOWERCASE_WORKSPACE, messages: [] });
    await writeKiroSession(homeDir, { id: 'sess_no-json', workspacePath: LOWERCASE_WORKSPACE, messages: chat, omitSessionJson: true });
    await writeKiroSession(homeDir, { id: 'sess_no-path', messages: chat });

    const processed = await new KiroSessionSynchronizer().synchronize();

    assert.equal(processed, 2);
    assert.deepEqual(projectsDb.getProjectPaths().map((row) => row.project_path), [PROJECT_PATH]);

    const sessions = sessionsDb.getSessionsByProjectPath(PROJECT_PATH);
    assert.deepEqual(sessions.map((row) => row.session_id).sort(), [CLI_SESSION, IDE_SESSION].sort());
    const cliRow = sessions.find((row) => row.session_id === CLI_SESSION)!;
    assert.equal(cliRow.provider, 'kiro');
    assert.equal(cliRow.custom_name, 'Continue the Kiro work');
    assert.equal(
      cliRow.jsonl_path,
      path.join(homeDir, '.kiro', 'sessions', 'fbc0124c5f60bc89', CLI_SESSION, 'messages.jsonl'),
    );
  });
});

test('a session with no title gets a fallback name and a second scan is idempotent', async () => {
  await withFixture(async (homeDir) => {
    await writeKiroSession(homeDir, { id: IDE_SESSION, title: null, workspacePath: LOWERCASE_WORKSPACE, messages: chat });
    const synchronizer = new KiroSessionSynchronizer();

    assert.equal(await synchronizer.synchronize(), 1);
    assert.equal(await synchronizer.synchronize(), 1);

    const sessions = sessionsDb.getSessionsByProjectPath(LOWERCASE_WORKSPACE);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].custom_name, 'Untitled Kiro Session');
  });
});

test('incremental scans skip sessions whose files did not change since the cursor', async () => {
  await withFixture(async (homeDir) => {
    await writeKiroSession(homeDir, { id: IDE_SESSION, workspacePath: LOWERCASE_WORKSPACE, messages: chat });
    const synchronizer = new KiroSessionSynchronizer();

    assert.equal(await synchronizer.synchronize(new Date(Date.now() + 60_000)), 0);
    assert.equal(await synchronizer.synchronize(new Date(Date.now() - 60_000)), 1);
  });
});

test('the stale index cache is ignored: session.json decides what is listed', async () => {
  await withFixture(async (homeDir) => {
    await writeKiroSession(homeDir, { id: IDE_SESSION, title: 'Real title', workspacePath: LOWERCASE_WORKSPACE, messages: chat });
    await writeKiroIndex(homeDir, [
      {
        id: IDE_SESSION,
        title: 'Stale title',
        workspacePaths: ['c:\\somewhere\\else'],
        createdAt: '2020-01-01T00:00:00.000Z',
        lastModifiedAt: '2020-01-01T00:00:00.000Z',
      },
      {
        id: 'sess_deleted-from-disk',
        title: 'Gone',
        workspacePaths: [LOWERCASE_WORKSPACE],
        createdAt: '2026-11-01T00:00:00.000Z',
        lastModifiedAt: '2026-11-01T00:00:00.000Z',
      },
    ]);

    assert.equal(await new KiroSessionSynchronizer().synchronize(), 1);
    const sessions = sessionsDb.getSessionsByProjectPath(LOWERCASE_WORKSPACE);
    assert.deepEqual(sessions.map((row) => [row.session_id, row.custom_name]), [[IDE_SESSION, 'Real title']]);
  });
});

test('a missing or empty sessions folder and malformed files do not throw', async () => {
  await withFixture(async (homeDir) => {
    const synchronizer = new KiroSessionSynchronizer();
    assert.equal(await synchronizer.synchronize(), 0);

    const sessionDir = path.join(homeDir, '.kiro', 'sessions', 'fbc0124c5f60bc89', IDE_SESSION);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(path.join(sessionDir, 'session.json'), '{ not json', 'utf8');
    await writeFile(path.join(sessionDir, 'messages.jsonl'), 'garbage\n', 'utf8');
    assert.equal(await synchronizer.synchronize(), 0);

    // The legacy store and unrelated folders are not workspace directories.
    await mkdir(path.join(homeDir, '.kiro', 'sessions', 'cli'), { recursive: true });
    await writeFile(path.join(homeDir, '.kiro', 'sessions', 'dashboard-search.db'), '', 'utf8');
    assert.equal(await synchronizer.synchronize(), 0);
  });
});

test('synchronizeFile indexes the session of a changed session.json or messages.jsonl', async () => {
  await withFixture(async (homeDir) => {
    const sessionDir = await writeKiroSession(homeDir, { id: IDE_SESSION, workspacePath: LOWERCASE_WORKSPACE, messages: chat });
    const synchronizer = new KiroSessionSynchronizer();

    assert.equal(await synchronizer.synchronizeFile(path.join(sessionDir, 'messages.jsonl')), IDE_SESSION);
    assert.equal(await synchronizer.synchronizeFile(path.join(sessionDir, 'session.json')), IDE_SESSION);
    assert.equal(await synchronizer.synchronizeFile(path.join(sessionDir, '.lock')), null);
    assert.equal(await synchronizer.synchronizeFile(path.join(sessionDir, '..', '.index', 'index.json')), null);
    assert.equal(await synchronizer.synchronizeFile(path.join(homeDir, 'elsewhere', 'messages.jsonl')), null);

    await appendFile(path.join(sessionDir, 'messages.jsonl'), `${JSON.stringify(chat[0])}\n`);
    assert.equal(await synchronizer.synchronizeFile(path.join(sessionDir, 'messages.jsonl')), IDE_SESSION);
    assert.equal(sessionsDb.getSessionsByProjectPath(LOWERCASE_WORKSPACE).length, 1);
  });
});

test('a session started in the app is claimed by the Kiro session that appears for it', async () => {
  await withFixture(async (homeDir) => {
    sessionsDb.createAppSession('app-session-1', 'kiro', LOWERCASE_WORKSPACE, 'My chat');
    const now = Date.now();
    await writeKiroSession(homeDir, {
      id: IDE_SESSION,
      title: 'Kiro title',
      workspacePath: LOWERCASE_WORKSPACE,
      messages: chat,
      createdAt: new Date(now + 1_000).toISOString(),
      lastModifiedAt: new Date(now + 2_000).toISOString(),
    });

    assert.equal(await new KiroSessionSynchronizer().synchronize(), 1);

    const sessions = sessionsDb.getSessionsByProjectPath(LOWERCASE_WORKSPACE);
    assert.equal(sessions.length, 1, 'no second sidebar entry');
    assert.equal(sessions[0].session_id, 'app-session-1');
    assert.equal(sessions[0].provider_session_id, IDE_SESSION);
    assert.equal(sessions[0].custom_name, 'My chat', 'the app session keeps its name');
  });
});

test('an older Kiro session is not mistaken for the one a pending app session is waiting on', async () => {
  await withFixture(async (homeDir) => {
    sessionsDb.createAppSession('app-session-2', 'kiro', LOWERCASE_WORKSPACE, 'New chat');
    await writeKiroSession(homeDir, {
      id: IDE_SESSION,
      workspacePath: LOWERCASE_WORKSPACE,
      messages: chat,
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });

    await new KiroSessionSynchronizer().synchronize();

    const pending = sessionsDb.getSessionById('app-session-2');
    assert.equal(pending?.provider_session_id, null);
    assert.equal(sessionsDb.getSessionsByProjectPath(LOWERCASE_WORKSPACE).length, 2);
  });
});
