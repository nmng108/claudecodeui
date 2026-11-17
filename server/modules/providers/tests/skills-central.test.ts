import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb } from '@/modules/database/index.js';
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

// ----------------- Project scope -----------------

/** Registers a project folder inside the fake home and returns its id and path. */
async function registerProject(home: string, name = 'app'): Promise<{ projectId: string; projectPath: string }> {
  const projectPath = path.join(home, 'work', name);
  await fs.mkdir(projectPath, { recursive: true });
  const { project } = projectsDb.createProjectPath(projectPath, name);
  return { projectId: project!.project_id, projectPath: project!.project_path };
}

/**
 * A project has its own shared folder (`<project>/.agents/skills`), linked into the
 * project's own provider folders with relative links, and none of it touches the
 * user's folders.
 */
test('a project skill is shared inside the project and never touches the user folders', { concurrency: false }, async () => {
  await withCentralSkills(async (home) => {
    const { projectId, projectPath } = await registerProject(home);

    const { skills, results } = await providerSkillsCentralService.addCentralSkills(
      { entries: [{ directoryName: 'team-skill', content: SKILL('team-skill') }] },
      { projectId },
    );

    // Kiro and Claude need a link; Codex, OpenCode and Cursor read `.agents/skills` themselves here.
    assert.deepEqual(results.map((result) => result.provider).sort(), ['claude', 'kiro']);
    assert.ok(results.every((result) => result.outcome === 'linked'));
    const [skill] = skills;
    assert.equal(skill.sourcePath, path.join(projectPath, '.agents', 'skills', 'team-skill', 'SKILL.md'));
    for (const provider of ['codex', 'opencode', 'cursor']) {
      assert.equal(statusOf(skill, provider), 'native', provider);
    }
    for (const provider of ['claude', 'kiro']) {
      assert.equal(statusOf(skill, provider), 'linked', provider);
      const link = path.join(projectPath, `.${provider}`, 'skills', 'team-skill');
      assert.ok((await fs.lstat(link)).isSymbolicLink(), provider);
      // Relative, so the link still resolves when the project is moved or cloned.
      assert.equal(path.isAbsolute(await fs.readlink(link)), false, provider);
      assert.match(await fs.readFile(path.join(link, 'SKILL.md'), 'utf8'), /team-skill/);
    }
    await assert.rejects(fs.lstat(path.join(projectPath, '.cursor')), { code: 'ENOENT' });

    // The provider lists for the project see it; nothing was written under the home folders.
    const kiroSkills = await providerSkillsService.listProviderSkills('kiro', { workspacePath: projectPath });
    assert.ok(kiroSkills.some((entry) => entry.name === 'team-skill' && entry.scope === 'project'));
    await assert.rejects(fs.lstat(path.join(home, '.agents')), { code: 'ENOENT' });
    await assert.rejects(fs.lstat(path.join(home, '.kiro')), { code: 'ENOENT' });
    assert.deepEqual(await providerSkillsCentralService.listCentralSkills(), []);
  });
});

test('two projects and the user keep separate shared skills', { concurrency: false }, async () => {
  await withCentralSkills(async (home) => {
    const first = await registerProject(home, 'first');
    const second = await registerProject(home, 'second');

    await providerSkillsCentralService.addCentralSkills(
      { entries: [{ directoryName: 'only-first', content: SKILL('only-first') }] },
      { projectId: first.projectId },
    );
    await providerSkillsCentralService.addCentralSkills({ entries: [{ directoryName: 'for-me', content: SKILL('for-me') }] });

    const names = async (projectId?: string) =>
      (await providerSkillsCentralService.listCentralSkills(projectId)).map((skill) => skill.directoryName);
    assert.deepEqual(await names(first.projectId), ['only-first']);
    assert.deepEqual(await names(second.projectId), []);
    assert.deepEqual(await names(), ['for-me']);
  });
});

test('unlinking and removing a project skill leaves the user skill of the same name alone', { concurrency: false }, async () => {
  await withCentralSkills(async (home) => {
    const { projectId, projectPath } = await registerProject(home);
    const entries = [{ directoryName: 'same', content: SKILL('same') }];
    await providerSkillsCentralService.addCentralSkills({ entries });
    await providerSkillsCentralService.addCentralSkills({ entries }, { projectId });

    const unlinked = await providerSkillsCentralService.unlinkCentralSkill('same', ['kiro'], projectId);
    assert.equal(unlinked[0].outcome, 'unlinked');
    await assert.rejects(fs.lstat(path.join(projectPath, '.kiro', 'skills', 'same')), { code: 'ENOENT' });
    assert.ok((await fs.lstat(path.join(home, '.kiro', 'skills', 'same'))).isSymbolicLink(), 'the user link is untouched');

    const removed = await providerSkillsCentralService.removeCentralSkill('same', projectId);
    assert.equal(removed.removed, true);
    await assert.rejects(fs.lstat(path.join(projectPath, '.agents', 'skills', 'same')), { code: 'ENOENT' });
    assert.ok((await fs.lstat(path.join(home, '.agents', 'skills', 'same'))).isDirectory(), 'the user skill is untouched');
  });
});

test('a project copy is recorded under the project, so it can drift and be re-applied there', { concurrency: false }, async () => {
  await withCentralSkills(async (home) => {
    const { projectId, projectPath } = await registerProject(home);
    await providerSkillsCentralService.addCentralSkills(
      { entries: [{ directoryName: 'snap', content: SKILL('snap', 'One.') }] },
      { providers: ['kiro'], forceCopy: true, projectId },
    );
    const status = async () => statusOf((await providerSkillsCentralService.listCentralSkills(projectId))[0], 'kiro');
    assert.equal(await status(), 'copy_in_sync');

    await fs.writeFile(path.join(projectPath, '.agents', 'skills', 'snap', 'SKILL.md'), SKILL('snap', 'Two.'));
    assert.equal(await status(), 'copy_drifted');
    assert.equal((await providerSkillsCentralService.resyncCentralSkill('snap', ['kiro'], projectId))[0].outcome, 'copied');
    assert.equal(await status(), 'copy_in_sync');
  });
});

test('adopt moves a project skill folder into the project shared folder and links it back', { concurrency: false }, async () => {
  await withCentralSkills(async (home) => {
    const { projectId, projectPath } = await registerProject(home);
    const own = path.join(projectPath, '.kiro', 'skills', 'mine');
    await fs.mkdir(own, { recursive: true });
    await fs.writeFile(path.join(own, 'SKILL.md'), SKILL('mine'));

    const adopted = await providerSkillsCentralService.adoptProviderSkill('kiro', 'mine', projectId);
    assert.equal(adopted.outcome, 'linked');
    assert.ok((await fs.lstat(own)).isSymbolicLink());
    assert.match(await fs.readFile(path.join(projectPath, '.agents', 'skills', 'mine', 'SKILL.md'), 'utf8'), /mine/);

    // Cursor reads the project shared folder itself, so there is nothing to adopt into.
    await assert.rejects(
      providerSkillsCentralService.adoptProviderSkill('cursor', 'mine', projectId),
      (error: unknown) => error instanceof AppError && error.code === 'SKILL_LINK_UNSUPPORTED',
    );
  });
});

test('a request for an unknown project, or a name that escapes the folder, is refused', { concurrency: false }, async () => {
  await withCentralSkills(async (home) => {
    const { projectId } = await registerProject(home);

    await assert.rejects(
      providerSkillsCentralService.listCentralSkills('no-such-project'),
      (error: unknown) => error instanceof AppError && error.code === 'PROJECT_NOT_FOUND' && error.statusCode === 404,
    );
    await assert.rejects(
      providerSkillsCentralService.linkCentralSkill('../escape', undefined, false, projectId),
      (error: unknown) => error instanceof AppError && error.code === 'SKILL_DIRECTORY_INVALID',
    );
  });
});

/** Per-provider project skills: where each provider writes them, and which refuse. */
test('providerSkillsService writes and removes project skills in each provider\'s project folder', { concurrency: false }, async () => {
  await withCentralSkills(async (home) => {
    const { projectId, projectPath } = await registerProject(home);
    const input = { entries: [{ directoryName: 'proj-skill', content: SKILL('proj-skill') }] };
    const folders: Record<string, string> = {
      kiro: '.kiro',
      claude: '.claude',
      cursor: '.cursor',
      codex: '.agents',
    };

    for (const [provider, folder] of Object.entries(folders)) {
      const [written] = await providerSkillsService.addProviderSkills(provider, input, projectId);
      assert.equal(written.scope, 'project', provider);
      assert.equal(written.sourcePath, path.join(projectPath, folder, 'skills', 'proj-skill', 'SKILL.md'), provider);
    }
    await assert.rejects(fs.lstat(path.join(home, '.kiro')), { code: 'ENOENT' });

    const removed = await providerSkillsService.removeProviderSkill('kiro', { directoryName: 'proj-skill' }, projectId);
    assert.equal(removed.removed, true);
    await assert.rejects(fs.lstat(path.join(projectPath, '.kiro', 'skills', 'proj-skill')), { code: 'ENOENT' });
    assert.ok((await fs.lstat(path.join(projectPath, '.claude', 'skills', 'proj-skill'))).isDirectory());

    await assert.rejects(
      providerSkillsService.addProviderSkills('opencode', input, projectId),
      (error: unknown) => error instanceof AppError && error.code === 'PROVIDER_SKILLS_WRITE_UNSUPPORTED',
    );
  });
});
