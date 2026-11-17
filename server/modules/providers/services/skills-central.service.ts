import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { skillCentralLinksDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { installSkillEntries } from '@/modules/providers/shared/skills/skills.provider.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import type {
  CentralScopeProvider,
  CentralSkill,
  CentralSkillApplyResult,
  CentralSkillLinkMode,
  CentralSkillProviderState,
  CentralSkillProviderStatus,
  LLMProvider,
  ProviderSkillCreateInput,
  SkillScopeTarget,
} from '@/shared/types.js';
import { AppError, readProviderSkillMarkdownDefinition } from '@/shared/utils.js';

/** Errors that mean "this platform or account cannot create the link", so a copy is made instead. */
const LINK_UNSUPPORTED_CODES = new Set(['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'UNKNOWN', 'EINVAL']);

const LINK_MODE_FOR_PLATFORM: CentralSkillLinkMode = process.platform === 'win32' ? 'junction' : 'symlink';

/**
 * One place shared skills live, and the provider folders linked to it. Everything
 * below works on one context at a time, so the user's skills (`~/.agents/skills`
 * linked into `~/.<provider>/skills`) and a project's (`<project>/.agents/skills`
 * linked into `<project>/.<provider>/skills`) follow identical rules, and a link
 * never crosses from one context into the other.
 */
type ScopeContext = {
  /** `user`, or the project id; keys the recorded links. */
  key: string;
  target: SkillScopeTarget;
  /** The shared folder of this context: where the real skill folders are kept. */
  storeRoot: string;
  /**
   * Whether links are written relative to the entry. A project's links are, so
   * they still resolve when the project is moved or cloned elsewhere and the
   * links are committed; the user's stay absolute.
   */
  relativeLinks: boolean;
};

const USER_CONTEXT_KEY = 'user';

const resolveContext = (target: SkillScopeTarget = { scope: 'user' }): ScopeContext =>
  target.scope === 'user'
    ? {
        key: USER_CONTEXT_KEY,
        target,
        storeRoot: path.join(os.homedir(), '.agents', 'skills'),
        relativeLinks: false,
      }
    : {
        key: target.projectId,
        target,
        storeRoot: path.join(path.resolve(target.workspacePath), '.agents', 'skills'),
        relativeLinks: true,
      };

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

/** One provider's relation to a context: where it keeps skills there, and whether it reads the shared folder itself. */
type ScopeProvider = { provider: LLMProvider; root: string | null; native: boolean };

/**
 * Works out, per provider, whether it needs a link in this context. A provider
 * whose own read list includes the shared folder (Codex everywhere, OpenCode
 * everywhere, Cursor inside a project) is `native`: it sees shared skills as
 * they are. The others are linked into their own folder.
 */
const listScopeProviders = async (context: ScopeContext): Promise<ScopeProvider[]> => {
  const store = path.resolve(context.storeRoot);
  const providers: ScopeProvider[] = [];
  for (const provider of providerRegistry.listProviders()) {
    const [root, readable] = await Promise.all([
      provider.skills.getSkillsRoot(context.target),
      provider.skills.getReadableRoots(context.target),
    ]);
    providers.push({
      provider: provider.id,
      root,
      native: readable.some((candidate) => path.resolve(candidate) === store),
    });
  }

  return providers;
};

/** Providers that need a link, with the folder each one reads this context's skills from. */
const listLinkTargets = async (context: ScopeContext): Promise<LinkTarget[]> => {
  const store = path.resolve(context.storeRoot);
  return (await listScopeProviders(context))
    .filter((entry): entry is ScopeProvider & { root: string } => (
      !entry.native && entry.root !== null && path.resolve(entry.root) !== store
    ))
    .map((entry) => ({ provider: entry.provider, root: entry.root }));
};

const resolveProviders = async (
  context: ScopeContext,
  requested: LLMProvider[] | undefined,
): Promise<LinkTarget[]> => {
  const targets = await listLinkTargets(context);
  if (!requested) {
    return targets;
  }

  return requested.map((provider) => {
    const target = targets.find((candidate) => candidate.provider === provider);
    if (!target) {
      throw failure('SKILL_LINK_UNSUPPORTED', `${provider} does not need or support linked shared skills here.`, 400);
    }

    return target;
  });
};

type Inspection = { state: CentralSkillProviderState; mode?: CentralSkillLinkMode };

/** Works out what is at a provider's skill path relative to the central folder. */
const inspectEntry = async (
  context: ScopeContext,
  skillName: string,
  provider: LLMProvider,
  centralDir: string,
  entryPath: string,
): Promise<Inspection> => {
  const record = skillCentralLinksDb.listLinks(context.key, skillName).find((link) => link.provider === provider);
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
  context: ScopeContext,
  centralDir: string,
  entryPath: string,
  forceCopy: boolean,
): Promise<CentralSkillLinkMode> => {
  await mkdir(path.dirname(entryPath), { recursive: true });
  if (!forceCopy) {
    try {
      // 'junction' needs no elevated rights on Windows (and must be absolute there);
      // the type is ignored elsewhere.
      const linkTarget = context.relativeLinks && process.platform !== 'win32'
        ? path.relative(path.dirname(entryPath), centralDir)
        : centralDir;
      await symlink(linkTarget, entryPath, process.platform === 'win32' ? 'junction' : 'dir');
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
  context: ScopeContext,
  skillName: string,
  provider: LLMProvider,
  centralDir: string,
  entryPath: string,
): Promise<void> => {
  const inspection = await inspectEntry(context, skillName, provider, centralDir, entryPath);
  const entry = await lstat(entryPath).catch(() => null);
  if (!entry) {
    skillCentralLinksDb.removeLink(context.key, skillName, provider);
    return;
  }

  const isLink = entry.isSymbolicLink() && inspection.state !== 'conflict';
  const isOwnedCopy = !entry.isSymbolicLink() && inspection.mode === 'copy';
  if (!isLink && !isOwnedCopy) {
    throw failure('SKILL_LINK_NOT_OWNED', `${provider} has a "${skillName}" entry that was not created here, so it was left alone.`, 409);
  }

  // A link is removed itself, never followed; a recorded copy is removed with its contents.
  await rm(entryPath, { recursive: true, force: true });
  skillCentralLinksDb.removeLink(context.key, skillName, provider);
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

const requireCentralDir = async (context: ScopeContext, directoryName: string): Promise<string> => {
  const name = assertSafeDirectoryName(directoryName);
  const centralDir = path.join(context.storeRoot, name);
  const isSkill = await stat(path.join(centralDir, 'SKILL.md')).then((stats) => stats.isFile()).catch(() => false);
  if (!isSkill) {
    throw failure('CENTRAL_SKILL_NOT_FOUND', `Central skill "${name}" was not found.`, 404);
  }

  return centralDir;
};

const describeCentralSkill = async (
  context: ScopeContext,
  directoryName: string,
  scopeProviders: ScopeProvider[],
): Promise<CentralSkill> => {
  const centralDir = path.join(context.storeRoot, directoryName);
  const sourcePath = path.join(centralDir, 'SKILL.md');
  const definition = await readProviderSkillMarkdownDefinition(sourcePath).catch(() => ({ name: directoryName, description: '' }));
  const store = path.resolve(context.storeRoot);
  const providers: CentralSkillProviderStatus[] = [];

  for (const entry of scopeProviders) {
    if (entry.native) {
      providers.push({ provider: entry.provider, state: 'native' });
      continue;
    }

    // A provider with no folder here, or whose folder is the shared one, has nothing to link.
    if (!entry.root || path.resolve(entry.root) === store) {
      continue;
    }

    const entryPath = path.join(entry.root, directoryName);
    try {
      const inspection = await inspectEntry(context, directoryName, entry.provider, centralDir, entryPath);
      providers.push({ provider: entry.provider, state: inspection.state, mode: inspection.mode, path: entryPath });
    } catch {
      providers.push({ provider: entry.provider, state: 'broken', path: entryPath });
    }
  }

  return { directoryName, name: definition.name, description: definition.description, sourcePath, providers };
};

/**
 * Shared skills, for the user's folders or for one project's. Every method takes
 * an optional project id: left out, it works on `~/.agents/skills` and the user's
 * provider folders; given, on that project's `.agents/skills` and provider folders.
 */
export const providerSkillsCentralService = {
  /** Lists the skills in a shared folder and how each provider relates to them. */
  async listCentralSkills(projectId?: string | null): Promise<CentralSkill[]> {
    const context = resolveContext(providerSkillsService.resolveTarget(projectId));
    const entries = await readdir(context.storeRoot, { withFileTypes: true }).catch(() => []);
    const scopeProviders = await listScopeProviders(context);
    const skills: CentralSkill[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const isSkill = await stat(path.join(context.storeRoot, entry.name, 'SKILL.md')).then((stats) => stats.isFile()).catch(() => false);
      if (isSkill) {
        skills.push(await describeCentralSkill(context, entry.name, scopeProviders));
      }
    }

    return skills;
  },

  /** Says, for each provider, whether it reads a scope's shared folder itself or can be linked into. */
  async listCentralProviders(projectId?: string | null): Promise<CentralScopeProvider[]> {
    const context = resolveContext(providerSkillsService.resolveTarget(projectId));
    const store = path.resolve(context.storeRoot);
    return (await listScopeProviders(context)).map((entry) => ({
      provider: entry.provider,
      native: entry.native,
      linkable: !entry.native && entry.root !== null && path.resolve(entry.root) !== store,
    }));
  },

  /**
   * Writes skills into a shared folder and links them into the given providers
   * (default: every provider that needs a link there).
   */
  async addCentralSkills(
    input: ProviderSkillCreateInput,
    options: { providers?: LLMProvider[]; forceCopy?: boolean; projectId?: string | null } = {},
  ): Promise<{ skills: CentralSkill[]; results: CentralSkillApplyResult[] }> {
    const context = resolveContext(providerSkillsService.resolveTarget(options.projectId));
    // The shared folder is not any one provider's; Codex is only the name the records carry.
    const added = await installSkillEntries(
      'codex',
      { scope: context.target.scope === 'user' ? 'user' : 'project', rootDir: context.storeRoot, commandPrefix: '$' },
      input,
    );
    const names = added.map((skill) => path.basename(path.dirname(skill.sourcePath)));

    const results: CentralSkillApplyResult[] = [];
    for (const name of names) {
      results.push(...await providerSkillsCentralService.linkCentralSkill(
        name,
        options.providers,
        options.forceCopy,
        options.projectId,
      ));
    }

    const scopeProviders = await listScopeProviders(context);
    return { skills: await Promise.all(names.map((name) => describeCentralSkill(context, name, scopeProviders))), results };
  },

  /** Links a shared skill into providers (default: every provider that needs it). */
  async linkCentralSkill(
    directoryName: string,
    providers?: LLMProvider[],
    forceCopy = false,
    projectId?: string | null,
  ): Promise<CentralSkillApplyResult[]> {
    const context = resolveContext(providerSkillsService.resolveTarget(projectId));
    const centralDir = await requireCentralDir(context, directoryName);
    const name = path.basename(centralDir);
    const results: CentralSkillApplyResult[] = [];
    for (const target of await resolveProviders(context, providers)) {
      results.push(await resultFor(async () => {
        const entryPath = path.join(target.root, name);
        const current = await inspectEntry(context, name, target.provider, centralDir, entryPath);
        if (current.state === 'linked' || current.state === 'copy_in_sync') {
          return 'already_linked';
        }

        if (current.state === 'conflict' || current.state === 'copy_drifted') {
          throw failure('SKILL_LINK_CONFLICT', `${target.provider} already has a different "${name}" skill. Adopt or remove it first.`, 409);
        }

        if (current.state === 'broken' && await exists(entryPath)) {
          await removeOwnedEntry(context, name, target.provider, centralDir, entryPath);
        }

        const mode = await createEntry(context, centralDir, entryPath, forceCopy);
        skillCentralLinksDb.setLink(context.key, name, target.provider, mode);
        return mode === 'copy' ? 'copied' : 'linked';
      }, target.provider));
    }

    return results;
  },

  /** Removes the links (or recorded copies) the app made for a skill; entries it did not create are left alone. */
  async unlinkCentralSkill(
    directoryName: string,
    providers?: LLMProvider[],
    projectId?: string | null,
  ): Promise<CentralSkillApplyResult[]> {
    const context = resolveContext(providerSkillsService.resolveTarget(projectId));
    const centralDir = await requireCentralDir(context, directoryName);
    const name = path.basename(centralDir);
    const results: CentralSkillApplyResult[] = [];
    for (const target of await resolveProviders(context, providers)) {
      results.push(await resultFor(async () => {
        await removeOwnedEntry(context, name, target.provider, centralDir, path.join(target.root, name));
        return 'unlinked';
      }, target.provider));
    }

    return results;
  },

  /** Replaces recorded copies (and broken links) with the current shared content. */
  async resyncCentralSkill(
    directoryName: string,
    providers?: LLMProvider[],
    projectId?: string | null,
  ): Promise<CentralSkillApplyResult[]> {
    const context = resolveContext(providerSkillsService.resolveTarget(projectId));
    const centralDir = await requireCentralDir(context, directoryName);
    const name = path.basename(centralDir);
    const results: CentralSkillApplyResult[] = [];
    for (const target of await resolveProviders(context, providers)) {
      results.push(await resultFor(async () => {
        const entryPath = path.join(target.root, name);
        const current = await inspectEntry(context, name, target.provider, centralDir, entryPath);
        if (current.state === 'copy_in_sync' || current.state === 'linked') {
          return 'already_linked';
        }

        if (current.state !== 'copy_drifted' && current.state !== 'broken') {
          throw failure('SKILL_LINK_NOT_OWNED', `${target.provider} has no linked copy of "${name}" to re-apply.`, 409);
        }

        const record = skillCentralLinksDb.listLinks(context.key, name).find((link) => link.provider === target.provider);
        await removeOwnedEntry(context, name, target.provider, centralDir, entryPath);
        const mode = await createEntry(context, centralDir, entryPath, record?.mode === 'copy');
        skillCentralLinksDb.setLink(context.key, name, target.provider, mode);
        return mode === 'copy' ? 'copied' : 'linked';
      }, target.provider));
    }

    return results;
  },

  /**
   * Moves an existing provider skill folder into the shared folder and links it
   * back, so a skill that lives in one provider becomes shared. Refuses when the
   * shared folder already has a skill of that name.
   */
  async adoptProviderSkill(
    provider: LLMProvider,
    directoryName: string,
    projectId?: string | null,
  ): Promise<CentralSkillApplyResult> {
    const context = resolveContext(providerSkillsService.resolveTarget(projectId));
    const target = (await listLinkTargets(context)).find((candidate) => candidate.provider === provider);
    if (!target) {
      throw failure('SKILL_LINK_UNSUPPORTED', `${provider} does not need or support linked shared skills here.`, 400);
    }

    const name = assertSafeDirectoryName(directoryName);
    const source = path.join(target.root, name);
    const entry = await lstat(source).catch(() => null);
    if (!entry || !entry.isDirectory() || !await exists(path.join(source, 'SKILL.md'))) {
      throw failure('SKILL_ADOPT_SOURCE_INVALID', `${provider} has no skill folder named "${name}" to adopt.`, 404);
    }

    const centralDir = path.join(context.storeRoot, name);
    if (await exists(centralDir)) {
      throw failure('CENTRAL_SKILL_EXISTS', `The shared skills folder already has "${name}".`, 409);
    }

    await mkdir(context.storeRoot, { recursive: true });
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
      const mode = await createEntry(context, centralDir, source, false);
      skillCentralLinksDb.setLink(context.key, name, provider, mode);
      return mode === 'copy' ? 'copied' : 'linked';
    }, provider);
  },

  /** Unlinks a skill everywhere in its context, then deletes it from the shared folder. */
  async removeCentralSkill(
    directoryName: string,
    projectId?: string | null,
  ): Promise<{ removed: boolean; results: CentralSkillApplyResult[] }> {
    const context = resolveContext(providerSkillsService.resolveTarget(projectId));
    const centralDir = await requireCentralDir(context, directoryName);
    const name = path.basename(centralDir);
    const results = await providerSkillsCentralService.unlinkCentralSkill(name, undefined, projectId);
    // Entries we do not own are not our problem, but a failed unlink must not leave dangling links.
    if (results.some((result) => result.outcome === 'failed')) {
      return { removed: false, results };
    }

    await rm(centralDir, { recursive: true, force: true });
    return { removed: true, results };
  },
};
