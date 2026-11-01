import path from 'node:path';

import ignore, { type Ignore } from 'ignore';

import type {
  FileTreeDirectoryEntry,
  FileTreeNode,
  FileTreeSearchResult,
  FileTreeServiceDependencies,
  FileTreeServices,
  FileTreeUploadedFile,
} from '@/shared/types.js';
import {
  AppError,
  FORBIDDEN_WORKSPACE_PATHS,
  normalizeProjectPath,
  resolvePathUnderRoots,
} from '@/shared/utils.js';

const HARD_EXCLUDED_DIRECTORY_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg',
]);

const IGNORED_DIRECTORY_NAMES = new Set([
  ...HARD_EXCLUDED_DIRECTORY_NAMES,
  'dist', 'build', '.next', '.nuxt', '.cache', '.parcel-cache',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.tox', 'venv', '.venv',
  'target', 'vendor',
  '.gradle', '.idea', 'coverage', '.nyc_output',
]);

const COMMON_WORKSPACE_DIRECTORY_NAMES = [
  'Desktop',
  'Documents',
  'Projects',
  'Development',
  'Dev',
  'Code',
  'workspace',
];

// File Tree lists one directory per request and the browser expands folders on
// demand, so there is no whole-project entry cap. These guards only bound a
// single request: one directory with an absurd number of children, and one
// search walking a very broad workspace.
const MAXIMUM_DIRECTORY_ENTRIES = 100_000;
const DEFAULT_SEARCH_RESULTS = 200;
const MAXIMUM_SEARCH_RESULTS = 1_000;
const SEARCH_COLLECTION_FACTOR = 5;
const MAXIMUM_SEARCH_VISITED_ENTRIES = 500_000;
const SEARCH_TIME_BUDGET_MS = 8_000;

type FileTreeEntryFilter = (entryPath: string, isDirectory: boolean) => boolean;

function includeEntryByHardExclusions(entryPath: string, isDirectory: boolean): boolean {
  return !isDirectory || !HARD_EXCLUDED_DIRECTORY_NAMES.has(path.basename(entryPath));
}

function includeEntryByFallbackDirectoryNames(entryPath: string, isDirectory: boolean): boolean {
  return includeEntryByHardExclusions(entryPath, isDirectory)
    && (!isDirectory || !IGNORED_DIRECTORY_NAMES.has(path.basename(entryPath)));
}

function createFileTreeError(message: string, statusCode: number, code: string): AppError {
  return new AppError(message, { statusCode, code });
}

function readErrorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : null;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function permissionBitsToRwx(permissionBits: number): string {
  const read = permissionBits & 4 ? 'r' : '-';
  const write = permissionBits & 2 ? 'w' : '-';
  const execute = permissionBits & 1 ? 'x' : '-';
  return read + write + execute;
}

function validateFilename(name: string): void {
  if (!name.trim()) {
    throw createFileTreeError('Filename cannot be empty', 400, 'INVALID_FILENAME');
  }

  if (/[<>:"/\\|?*\x00-\x1f]/.test(name)) {
    throw createFileTreeError('Filename contains invalid characters', 400, 'INVALID_FILENAME');
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    throw createFileTreeError('Filename is a reserved name', 400, 'INVALID_FILENAME');
  }

  if (/^\.+$/.test(name)) {
    throw createFileTreeError('Filename cannot be only dots', 400, 'INVALID_FILENAME');
  }
}

function resolvePathInsideProject(projectRoot: string, targetPath: string): string {
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(projectRoot, targetPath);
  const normalizedProjectRoot = path.resolve(projectRoot) + path.sep;

  if (!resolvedPath.startsWith(normalizedProjectRoot)) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

function expandWorkspacePath(workspaceRoot: string, inputPath: string): string {
  if (inputPath === '~') {
    return workspaceRoot;
  }
  if (inputPath.startsWith('~/') || inputPath.startsWith('~\\')) {
    return path.join(workspaceRoot, inputPath.slice(2));
  }
  return inputPath;
}

function createConcurrencyLimiter(maximumConcurrency: number) {
  let activeOperations = 0;
  const pendingOperations: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (activeOperations < maximumConcurrency) {
      activeOperations += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      pendingOperations.push(resolve);
    });
  }

  function release(): void {
    const nextOperation = pendingOperations.shift();
    if (nextOperation) {
      nextOperation();
      return;
    }

    activeOperations = Math.max(0, activeOperations - 1);
  }

  return { acquire, release };
}

function mapFileSystemError(
  error: unknown,
  messages: Partial<Record<string, { message: string; statusCode: number }>>,
): never {
  const errorCode = readErrorCode(error);
  const mappedError = errorCode ? messages[errorCode] : undefined;
  if (mappedError) {
    throw createFileTreeError(mappedError.message, mappedError.statusCode, errorCode ?? 'FILE_TREE_ERROR');
  }

  throw error;
}

type GitignoreRule = {
  /** Directory holding the `.gitignore`; its patterns are relative to this path. */
  baseDirectory: string;
  matcher: Ignore;
};

/**
 * Builds the visibility filter for one directory.
 *
 * Without `.gitignore` rules, or when the caller did not ask to respect them,
 * conventional generated directory names (`dist`, `build`, ...) are hidden
 * instead. `rules` run from the project root down, and a deeper file overrides
 * a shallower one, which matches how git layers nested `.gitignore` files.
 */
function createEntryFilter(rules: GitignoreRule[], respectGitignore: boolean): FileTreeEntryFilter {
  if (!respectGitignore || rules.length === 0) {
    return includeEntryByFallbackDirectoryNames;
  }

  return (entryPath, isDirectory) => {
    if (!includeEntryByHardExclusions(entryPath, isDirectory)) return false;

    let ignored = false;
    for (const rule of rules) {
      const relativePath = path.relative(rule.baseDirectory, entryPath).split(path.sep).join('/');
      if (!relativePath || relativePath.startsWith('..')) continue;

      const result = rule.matcher.test(isDirectory ? `${relativePath}/` : relativePath);
      if (result.ignored) {
        ignored = true;
      } else if (result.unignored) {
        ignored = false;
      }
    }
    return !ignored;
  };
}

function resolveDirectoryInsideProject(projectRoot: string, targetPath: string): string {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedPath = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(resolvedRoot, targetPath);

  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + path.sep)) {
    throw createFileTreeError('Path must be under project root', 403, 'PATH_OUTSIDE_PROJECT');
  }

  return resolvedPath;
}

function toProjectRelativePath(projectRoot: string, entryPath: string): string {
  return path.relative(projectRoot, entryPath).split(path.sep).join('/');
}

function sortTreeNodes(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === 'directory' ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

/**
 * Creates File Tree workflows for the module composition root and route tests.
 * Every filesystem, project, workspace, environment, and logging dependency is
 * required explicitly so this service has no machine-wide production defaults.
 */
export function createFileTreeService(dependencies: FileTreeServiceDependencies): FileTreeServices {
  const fileSystem = dependencies.fileSystem;
  const concurrencyLimit = Number.isFinite(dependencies.fileSystemConcurrency)
    && dependencies.fileSystemConcurrency > 0
    ? Math.floor(dependencies.fileSystemConcurrency)
    : 1;
  const { acquire, release } = createConcurrencyLimiter(concurrencyLimit);

  async function resolveProjectRoot(projectId: string): Promise<string> {
    const projectRoot = await dependencies.projects.getProjectPathById(projectId);
    if (!projectRoot) {
      throw createFileTreeError('Project not found', 404, 'PROJECT_NOT_FOUND');
    }
    return projectRoot;
  }

  async function readGitignoreRule(directoryPath: string): Promise<GitignoreRule | null> {
    try {
      const content = await fileSystem.readTextFile(path.join(directoryPath, '.gitignore'));
      return { baseDirectory: directoryPath, matcher: ignore().add(content) };
    } catch (error) {
      const errorCode = readErrorCode(error);
      if (
        errorCode !== 'ENOENT'
        && errorCode !== 'ENOTDIR'
        && errorCode !== 'EISDIR'
        && errorCode !== 'EACCES'
        && errorCode !== 'EPERM'
      ) {
        dependencies.logger.error(`Error reading .gitignore in "${directoryPath}"`, error);
      }
      return null;
    }
  }

  /** Every `.gitignore` from the project root down to `directoryPath`, shallowest first. */
  async function readGitignoreRulesAlongPath(
    projectRoot: string,
    directoryPath: string,
  ): Promise<GitignoreRule[]> {
    const relativePath = path.relative(projectRoot, directoryPath);
    const segments = relativePath ? relativePath.split(path.sep) : [];
    const rules: GitignoreRule[] = [];

    let currentDirectory = projectRoot;
    const rootRule = await readGitignoreRule(currentDirectory);
    if (rootRule) rules.push(rootRule);
    for (const segment of segments) {
      currentDirectory = path.join(currentDirectory, segment);
      const rule = await readGitignoreRule(currentDirectory);
      if (rule) rules.push(rule);
    }

    return rules;
  }

  /**
   * Streams one directory and keeps only the entries the tree will show.
   *
   * The stream is abandoned at `maximumEntries` visible entries, so a
   * pathologically large directory is never read into memory in full.
   */
  async function readVisibleEntries(
    directoryPath: string,
    includeEntry: FileTreeEntryFilter,
    maximumEntries: number,
  ): Promise<{ entries: FileTreeDirectoryEntry[]; truncated: boolean }> {
    const visibleEntries: FileTreeDirectoryEntry[] = [];

    await acquire();
    try {
      for await (const entry of fileSystem.openDirectory(directoryPath)) {
        if (!includeEntry(path.join(directoryPath, entry.name), entry.isDirectory())) {
          continue;
        }
        if (visibleEntries.length >= maximumEntries) {
          return { entries: visibleEntries, truncated: true };
        }
        visibleEntries.push(entry);
      }
    } catch (error) {
      const errorCode = readErrorCode(error);
      if (errorCode !== 'EACCES' && errorCode !== 'EPERM') {
        dependencies.logger.error(`Error reading directory "${directoryPath}"`, error);
      }
      return { entries: [], truncated: false };
    } finally {
      release();
    }

    return { entries: visibleEntries, truncated: false };
  }

  async function describeEntry(
    itemPath: string,
    name: string,
    isDirectory: boolean,
  ): Promise<FileTreeNode> {
    const item: FileTreeNode = {
      name,
      path: itemPath,
      type: isDirectory ? 'directory' : 'file',
      size: 0,
      modified: null,
      permissions: '000',
      permissionsRwx: '---------',
    };

    try {
      await acquire();
      try {
        const stats = await fileSystem.lstat(itemPath);
        const ownerPermissions = (stats.mode >> 6) & 7;
        const groupPermissions = (stats.mode >> 3) & 7;
        const otherPermissions = stats.mode & 7;

        item.size = stats.size;
        item.modified = stats.mtime.toISOString();
        item.permissions = `${ownerPermissions}${groupPermissions}${otherPermissions}`;
        item.permissionsRwx = permissionBitsToRwx(ownerPermissions)
          + permissionBitsToRwx(groupPermissions)
          + permissionBitsToRwx(otherPermissions);
        if (stats.isSymbolicLink()) {
          item.isSymlink = true;
        }
      } finally {
        release();
      }
    } catch {
      // Metadata failures should not hide an otherwise readable tree entry.
    }

    return item;
  }

  function rankSearchMatch(name: string, relativePath: string, query: string): number {
    if (!query) return 0;
    const lowerName = name.toLowerCase();
    if (lowerName === query) return 0;
    if (lowerName.startsWith(query)) return 1;
    if (lowerName.includes(query)) return 2;
    return relativePath.toLowerCase().includes(query) ? 3 : 4;
  }

  /**
   * Resolves a directory the browser may list.
   *
   * The read-only roots (the system temp directory and the Claude projects
   * directory, see `READ_ONLY_ROOTS` in shared/utils) are browsable but never
   * writable, so they are checked before the workspace policy rejects them.
   * `createWorkspaceFolder` deliberately does not do this, which is what keeps
   * them read-only.
   */
  async function resolveBrowsablePath(targetPath: string): Promise<string> {
    const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
    if (readOnlyPath) {
      return readOnlyPath;
    }

    const validation = await dependencies.workspace.validatePath(targetPath);
    if (!validation.valid) {
      throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
    }

    return validation.resolvedPath || targetPath;
  }

  /**
   * Resolves a path the viewer is allowed to read.
   *
   * A file reference in a transcript is normally inside the project, but a
   * background command's log lives in the system temp directory and a
   * background agent's output file is a link from there into the Claude
   * projects directory, and the transcript quotes those paths verbatim. Those
   * resolve through the read-only root policy instead of the project root.
   *
   * The agent may also point at a file in another folder of the workspace, the
   * same tree `browseWorkspace` lists, so anything under the workspace root is
   * readable too. Symlinks are resolved before that comparison. The writing
   * endpoints keep using `resolvePathInsideProject` alone, so nothing outside
   * the project can be changed.
   */
  async function resolveReadablePath(projectRoot: string, targetPath: string): Promise<string> {
    if (path.isAbsolute(targetPath)) {
      const readOnlyPath = await dependencies.workspace.resolveReadOnlyRootPath(targetPath);
      if (readOnlyPath) {
        return readOnlyPath;
      }

      const workspacePath = await resolvePathUnderRoots(targetPath, [dependencies.workspace.rootPath]);
      if (workspacePath) {
        return workspacePath;
      }
    }

    return resolvePathInsideProject(projectRoot, targetPath);
  }

  async function cleanupTemporaryFiles(files: FileTreeUploadedFile[]): Promise<void> {
    await Promise.all(files.map(async (file) => {
      try {
        await fileSystem.unlink(file.temporaryPath);
      } catch {
        // A successfully moved file no longer has a temporary source to clean.
      }
    }));
  }

  return {
    async browseWorkspace(inputPath) {
      const requestedPath = inputPath
        ? expandWorkspacePath(dependencies.workspace.rootPath, inputPath)
        : dependencies.workspace.rootPath;
      const targetPath = path.resolve(requestedPath);
      const resolvedPath = await resolveBrowsablePath(targetPath);

      try {
        await fileSystem.access(resolvedPath);
        const stats = await fileSystem.stat(resolvedPath);
        if (!stats.isDirectory()) {
          throw createFileTreeError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw createFileTreeError('Directory not accessible', 404, 'DIRECTORY_NOT_ACCESSIBLE');
      }

      const { entries } = await readVisibleEntries(
        resolvedPath,
        includeEntryByFallbackDirectoryNames,
        MAXIMUM_DIRECTORY_ENTRIES,
      );
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ path: path.join(resolvedPath, entry.name), name: entry.name, type: 'directory' as const }))
        .sort((left, right) => {
          const leftHidden = left.name.startsWith('.');
          const rightHidden = right.name.startsWith('.');
          if (leftHidden && !rightHidden) return 1;
          if (!leftHidden && rightHidden) return -1;
          return left.name.localeCompare(right.name);
        });

      let resolvedWorkspaceRoot = dependencies.workspace.rootPath;
      try {
        resolvedWorkspaceRoot = await fileSystem.realpath(dependencies.workspace.rootPath);
      } catch {
        // The configured workspace root remains the comparison fallback.
      }

      const suggestions = resolvedPath === resolvedWorkspaceRoot
        ? [
            ...directories.filter((directory) => COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
            ...directories.filter((directory) => !COMMON_WORKSPACE_DIRECTORY_NAMES.includes(directory.name)),
          ]
        : directories;

      return { path: resolvedPath, suggestions };
    },

    async createWorkspaceFolder(folderPath) {
      const expandedPath = expandWorkspacePath(dependencies.workspace.rootPath, folderPath);
      const resolvedInput = path.resolve(expandedPath);
      const validation = await dependencies.workspace.validatePath(resolvedInput);
      if (!validation.valid) {
        throw createFileTreeError(validation.error ?? 'Path is outside the workspace root', 403, 'INVALID_WORKSPACE_PATH');
      }

      const targetPath = validation.resolvedPath || resolvedInput;
      try {
        await fileSystem.access(path.dirname(targetPath));
      } catch {
        throw createFileTreeError('Parent directory does not exist', 404, 'PARENT_DIRECTORY_NOT_FOUND');
      }

      try {
        await fileSystem.access(targetPath);
        throw createFileTreeError('Folder already exists', 409, 'FOLDER_ALREADY_EXISTS');
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.makeDirectory(targetPath, false);
      } catch (error) {
        mapFileSystemError(error, {
          EEXIST: { message: 'Folder already exists', statusCode: 409 },
        });
      }

      return { success: true, path: targetPath };
    },

    async readTextFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      try {
        const content = await fileSystem.readTextFile(resolvedPath);
        return { content, path: resolvedPath };
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
          EISDIR: { message: 'Path is a directory, not a file', statusCode: 400 },
        });
      }
    },

    async openFile(projectId, filePath) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = await resolveReadablePath(projectRoot, filePath);
      try {
        await fileSystem.access(resolvedPath);
      } catch {
        throw createFileTreeError('File not found', 404, 'FILE_NOT_FOUND');
      }

      return {
        contentType: dependencies.resolveMimeType(resolvedPath),
        stream: fileSystem.createReadStream(resolvedPath),
      };
    },

    async saveTextFile(projectId, filePath, content) {
      const projectRoot = await resolveProjectRoot(projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, filePath);
      try {
        await fileSystem.writeTextFile(resolvedPath, content);
      } catch (error) {
        mapFileSystemError(error, {
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EACCES: { message: 'Permission denied', statusCode: 403 },
        });
      }

      return { success: true, path: resolvedPath, message: 'File saved successfully' };
    },

    async listDirectory(projectId, options) {
      const projectRoot = await resolveProjectRoot(projectId);
      try {
        await fileSystem.access(projectRoot);
      } catch {
        throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
      }

      const directoryPath = options?.directoryPath
        ? resolveDirectoryInsideProject(projectRoot, options.directoryPath)
        : path.resolve(projectRoot);

      if (directoryPath !== path.resolve(projectRoot)) {
        let isDirectory = false;
        try {
          isDirectory = (await fileSystem.stat(directoryPath)).isDirectory();
        } catch {
          throw createFileTreeError('Directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
        }
        if (!isDirectory) {
          throw createFileTreeError('Path is not a directory', 400, 'FILE_TREE_NOT_A_DIRECTORY');
        }
      }

      const respectGitignore = options?.respectGitignore === true;
      const rules = respectGitignore
        ? await readGitignoreRulesAlongPath(projectRoot, directoryPath)
        : [];
      const { entries, truncated } = await readVisibleEntries(
        directoryPath,
        createEntryFilter(rules, respectGitignore),
        MAXIMUM_DIRECTORY_ENTRIES,
      );

      const nodes = await Promise.all(entries.map((entry) => describeEntry(
        path.join(directoryPath, entry.name),
        entry.name,
        entry.isDirectory(),
      )));

      return { path: directoryPath, entries: sortTreeNodes(nodes), truncated };
    },

    async searchProjectFiles(projectId, options) {
      const projectRoot = await resolveProjectRoot(projectId);
      try {
        await fileSystem.access(projectRoot);
      } catch {
        throw createFileTreeError(`Project path not found: ${projectRoot}`, 404, 'PROJECT_PATH_NOT_FOUND');
      }

      const query = options.query.trim().toLowerCase();
      const limit = Math.min(
        Math.max(Math.floor(options.limit ?? DEFAULT_SEARCH_RESULTS), 1),
        MAXIMUM_SEARCH_RESULTS,
      );
      const wantedType = options.type ?? 'any';
      const respectGitignore = options.respectGitignore === true;
      // Matches are ranked after collection, so gather beyond `limit` first or
      // a name match deeper in the tree would lose to shallow path-only hits.
      const collectionCap = limit * SEARCH_COLLECTION_FACTOR;
      const startedAt = Date.now();

      type Match = { entryPath: string; name: string; relativePath: string; isDirectory: boolean; depth: number };
      const matches: Match[] = [];
      const queue: Array<{ directoryPath: string; inheritedRules: GitignoreRule[]; depth: number }> = [
        { directoryPath: path.resolve(projectRoot), inheritedRules: [], depth: 0 },
      ];
      let visitedEntries = 0;
      let truncated = false;

      walk:
      for (let head = 0; head < queue.length; head += 1) {
        const { directoryPath, inheritedRules, depth } = queue[head];
        const ownRule = respectGitignore ? await readGitignoreRule(directoryPath) : null;
        const rules = ownRule ? [...inheritedRules, ownRule] : inheritedRules;
        const { entries } = await readVisibleEntries(
          directoryPath,
          createEntryFilter(rules, respectGitignore),
          MAXIMUM_DIRECTORY_ENTRIES,
        );

        for (const entry of entries) {
          visitedEntries += 1;
          if (
            visitedEntries > MAXIMUM_SEARCH_VISITED_ENTRIES
            || Date.now() - startedAt > SEARCH_TIME_BUDGET_MS
          ) {
            truncated = true;
            break walk;
          }

          const isDirectory = entry.isDirectory();
          const entryPath = path.join(directoryPath, entry.name);
          const relativePath = toProjectRelativePath(projectRoot, entryPath);
          const typeMatches = wantedType === 'any' || (wantedType === 'directory') === isDirectory;

          if (typeMatches && (!query || relativePath.toLowerCase().includes(query))) {
            matches.push({ entryPath, name: entry.name, relativePath, isDirectory, depth });
            if (matches.length >= collectionCap) {
              truncated = true;
              break walk;
            }
          }

          if (isDirectory && !FORBIDDEN_WORKSPACE_PATHS.includes(normalizeProjectPath(entryPath))) {
            queue.push({ directoryPath: entryPath, inheritedRules: rules, depth: depth + 1 });
          }
        }
      }

      if (matches.length > limit) {
        truncated = true;
      }

      const ranked = matches
        .map((match) => ({ match, rank: rankSearchMatch(match.name, match.relativePath, query) }))
        .sort((left, right) => (
          left.rank - right.rank
          || left.match.depth - right.match.depth
          || left.match.relativePath.localeCompare(right.match.relativePath)
        ))
        .slice(0, limit);

      const results = await Promise.all(ranked.map(async ({ match }): Promise<FileTreeSearchResult> => ({
        ...(await describeEntry(match.entryPath, match.name, match.isDirectory)),
        relativePath: match.relativePath,
      })));

      return { results, truncated };
    },

    async createEntry(input) {
      validateFilename(input.name);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const targetPath = input.parentPath
        ? path.join(input.parentPath, input.name)
        : input.name;
      const resolvedPath = resolvePathInsideProject(projectRoot, targetPath);

      try {
        await fileSystem.access(resolvedPath);
        throw createFileTreeError(
          `${input.type === 'file' ? 'File' : 'Directory'} already exists`,
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        if (input.type === 'directory') {
          await fileSystem.makeDirectory(resolvedPath, false);
        } else {
          const parentDirectory = path.dirname(resolvedPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }
          await fileSystem.writeTextFile(resolvedPath, '');
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'Parent directory not found', statusCode: 404 },
        });
      }

      return {
        success: true,
        path: resolvedPath,
        name: input.name,
        type: input.type,
        message: `${input.type === 'file' ? 'File' : 'Directory'} created successfully`,
      };
    },

    async renameEntry(input) {
      validateFilename(input.newName);
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedOldPath = resolvePathInsideProject(projectRoot, input.oldPath);

      try {
        await fileSystem.access(resolvedOldPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      const resolvedNewPath = path.join(path.dirname(resolvedOldPath), input.newName);
      resolvePathInsideProject(projectRoot, resolvedNewPath);
      try {
        await fileSystem.access(resolvedNewPath);
        throw createFileTreeError(
          'A file or directory with this name already exists',
          409,
          'FILE_TREE_ENTRY_EXISTS',
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
      }

      try {
        await fileSystem.rename(resolvedOldPath, resolvedNewPath);
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          EXDEV: { message: 'Cannot move across different filesystems', statusCode: 400 },
        });
      }

      return {
        success: true,
        oldPath: resolvedOldPath,
        newPath: resolvedNewPath,
        newName: input.newName,
        message: 'Renamed successfully',
      };
    },

    async deleteEntry(input) {
      const projectRoot = await resolveProjectRoot(input.projectId);
      const resolvedPath = resolvePathInsideProject(projectRoot, input.targetPath);
      let stats;
      try {
        stats = await fileSystem.stat(resolvedPath);
      } catch {
        throw createFileTreeError('File or directory not found', 404, 'FILE_TREE_ENTRY_NOT_FOUND');
      }

      if (resolvedPath === path.resolve(projectRoot)) {
        throw createFileTreeError('Cannot delete project root directory', 403, 'PROJECT_ROOT_DELETE_FORBIDDEN');
      }

      try {
        if (stats.isDirectory()) {
          await fileSystem.removeDirectory(resolvedPath);
        } else {
          await fileSystem.unlink(resolvedPath);
        }
      } catch (error) {
        mapFileSystemError(error, {
          EACCES: { message: 'Permission denied', statusCode: 403 },
          ENOENT: { message: 'File or directory not found', statusCode: 404 },
          ENOTEMPTY: { message: 'Directory is not empty', statusCode: 400 },
        });
      }

      const entryType = stats.isDirectory() ? 'directory' as const : 'file' as const;
      return {
        success: true,
        path: resolvedPath,
        type: entryType,
        message: 'Deleted successfully',
      };
    },

    async storeUploadedFiles(input) {
      if (input.files.length === 0) {
        throw createFileTreeError('No files provided', 400, 'UPLOAD_FILES_REQUIRED');
      }

      try {
        const projectRoot = await resolveProjectRoot(input.projectId);
        const resolvedTargetDirectory = !input.targetPath
          || input.targetPath === '.'
          || input.targetPath === './'
          ? path.resolve(projectRoot)
          : resolvePathInsideProject(projectRoot, input.targetPath);

        try {
          await fileSystem.access(resolvedTargetDirectory);
        } catch {
          await fileSystem.makeDirectory(resolvedTargetDirectory, true);
        }

        const uploadedFiles: Array<{ name: string; path: string; size: number; mimeType: string }> = [];
        for (let fileIndex = 0; fileIndex < input.files.length; fileIndex += 1) {
          const file = input.files[fileIndex];
          const fileName = input.relativePaths[fileIndex] || file.originalName;
          const destinationPath = path.join(resolvedTargetDirectory, fileName);

          try {
            resolvePathInsideProject(projectRoot, destinationPath);
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 403) {
              await cleanupTemporaryFiles([file]);
              continue;
            }
            throw error;
          }

          const parentDirectory = path.dirname(destinationPath);
          try {
            await fileSystem.access(parentDirectory);
          } catch {
            await fileSystem.makeDirectory(parentDirectory, true);
          }

          await fileSystem.copyFile(file.temporaryPath, destinationPath);
          await fileSystem.unlink(file.temporaryPath);
          uploadedFiles.push({
            name: fileName,
            path: destinationPath,
            size: file.size,
            mimeType: file.mimeType,
          });
        }

        return {
          success: true,
          files: uploadedFiles,
          uploadedCount: uploadedFiles.length,
          requestedFileCount: input.requestedFileCount,
          targetPath: resolvedTargetDirectory,
          message: `Uploaded ${uploadedFiles.length} ${uploadedFiles.length === 1 ? 'file' : 'files'} successfully`,
        };
      } catch (error) {
        await cleanupTemporaryFiles(input.files);
        if (readErrorCode(error) === 'EACCES') {
          throw createFileTreeError('Permission denied', 403, 'EACCES');
        }
        if (error instanceof AppError) throw error;
        dependencies.logger.error(`Error uploading files: ${readErrorMessage(error)}`, error);
        throw error;
      }
    },
  };
}
