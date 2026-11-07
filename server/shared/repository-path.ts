/**
 * Confines a request-supplied repository path to its project directory.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { AppError } from '@/shared/utils.js';

/**
 * Resolves the directory git commands run in.
 *
 * Without `repo` the project directory is used unchanged. With it, the value
 * must be a relative path that stays inside the project directory, symlinks
 * included, so a request can never point git at an arbitrary location.
 */
export async function resolveRepositoryPath(projectPath: string, repo?: unknown): Promise<string> {
  if (repo === undefined || repo === null || repo === '') {
    return projectPath;
  }
  if (typeof repo !== 'string' || repo.includes('\0')) {
    throw new AppError('Invalid repository path', { code: 'INVALID_REPOSITORY', statusCode: 400 });
  }

  const relative = repo.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!relative || relative === '.') {
    return projectPath;
  }
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    throw new AppError('Repository path must be relative to the project', {
      code: 'INVALID_REPOSITORY',
      statusCode: 400,
    });
  }

  const candidate = path.resolve(projectPath, relative);
  const lexical = path.relative(projectPath, candidate);
  if (lexical === '' || lexical.startsWith('..') || path.isAbsolute(lexical)) {
    throw new AppError('Repository path escapes the project', {
      code: 'INVALID_REPOSITORY',
      statusCode: 400,
    });
  }

  let realProject: string;
  let realCandidate: string;
  try {
    [realProject, realCandidate] = await Promise.all([fs.realpath(projectPath), fs.realpath(candidate)]);
  } catch {
    throw new AppError('Repository not found', { code: 'REPOSITORY_NOT_FOUND', statusCode: 404 });
  }

  const real = path.relative(realProject, realCandidate);
  if (real === '' || real.startsWith('..') || path.isAbsolute(real)) {
    throw new AppError('Repository path escapes the project', {
      code: 'INVALID_REPOSITORY',
      statusCode: 400,
    });
  }

  const stats = await fs.stat(realCandidate);
  if (!stats.isDirectory()) {
    throw new AppError('Repository path is not a directory', {
      code: 'INVALID_REPOSITORY',
      statusCode: 400,
    });
  }

  return candidate;
}
