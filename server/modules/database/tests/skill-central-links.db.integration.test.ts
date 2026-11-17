import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  skillCentralLinksDb,
} from '@/modules/database/index.js';
import { runMigrations } from '@/modules/database/migrations.js';

/** Runs a test against a fresh database in a temporary folder. */
async function withDatabase(run: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'skill-links-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    await run();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('links are recorded, listed and removed per scope', async () => {
  await withDatabase(() => {
    skillCentralLinksDb.setLink('user', 'shared', 'kiro', 'symlink');
    skillCentralLinksDb.setLink('project-1', 'shared', 'kiro', 'copy');
    skillCentralLinksDb.setLink('project-1', 'other', 'claude', 'symlink');

    assert.deepEqual(skillCentralLinksDb.listLinks('user'), [{ skillName: 'shared', provider: 'kiro', mode: 'symlink' }]);
    assert.deepEqual(skillCentralLinksDb.listLinks('project-1', 'shared'), [{ skillName: 'shared', provider: 'kiro', mode: 'copy' }]);
    assert.equal(skillCentralLinksDb.listLinks('project-1').length, 2);

    // Recording again updates the mode instead of adding a row.
    skillCentralLinksDb.setLink('project-1', 'shared', 'kiro', 'symlink');
    assert.equal(skillCentralLinksDb.listLinks('project-1', 'shared')[0].mode, 'symlink');

    skillCentralLinksDb.removeLink('project-1', 'shared', 'kiro');
    assert.deepEqual(skillCentralLinksDb.listLinks('project-1', 'shared'), []);
    assert.equal(skillCentralLinksDb.listLinks('user').length, 1, 'another scope keeps its row');
  });
});

test('an install that recorded links before scopes existed keeps them as user links', async () => {
  await withDatabase(() => {
    const db = getConnection();
    // The table as older versions created it: keyed by skill and provider only.
    db.exec('DROP TABLE skill_central_links');
    db.exec(`
      CREATE TABLE skill_central_links (
        skill_name TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'cursor', 'codex', 'opencode', 'kiro')),
        mode TEXT NOT NULL CHECK (mode IN ('symlink', 'junction', 'copy')),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (skill_name, provider)
      )
    `);
    db.prepare('INSERT INTO skill_central_links (skill_name, provider, mode) VALUES (?, ?, ?)').run('old', 'kiro', 'copy');

    runMigrations(db);

    assert.deepEqual(skillCentralLinksDb.listLinks('user'), [{ skillName: 'old', provider: 'kiro', mode: 'copy' }]);
    // The same skill can now be recorded for a project too.
    skillCentralLinksDb.setLink('project-1', 'old', 'kiro', 'symlink');
    assert.equal(skillCentralLinksDb.listLinks('project-1').length, 1);

    // Running the migration again is a no-op.
    runMigrations(db);
    assert.equal(skillCentralLinksDb.listLinks('user').length, 1);
  });
});
