import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { providerSkillsCentralService } from '@/modules/providers/services/skills-central.service.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { AppError } from '@/shared/utils.js';

const SKILL = (name: string, body = 'Body.') => `---\nname: ${name}\ndescription: ${name} skill\n---\n${body}`;

/** Runs a test against a fresh database and a fake home directory. */
async function withCentralSkills(run: (home: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const originalHomedir = os.homedir;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-central-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(home, 'auth.db');
  await fs.writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();
  (os as any).homedir = () => home;
  try {
    await run(home);
  } finally {
    (os as any).homedir = originalHomedir;
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await fs.rm(home, { recursive: true, force: true });
  }
}

const statusOf = (skill: { providers: Array<{ provider: string; state: string }> }, provider: string) =>
  skill.providers.find((entry) => entry.provider === provider)?.state;

/**
 * This test covers adding a central skill: it lands in `~/.agents/skills`, Codex and
 * OpenCode need no link, and Claude, Cursor and Kiro get live links to the same folder.
 */
test('a central skill is linked into the providers that need it', { concurrency: false }, async () => {
  await withCentralSkills(async (home) => {
    const { skills, results } = await providerSkillsCentralService.addCentralSkills({
      entries: [{ directoryName: 'shared-skill', content: SKILL('shared-skill') }],
    });

    assert.deepEqual(results.map((result) => result.outcome).sort(), ['linked', 'linked', 'linked']);
    const [skill] = skills;
    assert.equal(skill.sourcePath, path.join(home, '.agents', 'skills', 'shared-skill', 'SKILL.md'));
    assert.equal(statusOf(skill, 'codex'), 'native');
    assert.equal(statusOf(skill, 'opencode'), 'native');
    for (const provider of ['claude', 'cursor', 'kiro']) {
      assert.equal(statusOf(skill, provider), 'linked', provider);
      const link = path.join(home, `.${provider}`, 'skills', 'shared-skill');
      assert.ok((await fs.lstat(link)).isSymbolicLink(), provider);
    }

    // Editing the central file is visible through every link, and the provider lists see it.
    await fs.writeFile(path.join(home, '.agents', 'skills', 'shared-skill', 'SKILL.md'), SKILL('shared-skill', 'Edited.'));
    assert.match(await fs.readFile(path.join(home, '.kiro', 'skills', 'shared-skill', 'SKILL.md'), 'utf8'), /Edited\./);
    const kiroSkills = await providerSkillsService.listProviderSkills('kiro', { workspacePath: home });
    assert.ok(kiroSkills.some((entry) => entry.name === 'shared-skill'));
    for (const provider of ['claude', 'cursor'] as const) {
      const listed = await providerSkillsService.listProviderSkills(provider, { workspacePath: home });
      assert.ok(listed.some((entry) => entry.name === 'shared-skill'), `${provider} lists the linked skill`);
    }
  });
});

/**
 * This test covers entries the app does not own: a real folder with the same name is
 * reported as a conflict and left alone, and unlink removes only links it made.
 */
test('conflicting folders are never overwritten or removed', { concurrency: false }, async () => {
  await withCentralSkills(async (home) => {
    await providerSkillsService.addProviderSkills('codex', {
      entries: [{ directoryName: 'dup', content: SKILL('dup', 'Central.') }],
    });
    await fs.mkdir(path.join(home, '.cursor', 'skills', 'dup'), { recursive: true });
    await fs.writeFile(path.join(home, '.cursor', 'skills', 'dup', 'SKILL.md'), SKILL('dup', 'Mine.'));

    const results = await providerSkillsCentralService.linkCentralSkill('dup');
    assert.equal(results.find((result) => result.provider === 'cursor')?.outcome, 'conflict');
    assert.equal(results.find((result) => result.provider === 'claude')?.outcome, 'linked');
    assert.match(await fs.readFile(path.join(home, '.cursor', 'skills', 'dup', 'SKILL.md'), 'utf8'), /Mine\./);

    const [skill] = await providerSkillsCentralService.listCentralSkills();
    assert.equal(statusOf(skill, 'cursor'), 'conflict');

    const unlinked = await providerSkillsCentralService.unlinkCentralSkill('dup');
    assert.equal(unlinked.find((result) => result.provider === 'cursor')?.outcome, 'conflict');
    assert.equal(unlinked.find((result) => result.provider === 'claude')?.outcome, 'unlinked');
    assert.match(await fs.readFile(path.join(home, '.cursor', 'skills', 'dup', 'SKILL.md'), 'utf8'), /Mine\./);
    await assert.rejects(fs.lstat(path.join(home, '.claude', 'skills', 'dup')), { code: 'ENOENT' });
    // Unlinking must not touch the central folder the links pointed at.
    assert.match(await fs.readFile(path.join(home, '.agents', 'skills', 'dup', 'SKILL.md'), 'utf8'), /Central\./);
  });
});

/**
 * This test covers copy mode (used when links cannot be made): it is recorded, shows as
 * drifted once the central skill changes, and re-apply brings it back.
 */
test('copy mode reports drift and re-applies the central content', { concurrency: false }, async () => {
  await withCentralSkills(async (home) => {
    await providerSkillsCentralService.addCentralSkills(
      { entries: [{ directoryName: 'snap', content: SKILL('snap', 'One.') }] },
      { providers: ['kiro'], forceCopy: true },
    );
    const copyPath = path.join(home, '.kiro', 'skills', 'snap');
    assert.ok((await fs.lstat(copyPath)).isDirectory());
    assert.equal(statusOf((await providerSkillsCentralService.listCentralSkills())[0], 'kiro'), 'copy_in_sync');

    await fs.writeFile(path.join(home, '.agents', 'skills', 'snap', 'SKILL.md'), SKILL('snap', 'Two.'));
    assert.equal(statusOf((await providerSkillsCentralService.listCentralSkills())[0], 'kiro'), 'copy_drifted');
    // A drifted copy is not overwritten by a plain link request.
    assert.equal((await providerSkillsCentralService.linkCentralSkill('snap', ['kiro']))[0].outcome, 'conflict');

    assert.equal((await providerSkillsCentralService.resyncCentralSkill('snap', ['kiro']))[0].outcome, 'copied');
    assert.match(await fs.readFile(path.join(copyPath, 'SKILL.md'), 'utf8'), /Two\./);
    assert.equal(statusOf((await providerSkillsCentralService.listCentralSkills())[0], 'kiro'), 'copy_in_sync');
  });
});

/**
 * This test covers adopting a skill that already lives in one provider, plus removing a
 * central skill, and rejects names that could escape a skills folder.
 */
test('adopt moves a provider skill into the central folder; remove deletes links and folder', { concurrency: false }, async () => {
  await withCentralSkills(async (home) => {
    await fs.mkdir(path.join(home, '.claude', 'skills', 'mine'), { recursive: true });
    await fs.writeFile(path.join(home, '.claude', 'skills', 'mine', 'SKILL.md'), SKILL('mine'));
    await fs.writeFile(path.join(home, '.claude', 'skills', 'mine', 'extra.txt'), 'x');

    const adopted = await providerSkillsCentralService.adoptProviderSkill('claude', 'mine');
    assert.equal(adopted.outcome, 'linked');
    assert.ok((await fs.lstat(path.join(home, '.claude', 'skills', 'mine'))).isSymbolicLink());
    assert.equal(await fs.readFile(path.join(home, '.agents', 'skills', 'mine', 'extra.txt'), 'utf8'), 'x');

    await assert.rejects(
      providerSkillsCentralService.adoptProviderSkill('claude', 'mine'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );
    await assert.rejects(
      providerSkillsCentralService.linkCentralSkill('../etc'),
      (error: unknown) => error instanceof AppError && error.code === 'SKILL_DIRECTORY_INVALID',
    );
    await assert.rejects(
      providerSkillsCentralService.adoptProviderSkill('codex', 'mine'),
      (error: unknown) => error instanceof AppError && error.code === 'SKILL_LINK_UNSUPPORTED',
    );

    await providerSkillsCentralService.linkCentralSkill('mine');
    const removed = await providerSkillsCentralService.removeCentralSkill('mine');
    assert.equal(removed.removed, true);
    await assert.rejects(fs.lstat(path.join(home, '.agents', 'skills', 'mine')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(home, '.kiro', 'skills', 'mine')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(home, '.claude', 'skills', 'mine')), { code: 'ENOENT' });
  });
});
