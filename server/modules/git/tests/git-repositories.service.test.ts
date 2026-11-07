import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveRepositoryPath } from '@/shared/repository-path.js';

import { discoverRepositories } from '../git-repositories.service.js';

function makeWorkspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-repos-'));
  const dir = (...segments: string[]) => {
    const target = path.join(root, ...segments);
    mkdirSync(target, { recursive: true });
    return target;
  };
  /** A directory that looks like a repository: a `.git` folder with a HEAD file. */
  const repo = (relative: string, branch = 'main') => {
    const target = dir(relative, '.git');
    writeFileSync(path.join(target, 'HEAD'), `ref: refs/heads/${branch}\n`);
    return path.join(root, relative);
  };
  return { root, dir, repo, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const notInsideWorkTree = async () => false;

test('lists the repositories under a folder that is not a repository itself', async () => {
  const workspace = makeWorkspace();
  try {
    workspace.repo('api', 'develop');
    workspace.repo('web');
    workspace.repo('group/tools');
    workspace.dir('docs');
    workspace.repo('node_modules/dep');
    workspace.repo('.hidden/secret');

    const { repositories, truncated } = await discoverRepositories(workspace.root, {
      isInsideWorkTree: notInsideWorkTree,
    });

    assert.equal(truncated, false);
    assert.deepEqual(
      repositories.map((entry) => [entry.path, entry.branch, entry.isProjectRoot]),
      [
        ['api', 'develop', false],
        ['web', 'main', false],
        ['group/tools', 'main', false],
      ],
    );
  } finally {
    workspace.cleanup();
  }
});

test('lists the project folder first when it is itself a repository', async () => {
  const workspace = makeWorkspace();
  try {
    writeFileSync(path.join(workspace.dir('.git'), 'HEAD'), 'ref: refs/heads/trunk\n');
    workspace.repo('vendored-copy');

    const { repositories } = await discoverRepositories(workspace.root, {
      isInsideWorkTree: async () => true,
    });

    assert.deepEqual(
      repositories.map((entry) => [entry.path, entry.isProjectRoot, entry.branch]),
      [
        ['', true, 'trunk'],
        ['vendored-copy', false, 'main'],
      ],
    );
  } finally {
    workspace.cleanup();
  }
});

test('does not descend into a repository or past the depth limit', async () => {
  const workspace = makeWorkspace();
  try {
    workspace.repo('outer');
    workspace.repo('outer/inner');
    workspace.repo('a/b/c/too-deep');
    workspace.repo('a/b/shallow');

    const { repositories } = await discoverRepositories(workspace.root, {
      maxDepth: 3,
      isInsideWorkTree: notInsideWorkTree,
    });

    assert.deepEqual(repositories.map((entry) => entry.path), ['outer', 'a/b/shallow']);
  } finally {
    workspace.cleanup();
  }
});

test('stops at the result limit and says so', async () => {
  const workspace = makeWorkspace();
  try {
    for (const name of ['one', 'two', 'three']) workspace.repo(name);

    const { repositories, truncated } = await discoverRepositories(workspace.root, {
      maxResults: 2,
      isInsideWorkTree: notInsideWorkTree,
    });

    assert.equal(repositories.length, 2);
    assert.equal(truncated, true);
  } finally {
    workspace.cleanup();
  }
});

test('resolveRepositoryPath returns the project folder when no repository is requested', async () => {
  const workspace = makeWorkspace();
  try {
    for (const value of [undefined, null, '', '.', './']) {
      assert.equal(await resolveRepositoryPath(workspace.root, value), workspace.root);
    }
  } finally {
    workspace.cleanup();
  }
});

test('resolveRepositoryPath resolves a relative repository inside the project', async () => {
  const workspace = makeWorkspace();
  try {
    workspace.repo('group/tools');
    assert.equal(
      await resolveRepositoryPath(workspace.root, 'group/tools'),
      path.join(workspace.root, 'group', 'tools'),
    );
    assert.equal(
      await resolveRepositoryPath(workspace.root, 'group\\tools\\'),
      path.join(workspace.root, 'group', 'tools'),
    );
  } finally {
    workspace.cleanup();
  }
});

test('resolveRepositoryPath refuses paths that leave the project', async () => {
  const workspace = makeWorkspace();
  const outside = mkdtempSync(path.join(os.tmpdir(), 'git-outside-'));
  try {
    workspace.dir('inside');
    const rejected = ['..', '../x', 'inside/../../x', '/etc', 'C:\\Windows', 'a\0b'];
    for (const value of rejected) {
      await assert.rejects(resolveRepositoryPath(workspace.root, value), Error, value);
    }

    // A link inside the project that points outside it must not be followed.
    symlinkSync(outside, path.join(workspace.root, 'escape'), 'junction');
    await assert.rejects(resolveRepositoryPath(workspace.root, 'escape'));
  } finally {
    workspace.cleanup();
    rmSync(outside, { recursive: true, force: true });
  }
});

test('resolveRepositoryPath rejects missing paths and files', async () => {
  const workspace = makeWorkspace();
  try {
    writeFileSync(path.join(workspace.root, 'file.txt'), 'x');
    await assert.rejects(resolveRepositoryPath(workspace.root, 'missing'));
    await assert.rejects(resolveRepositoryPath(workspace.root, 'file.txt'));
  } finally {
    workspace.cleanup();
  }
});
