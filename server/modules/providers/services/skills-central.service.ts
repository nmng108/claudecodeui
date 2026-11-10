import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { skillCentralLinksDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  CentralSkill,
  CentralSkillApplyResult,
  CentralSkillLinkMode,
  CentralSkillProviderState,
  CentralSkillProviderStatus,
  LLMProvider,
  ProviderSkillCreateInput,
} from '@/shared/types.js';
import { AppError, readProviderSkillMarkdownDefinition } from '@/shared/utils.js';

/**
 * Providers that already read the central folder themselves (Codex's user skills
 * folder is the central folder; OpenCode lists `~/.agents/skills`), so they never
 * need a link.
 */
const NATIVE_PROVIDERS: LLMProvider[] = ['codex', 'opencode'];

/** Errors that mean "this platform or account cannot create the link", so a copy is made instead. */
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'UNKNOWN', 'EINVAL']);

const LINK_MODE_FOR_PLATFORM: CentralSkillLinkMode = process.platform === 'win32' ? 'junction' : 'symlink';

const getCentralRoot = (): string => path.join(os.homedir(), '.agents', 'skills');

const failure = (code: string, message: string, statusCode: number): AppError =>
  new AppError(message, { code, statusCode });

/** Rejects names that could escape a skills folder; skill names are used as folder names. */
const assertSafeDirectoryName = (value: unknown): string => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name) || name.length > 255) {
    throw failure('SKILL_DIRECTORY_INVALID', 'A valid skill directory name is required.', 400);
  }

  return name;
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : 'Unknown error');

const exists = async (target: string): Promise<boolean> => lstat(target).then(() => true).catch(() => false);

/** Hashes every file below a folder (names and contents) so two folders can be compared cheaply. */
const hashDirectory = async (directory: string): Promise<string> => {
  const hash = createHash('sha256');
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\0`);
        await walk(full, `${relative}/`);
      } else if (entry.isFile()) {
        hash.update(`f:${relative}\0`);
        hash.update(await readFile(full));
        hash.update('\0');
      }
    }
  };

  await walk(directory, '');
  return hash.digest('hex');
};

type LinkTarget = { provider: LLMProvider; root: string };

/** Providers that need a link, with the folder each one reads user skills from. */
const listLinkTargets = async (): Promise<LinkTarget[]> => {
  const centralRoot = path.resolve(getCentralRoot());
  const targets: LinkTarget[] = [];
  for (const provider of providerRegistry.listProviders()) {
    if (NATIVE_PROVIDERS.includes(provider.id)) {
      continue;
    }

    const root = await provider.skills.getManagedSkillsRoot();
    if (root && path.resolve(root) !== centralRoot) {
      targets.push({ provider: provider.id, root });
    }
  }

  return targets;
};

const requireLinkTarget = async (provider: LLMProvider): Promise<LinkTarget> => {
  const target = (await listLinkTargets()).find((candidate) => candidate.provider === provider);
  if (!target) {
    throw failure('SKILL_LINK_UNSUPPORTED', `${provider} does not need or support linked central skills.`, 400);
  }

  return target;
};

const resolveProviders = async (requested: LLMProvider[] | undefined): Promise<LinkTarget[]> => {
  const targets = await listLinkTargets();
  if (!requested) {
    return targets;
  }

  return requested.map((provider) => {
    const target = targets.find((candidate) => candidate.provider === provider);
    if (!target) {
      throw failure('SKILL_LINK_UNSUPPORTED', `${provider} does not need or support linked central skills.`, 400);
    }

    return target;
  });
};

type Inspection = { state: CentralSkillProviderState; mode?: CentralSkillLinkMode };

/** Works out what is at a provider's skill path relative to the central folder. */
const inspectEntry = async (
  skillName: string,
  provider: LLMProvider,
  centralDir: string,
  entryPath: string,
): Promise<Inspection> => {
  const record = skillCentralLinksDb.listLinks(skillName).find((link) => link.provider === provider);
  const entry = await lstat(entryPath).catch(() => null);
  if (!entry) {
    return { state: record ? 'broken' : 'unlinked' };
  }

  if (entry.isSymbolicLink()) {
    const resolved = await realpath(entryPath).catch(() => null);
    if (!resolved) {
      return { state: 'broken', mode: record?.mode };
    }

    const central = await realpath(centralDir).catch(() => null);
    return resolved === central
      ? { state: 'linked', mode: record?.mode ?? LINK_MODE_FOR_PLATFORM }
      : { state: 'conflict' };
  }

  if (entry.isDirectory() && record?.mode === 'copy') {
    const [copyHash, centralHash] = await Promise.all([hashDirectory(entryPath), hashDirectory(centralDir)]);
    return { state: copyHash === centralHash ? 'copy_in_sync' : 'copy_drifted', mode: 'copy' };
  }

  return { state: 'conflict' };
};

/** Creates the provider entry: a directory link where possible, otherwise a copy. */
const createEntry = async (
  centralDir: string,
  entryPath: string,
  forceCopy: boolean,
): Promise<CentralSkillLinkMode> => {
  await mkdir(path.dirname(entryPath), { recursive: true });
  if (!forceCopy) {
    try {
      // 'junction' needs no elevated rights on Windows; the type is ignored elsewhere.
      await symlink(centralDir, entryPath, process.platform === 'win32' ? 'junction' : 'dir');
      return LINK_MODE_FOR_PLATFORM;
    } catch (error) {
      if (!LINK_UNSUPPORTED_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }
    }
  }

  await cp(centralDir, entryPath, { recursive: true, errorOnExist: true, force: false });
  return 'copy';
};

/** Removes an entry the app owns: a link to the central folder, or a recorded copy. */
const removeOwnedEntry = async (
  skillName: string,
  provider: LLMProvider,
  centralDir: string,
  entryPath: string,
): Promise<void> => {
  const inspection = await inspectEntry(skillName, provider, centralDir, entryPath);
  const entry = await lstat(entryPath).catch(() => null);
  if (!entry) {
    skillCentralLinksDb.removeLink(skillName, provider);
    return;
  }

  const isLink = entry.isSymbolicLink() && inspection.state !== 'conflict';
  const isOwnedCopy = !entry.isSymbolicLink() && inspection.mode === 'copy';
  if (!isLink && !isOwnedCopy) {
    throw failure('SKILL_LINK_NOT_OWNED', `${provider} has a "${skillName}" entry that was not created here, so it was left alone.`, 409);
  }

  // A link is removed itself, never followed; a recorded copy is removed with its contents.
  await rm(entryPath, { recursive: true, force: true });
  skillCentralLinksDb.removeLink(skillName, provider);
};

const resultFor = async (
  run: () => Promise<CentralSkillApplyResult['outcome']>,
  provider: LLMProvider,
): Promise<CentralSkillApplyResult> => {
  try {
    return { provider, outcome: await run() };
  } catch (error) {
    const outcome = error instanceof AppError && error.statusCode === 409 ? 'conflict' : 'failed';
    return { provider, outcome, error: errorMessage(error) };
  }
};

const requireCentralDir = async (directoryName: string): Promise<string> => {
  const name = assertSafeDirectoryName(directoryName);
  const centralDir = path.join(getCentralRoot(), name);
  const isSkill = await stat(path.join(centralDir, 'SKILL.md')).then((stats) => stats.isFile()).catch(() => false);
  if (!isSkill) {
    throw failure('CENTRAL_SKILL_NOT_FOUND', `Central skill "${name}" was not found.`, 404);
  }

  return centralDir;
};

const describeCentralSkill = async (directoryName: string, targets: LinkTarget[]): Promise<CentralSkill> => {
  const centralDir = path.join(getCentralRoot(), directoryName);
  const sourcePath = path.join(centralDir, 'SKILL.md');
  const definition = await readProviderSkillMarkdownDefinition(sourcePath).catch(() => ({ name: directoryName, description: '' }));
  const providers: CentralSkillProviderStatus[] = [];

  for (const provider of providerRegistry.listProviders()) {
    if (NATIVE_PROVIDERS.includes(provider.id)) {
      providers.push({ provider: provider.id, state: 'native' });
      continue;
    }

    const target = targets.find((candidate) => candidate.provider === provider.id);
    if (!target) {
      continue;
    }

    const entryPath = path.join(target.root, directoryName);
    try {
      const inspection = await inspectEntry(directoryName, provider.id, centralDir, entryPath);
      providers.push({ provider: provider.id, state: inspection.state, mode: inspection.mode, path: entryPath });
    } catch {
      providers.push({ provider: provider.id, state: 'broken', path: entryPath });
    }
  }

  return { directoryName, name: definition.name, description: definition.description, sourcePath, providers };
};

export const providerSkillsCentralService = {
  /** Lists the skills in the central folder and how each provider relates to them. */
  async listCentralSkills(): Promise<CentralSkill[]> {
    const entries = await readdir(getCentralRoot(), { withFileTypes: true }).catch(() => []);
    const targets = await listLinkTargets();
    const skills: CentralSkill[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const isSkill = await stat(path.join(getCentralRoot(), entry.name, 'SKILL.md')).then((stats) => stats.isFile()).catch(() => false);
      if (isSkill) {
        skills.push(await describeCentralSkill(entry.name, targets));
      }
    }

    return skills;
  },

  /**
   * Writes skills into the central folder (through Codex, whose user skills
   * folder is the central folder) and links them into the given providers.
   */
  async addCentralSkills(
    input: ProviderSkillCreateInput,
    options: { providers?: LLMProvider[]; forceCopy?: boolean } = {},
  ): Promise<{ skills: CentralSkill[]; results: CentralSkillApplyResult[] }> {
    const added = await providerRegistry.resolveProvider('codex').skills.addSkills(input);
    const names = added.map((skill) => path.basename(path.dirname(skill.sourcePath)));
    for (const skill of added) {
      if (path.resolve(path.dirname(path.dirname(skill.sourcePath))) !== path.resolve(getCentralRoot())) {
        throw failure('CENTRAL_SKILLS_ROOT_MISMATCH', 'Skills were not written to the central skills folder.', 500);
      }
    }

    const results: CentralSkillApplyResult[] = [];
    for (const name of names) {
      results.push(...await providerSkillsCentralService.linkCentralSkill(name, options.providers, options.forceCopy));
    }

    const targets = await listLinkTargets();
    return { skills: await Promise.all(names.map((name) => describeCentralSkill(name, targets))), results };
  },

  /** Links a central skill into providers (default: every provider that needs it). */
  async linkCentralSkill(
    directoryName: string,
    providers?: LLMProvider[],
    forceCopy = false,
  ): Promise<CentralSkillApplyResult[]> {
    const centralDir = await requireCentralDir(directoryName);
    const name = path.basename(centralDir);
    const results: CentralSkillApplyResult[] = [];
    for (const target of await resolveProviders(providers)) {
      results.push(await resultFor(async () => {
        const entryPath = path.join(target.root, name);
        const current = await inspectEntry(name, target.provider, centralDir, entryPath);
        if (current.state === 'linked' || current.state === 'copy_in_sync') {
          return 'already_linked';
        }

        if (current.state === 'conflict' || current.state === 'copy_drifted') {
          throw failure('SKILL_LINK_CONFLICT', `${target.provider} already has a different "${name}" skill. Adopt or remove it first.`, 409);
        }

        if (current.state === 'broken' && await exists(entryPath)) {
          await removeOwnedEntry(name, target.provider, centralDir, entryPath);
        }

        const mode = await createEntry(centralDir, entryPath, forceCopy);
        skillCentralLinksDb.setLink(name, target.provider, mode);
        return mode === 'copy' ? 'copied' : 'linked';
      }, target.provider));
    }

    return results;
  },

  /** Removes the links (or recorded copies) the app made for a skill; entries it did not create are left alone. */
  async unlinkCentralSkill(directoryName: string, providers?: LLMProvider[]): Promise<CentralSkillApplyResult[]> {
    const centralDir = await requireCentralDir(directoryName);
    const name = path.basename(centralDir);
    const results: CentralSkillApplyResult[] = [];
    for (const target of await resolveProviders(providers)) {
      results.push(await resultFor(async () => {
        await removeOwnedEntry(name, target.provider, centralDir, path.join(target.root, name));
        return 'unlinked';
      }, target.provider));
    }

    return results;
  },

  /** Replaces recorded copies (and broken links) with the current central content. */
  async resyncCentralSkill(directoryName: string, providers?: LLMProvider[]): Promise<CentralSkillApplyResult[]> {
    const centralDir = await requireCentralDir(directoryName);
    const name = path.basename(centralDir);
    const results: CentralSkillApplyResult[] = [];
    for (const target of await resolveProviders(providers)) {
      results.push(await resultFor(async () => {
        const entryPath = path.join(target.root, name);
        const current = await inspectEntry(name, target.provider, centralDir, entryPath);
        if (current.state === 'copy_in_sync' || current.state === 'linked') {
          return 'already_linked';
        }

        if (current.state !== 'copy_drifted' && current.state !== 'broken') {
          throw failure('SKILL_LINK_NOT_OWNED', `${target.provider} has no linked copy of "${name}" to re-apply.`, 409);
        }

        const record = skillCentralLinksDb.listLinks(name).find((link) => link.provider === target.provider);
        await removeOwnedEntry(name, target.provider, centralDir, entryPath);
        const mode = await createEntry(centralDir, entryPath, record?.mode === 'copy');
        skillCentralLinksDb.setLink(name, target.provider, mode);
        return mode === 'copy' ? 'copied' : 'linked';
      }, target.provider));
    }

    return results;
  },

  /**
   * Moves an existing provider skill folder into the central folder and links it
   * back, so a skill that lives in one provider becomes shared. Refuses when the
   * central folder already has a skill of that name.
   */
  async adoptProviderSkill(provider: LLMProvider, directoryName: string): Promise<CentralSkillApplyResult> {
    const target = await requireLinkTarget(provider);
    const name = assertSafeDirectoryName(directoryName);
    const source = path.join(target.root, name);
    const entry = await lstat(source).catch(() => null);
    if (!entry || !entry.isDirectory() || !await exists(path.join(source, 'SKILL.md'))) {
      throw failure('SKILL_ADOPT_SOURCE_INVALID', `${provider} has no skill folder named "${name}" to adopt.`, 404);
    }

    const centralDir = path.join(getCentralRoot(), name);
    if (await exists(centralDir)) {
      throw failure('CENTRAL_SKILL_EXISTS', `The central skills folder already has "${name}".`, 409);
    }

    await mkdir(getCentralRoot(), { recursive: true });
    try {
      await rename(source, centralDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') {
        throw error;
      }

      // Across devices a rename is impossible; copy, then remove the original.
      await cp(source, centralDir, { recursive: true, errorOnExist: true, force: false });
      await rm(source, { recursive: true, force: true });
    }

    return resultFor(async () => {
      const mode = await createEntry(centralDir, source, false);
      skillCentralLinksDb.setLink(name, provider, mode);
      return mode === 'copy' ? 'copied' : 'linked';
    }, provider);
  },

  /** Unlinks a skill everywhere, then deletes it from the central folder. */
  async removeCentralSkill(directoryName: string): Promise<{ removed: boolean; results: CentralSkillApplyResult[] }> {
    const centralDir = await requireCentralDir(directoryName);
    const name = path.basename(centralDir);
    const results = await providerSkillsCentralService.unlinkCentralSkill(name);
    // Entries we do not own are not our problem, but a failed unlink must not leave dangling links.
    if (results.some((result) => result.outcome === 'failed')) {
      return { removed: false, results };
    }

    await rm(centralDir, { recursive: true, force: true });
    return { removed: true, results };
  },
};
