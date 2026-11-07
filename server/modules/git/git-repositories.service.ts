/**
 * Repository discovery for projects that are a folder of several repositories.
 *
 * A project normally *is* a repository, but a workspace can also be a plain
 * directory whose children are repositories. The Source Control tab lists what
 * is found here and every git route accepts an optional `repo` (a path relative
 * to the project) to act on one of them.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';


export type GitRepositoryEntry = {
  /** POSIX-style path relative to the project directory. Empty for the project directory itself. */
  path: string;
  name: string;
  /** True when the entry is the project directory itself (the project is, or sits inside, a repository). */
  isProjectRoot: boolean;
  /** Current branch read from `.git/HEAD`; null for detached HEAD or when it cannot be read cheaply. */
  branch: string | null;
};

export type GitRepositoryDiscovery = {
  repositories: GitRepositoryEntry[];
  /** True when the scan stopped early because of the result or time limit. */
  truncated: boolean;
};

export type DiscoverRepositoriesOptions = {
  /** How many directory levels below the project directory are scanned. */
  maxDepth?: number;
  maxResults?: number;
  timeBudgetMs?: number;
  /** Tells whether the project directory itself is inside a git work tree. */
  isInsideWorkTree: (directory: string) => Promise<boolean>;
};

export const DEFAULT_REPOSITORY_SCAN_DEPTH = 3;
const DEFAULT_MAX_RESULTS = 200;
const DEFAULT_TIME_BUDGET_MS = 4000;

/**
 * Directories that are never worth descending into. They are large, hold
 * vendored copies of other projects, or are tool caches.
 */
const SKIPPED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'target',
  'out',
  'venv',
  '__pycache__',
  'bower_components',
]);

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

async function readBranch(repositoryDirectory: string): Promise<string | null> {
  try {
    const head = (await fs.readFile(path.join(repositoryDirectory, '.git', 'HEAD'), 'utf8')).trim();
    const match = /^ref: refs\/heads\/(.+)$/.exec(head);
    return match ? match[1] : null;
  } catch {
    // `.git` is a file (worktree or submodule) or unreadable.
    return null;
  }
}

async function hasGitEntry(directory: string): Promise<boolean> {
  try {
    await fs.stat(path.join(directory, '.git'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Lists the repositories inside a project directory.
 *
 * The scan is breadth-first, skips hidden directories, symlinks and the
 * well-known heavy folders, and does not descend into a repository it found
 * (its own subfolders belong to it). The project directory is listed first when
 * it is, or sits inside, a work tree.
 */
export async function discoverRepositories(
  projectPath: string,
  options: DiscoverRepositoriesOptions,
): Promise<GitRepositoryDiscovery> {
  const maxDepth = options.maxDepth ?? DEFAULT_REPOSITORY_SCAN_DEPTH;
  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  const deadline = Date.now() + (options.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS);

  const repositories: GitRepositoryEntry[] = [];
  let truncated = false;

  const rootIsRepository = await options.isInsideWorkTree(projectPath).catch(() => false);
  if (rootIsRepository) {
    repositories.push({
      path: '',
      name: path.basename(projectPath),
      isProjectRoot: true,
      branch: await readBranch(projectPath),
    });
  }

  // When the project sits inside a repository, its folders are part of that
  // repository, so only an explicit nested `.git` makes one a separate entry.
  let level: string[] = [projectPath];
  for (let depth = 0; depth < maxDepth && level.length > 0 && !truncated; depth += 1) {
    const next: string[] = [];

    for (const directory of level) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }

      let children;
      try {
        children = await fs.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      children.sort((a, b) => a.name.localeCompare(b.name));

      for (const child of children) {
        if (!child.isDirectory() || child.isSymbolicLink()) continue;
        if (child.name.startsWith('.') || SKIPPED_DIRECTORY_NAMES.has(child.name)) continue;

        const childPath = path.join(directory, child.name);
        if (await hasGitEntry(childPath)) {
          if (repositories.length >= maxResults) {
            truncated = true;
            break;
          }
          repositories.push({
            path: toPosixPath(path.relative(projectPath, childPath)),
            name: child.name,
            isProjectRoot: false,
            branch: await readBranch(childPath),
          });
          continue;
        }
        next.push(childPath);
      }

      if (truncated) break;
    }

    level = next;
  }

  return { repositories, truncated };
}
