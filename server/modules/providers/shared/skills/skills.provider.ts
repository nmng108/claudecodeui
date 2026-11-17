import os from 'node:os';
import path from 'node:path';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';

import type { IProviderSkills } from '@/shared/interfaces.js';
import type {
  LLMProvider,
  ProviderSkillCreateInput,
  ProviderSkillRemoveInput,
  ProviderSkill,
  ProviderSkillListOptions,
  ProviderSkillSource,
  SkillScopeTarget,
} from '@/shared/types.js';
import {
  findProviderSkillMarkdownFiles,
  readOptionalString,
  readProviderSkillMarkdownDefinitionFromContent,
  readProviderSkillMarkdownDefinition,
  AppError,
} from '@/shared/utils.js';

/**
 * Stands in for a workspace when only the user's folders are wanted. Using a
 * real folder (the home folder, say) would let a project source that happens to
 * be the same path as a user source hide it, because sources are de-duplicated
 * by path; a folder no real skill lives under cannot.
 */
const NO_WORKSPACE_PATH = path.join(os.homedir(), '.cloudcli-no-workspace');

const resolveWorkspacePath = (workspacePath?: string): string =>
  path.resolve(workspacePath ?? process.cwd());

const stripMarkdownExtension = (value: string): string => value.replace(/\.md$/i, '');

const normalizeSkillDirectoryName = (value: string): string => (
  value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[<>:"|?*\x00-\x1F]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+|\.+$/g, '')
    .replace(/^-+|-+$/g, '')
);

type PendingSkillInstall = {
  skillDirectoryPath: string;
  skillPath: string;
  content: string;
  supportingFiles: Array<{
    targetPath: string;
    content: string | Buffer;
  }>;
  skill: ProviderSkill;
};

const resolveSkillSupportingFilePath = (
  skillDirectoryPath: string,
  relativePath: string,
  entryIndex: number,
): string => {
  const normalizedRelativePath = relativePath.trim().replace(/\\/g, '/');
  const pathSegments = normalizedRelativePath.split('/');
  if (
    !normalizedRelativePath
    || path.isAbsolute(normalizedRelativePath)
    || pathSegments.some((segment) => !segment || segment === '.' || segment === '..')
    || normalizedRelativePath.toLowerCase() === 'skill.md'
  ) {
    throw new AppError(
      `Skill entry ${entryIndex + 1} includes an invalid supporting file path "${relativePath}".`,
      {
        code: 'PROVIDER_SKILL_FILE_PATH_INVALID',
        statusCode: 400,
      },
    );
  }

  const resolvedSkillDirectoryPath = path.resolve(skillDirectoryPath);
  const resolvedFilePath = path.resolve(resolvedSkillDirectoryPath, ...pathSegments);
  if (!resolvedFilePath.startsWith(`${resolvedSkillDirectoryPath}${path.sep}`)) {
    throw new AppError(
      `Skill entry ${entryIndex + 1} supporting files must stay inside the skill directory.`,
      {
        code: 'PROVIDER_SKILL_FILE_PATH_INVALID',
        statusCode: 400,
      },
    );
  }

  return resolvedFilePath;
};

/**
 * Used by SkillsProvider (a provider's own skills folder) and by the central skills
 * service (the shared `.agents/skills` store) to write skill entries below a source
 * root. Replaces each skill's whole folder so removed scripts do not linger, and
 * validates every path so nothing lands outside the skill's own directory.
 */
export async function installSkillEntries(
  provider: LLMProvider,
  source: ProviderSkillSource,
  input: ProviderSkillCreateInput,
): Promise<ProviderSkill[]> {
  if (!Array.isArray(input.entries) || input.entries.length === 0) {
    throw new AppError('At least one skill entry is required.', {
      code: 'PROVIDER_SKILLS_REQUIRED',
      statusCode: 400,
    });
  }

  const seenSkillPaths = new Set<string>();
  const pendingInstalls: PendingSkillInstall[] = [];

  for (const [index, entry] of input.entries.entries()) {
    const content = typeof entry.content === 'string' ? entry.content.trim() : '';
    if (!content) {
      throw new AppError(`Skill entry ${index + 1} must include markdown content.`, {
        code: 'PROVIDER_SKILL_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }

    const fileNameFallback = readOptionalString(entry.fileName);
    const requestedDirectoryName = readOptionalString(entry.directoryName);
    const fallbackSkillName = normalizeSkillDirectoryName(
      requestedDirectoryName
        ?? (fileNameFallback ? stripMarkdownExtension(fileNameFallback) : `skill-${index + 1}`),
    );
    const definition = readProviderSkillMarkdownDefinitionFromContent(content, fallbackSkillName);
    const resolvedDirectoryName = normalizeSkillDirectoryName(
      requestedDirectoryName ?? definition.name,
    );

    if (!resolvedDirectoryName) {
      throw new AppError(`Skill entry ${index + 1} must include a valid skill name.`, {
        code: 'PROVIDER_SKILL_NAME_REQUIRED',
        statusCode: 400,
      });
    }

    const skillDirectoryPath = path.join(source.rootDir, resolvedDirectoryName);
    const skillPath = path.join(skillDirectoryPath, 'SKILL.md');
    const normalizedSkillPath = path.resolve(skillPath);
    if (seenSkillPaths.has(normalizedSkillPath)) {
      throw new AppError(`Duplicate skill target "${resolvedDirectoryName}" in one request.`, {
        code: 'PROVIDER_SKILL_DUPLICATE_TARGET',
        statusCode: 400,
      });
    }

    seenSkillPaths.add(normalizedSkillPath);
    const supportingFiles = (entry.files ?? []).map((file) => ({
      targetPath: resolveSkillSupportingFilePath(skillDirectoryPath, file.relativePath, index),
      content: file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64')
        : file.content,
    }));
    const seenSupportingPaths = new Set<string>();
    for (const file of supportingFiles) {
      if (seenSupportingPaths.has(file.targetPath)) {
        throw new AppError(`Skill entry ${index + 1} includes a duplicate supporting file path.`, {
          code: 'PROVIDER_SKILL_DUPLICATE_FILE',
          statusCode: 400,
        });
      }
      seenSupportingPaths.add(file.targetPath);
    }

    const command = source.commandForSkill
      ? source.commandForSkill(definition.name)
      : `${source.commandPrefix ?? '/'}${definition.name}`;

    pendingInstalls.push({
      skillDirectoryPath,
      skillPath,
      content,
      supportingFiles,
      skill: {
        provider,
        name: definition.name,
        description: definition.description,
        command,
        scope: source.scope,
        sourcePath: skillPath,
        pluginName: source.pluginName,
        pluginId: source.pluginId,
      },
    });
  }

  for (const install of pendingInstalls) {
    // Replace the complete skill directory so removed scripts or assets do not remain stale.
    await rm(install.skillDirectoryPath, { recursive: true, force: true });
    await mkdir(install.skillDirectoryPath, { recursive: true });
    await writeFile(install.skillPath, `${install.content}\n`, 'utf8');
    for (const file of install.supportingFiles) {
      await mkdir(path.dirname(file.targetPath), { recursive: true });
      await writeFile(file.targetPath, file.content);
    }
  }

  return pendingInstalls.map((install) => install.skill);
}

/**
 * Used by SkillsProvider to delete one skill folder below a managed root. The
 * name is checked so it cannot point outside the root.
 */
async function removeSkillDirectory(
  provider: LLMProvider,
  rootDir: string,
  rawDirectoryName: string,
): Promise<{ removed: boolean; provider: LLMProvider; directoryName: string }> {
  const directoryName = normalizeSkillDirectoryName(rawDirectoryName);
  if (!directoryName) {
    throw new AppError('Skill directoryName is required.', {
      code: 'PROVIDER_SKILL_DIRECTORY_REQUIRED',
      statusCode: 400,
    });
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedSkillDirectoryPath = path.resolve(path.join(rootDir, directoryName));
  if (
    resolvedSkillDirectoryPath !== resolvedRoot
    && !resolvedSkillDirectoryPath.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new AppError('Skill directory must stay inside the managed skill root.', {
      code: 'PROVIDER_SKILL_DIRECTORY_INVALID',
      statusCode: 400,
    });
  }

  const removed = await stat(resolvedSkillDirectoryPath)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
  if (removed) {
    await rm(resolvedSkillDirectoryPath, { recursive: true, force: true });
  }

  return { removed, provider, directoryName };
}

/**
 * Shared skills provider for provider-specific skill source discovery.
 */
export abstract class SkillsProvider implements IProviderSkills {
  protected readonly provider: LLMProvider;

  protected constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async listSkills(options?: ProviderSkillListOptions): Promise<ProviderSkill[]> {
    const workspacePath = resolveWorkspacePath(options?.workspacePath);
    const sources = await this.getSkillSources(workspacePath);
    const skills: ProviderSkill[] = [];

    for (const source of sources) {
      const skillFiles = await findProviderSkillMarkdownFiles(source.rootDir, {
        recursive: source.recursive,
      });
      for (const skillPath of skillFiles) {
        try {
          const definition = await readProviderSkillMarkdownDefinition(skillPath);
          const command = source.commandForSkill
            ? source.commandForSkill(definition.name)
            : `${source.commandPrefix ?? '/'}${definition.name}`;

          skills.push({
            provider: this.provider,
            name: definition.name,
            description: definition.description,
            command,
            scope: source.scope,
            sourcePath: skillPath,
            pluginName: source.pluginName,
            pluginId: source.pluginId,
          });
        } catch {
          // A malformed or unreadable skill markdown file should not hide other valid skills.
        }
      }
    }

    return skills;
  }

  async addSkills(
    input: ProviderSkillCreateInput,
    target: SkillScopeTarget = { scope: 'user' },
  ): Promise<ProviderSkill[]> {
    return installSkillEntries(this.provider, await this.requireWritableSource(target), input);
  }

  async removeSkill(
    input: ProviderSkillRemoveInput,
    target: SkillScopeTarget = { scope: 'user' },
  ): Promise<{ removed: boolean; provider: LLMProvider; directoryName: string }> {
    const source = await this.requireWritableSource(target);
    return removeSkillDirectory(this.provider, source.rootDir, input.directoryName);
  }

  async getSkillsRoot(target: SkillScopeTarget): Promise<string | null> {
    return (await this.getWritableSource(target))?.rootDir ?? null;
  }

  async getReadableRoots(target: SkillScopeTarget): Promise<string[]> {
    if (target.scope === 'user') {
      // Whatever the stand-in workspace made the provider add is dropped again.
      return (await this.getSkillSources(NO_WORKSPACE_PATH))
        .map((source) => source.rootDir)
        .filter((rootDir) => !path.resolve(rootDir).startsWith(NO_WORKSPACE_PATH));
    }

    return (await this.getSkillSources(path.resolve(target.workspacePath)))
      .filter((source) => source.scope === 'project' || source.scope === 'repo')
      .map((source) => source.rootDir);
  }

  protected abstract getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]>;

  protected async getGlobalSkillSource(): Promise<ProviderSkillSource | null> {
    return null;
  }

  /** Folder skills added to one project are written to, or null when the provider has none. */
  protected async getProjectSkillSource(_workspacePath: string): Promise<ProviderSkillSource | null> {
    return null;
  }

  private async getWritableSource(target: SkillScopeTarget): Promise<ProviderSkillSource | null> {
    return target.scope === 'user'
      ? this.getGlobalSkillSource()
      : this.getProjectSkillSource(path.resolve(target.workspacePath));
  }

  private async requireWritableSource(target: SkillScopeTarget): Promise<ProviderSkillSource> {
    const source = await this.getWritableSource(target);
    if (!source) {
      throw new AppError(`${this.provider} does not support managed ${target.scope === 'user' ? 'global' : 'project'} skills.`, {
        code: 'PROVIDER_SKILLS_WRITE_UNSUPPORTED',
        statusCode: 400,
      });
    }

    return source;
  }
}
