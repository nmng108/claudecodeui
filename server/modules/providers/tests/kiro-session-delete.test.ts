import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { deleteKiroSessionFromDisk } from '@/modules/providers/list/kiro/kiro-session-delete.js';
import { kiroMessageLine, withKiroHome, writeKiroSession } from '@/modules/providers/tests/fixtures/kiro-home.js';
import { AppError } from '@/shared/utils.js';

const SESSION_ID = 'sess_4c480f3b-074f-4960-8401-abe0a696740e';
const exists = (target: string) => access(target).then(() => true, () => false);

const writeSession = (homeDir: string) => writeKiroSession(homeDir, {
  id: SESSION_ID,
  workspacePath: 'c:\\users\\admin\\.kiro-ui\\workspace',
  messages: [kiroMessageLine('m1', { type: 'user', content: 'hello' })],
});

test('deleting a Kiro session removes its whole directory and nothing else', async () => {
  await withKiroHome(async (homeDir) => {
    const sessionDir = await writeSession(homeDir);
    await mkdir(path.join(sessionDir, 'snapshots'), { recursive: true });
    await writeFile(path.join(sessionDir, 'snapshots', 'abc'), 'x');
    const sibling = await writeKiroSession(homeDir, { id: 'sess_sibling', workspacePath: 'c:\\other', messages: [] });
    const index = path.join(homeDir, '.kiro', 'sessions', 'fbc0124c5f60bc89', '.index', 'index.json');
    await mkdir(path.dirname(index), { recursive: true });
    await writeFile(index, '{}');

    const removed = await deleteKiroSessionFromDisk(path.join(sessionDir, 'messages.jsonl'), SESSION_ID);

    assert.equal(removed, true);
    assert.equal(await exists(sessionDir), false);
    assert.equal(await exists(sibling), true, 'other sessions stay');
    assert.equal(await exists(index), true, "Kiro's own index cache is left alone");
  });
});

test('the session is found by id when the row has no transcript path', async () => {
  await withKiroHome(async (homeDir) => {
    const sessionDir = await writeSession(homeDir);
    assert.equal(await deleteKiroSessionFromDisk(null, SESSION_ID), true);
    assert.equal(await exists(sessionDir), false);
  });
});

test('there is nothing to remove when the directory is already gone', async () => {
  await withKiroHome(async (homeDir) => {
    const sessionDir = await writeSession(homeDir);
    const transcript = path.join(sessionDir, 'messages.jsonl');
    assert.equal(await deleteKiroSessionFromDisk(transcript, SESSION_ID), true);
    assert.equal(await deleteKiroSessionFromDisk(transcript, SESSION_ID), false);
    assert.equal(await deleteKiroSessionFromDisk(null, null), false);
    assert.equal(await deleteKiroSessionFromDisk(null, 'sess_not-there'), false);
  });
});

test('paths outside the Kiro sessions folder are rejected and left untouched', async () => {
  await withKiroHome(async (homeDir) => {
    await writeSession(homeDir);
    const elsewhere = path.join(homeDir, 'projects', 'app', SESSION_ID);
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, 'messages.jsonl'), 'x');

    const candidates = [
      path.join(elsewhere, 'messages.jsonl'),
      path.join(homeDir, '.kiro', 'sessions', 'fbc0124c5f60bc89', 'messages.jsonl'),
      path.join(homeDir, '.kiro', 'sessions', 'cli', 'sess_legacy', 'messages.jsonl'),
      path.join(homeDir, '.kiro', 'sessions', 'fbc0124c5f60bc89', '..', '..', '..', 'messages.jsonl'),
      path.join(homeDir, '.kiro', 'sessions', 'dashboard-search.db'),
    ];
    for (const candidate of candidates) {
      await assert.rejects(
        () => deleteKiroSessionFromDisk(candidate, SESSION_ID),
        (error) => error instanceof AppError && error.code === 'KIRO_SESSION_PATH_REJECTED',
        candidate,
      );
    }
    assert.equal(await exists(path.join(elsewhere, 'messages.jsonl')), true);
  });
});

test('a session whose lock is held by a live process is refused and kept', async () => {
  await withKiroHome(async (homeDir) => {
    const sessionDir = await writeSession(homeDir);
    await writeFile(path.join(sessionDir, '.lock'), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));

    await assert.rejects(
      () => deleteKiroSessionFromDisk(path.join(sessionDir, 'messages.jsonl'), SESSION_ID),
      (error) => error instanceof AppError && error.code === 'KIRO_SESSION_IN_USE' && error.statusCode === 409,
    );
    assert.equal(await exists(sessionDir), true);
  });
});

test('a stale lock from a process that has exited does not block the delete', async () => {
  await withKiroHome(async (homeDir) => {
    const sessionDir = await writeSession(homeDir);
    // Pids are bounded well below this on every supported platform.
    await writeFile(path.join(sessionDir, '.lock'), JSON.stringify({ pid: 2_147_483_000, started_at: '2026-01-01T00:00:00.000Z' }));
    assert.equal(await deleteKiroSessionFromDisk(null, SESSION_ID), true);
    assert.equal(await exists(sessionDir), false);

    const second = await writeSession(homeDir);
    await writeFile(path.join(second, '.lock'), 'not json');
    assert.equal(await deleteKiroSessionFromDisk(null, SESSION_ID), true);
  });
});
