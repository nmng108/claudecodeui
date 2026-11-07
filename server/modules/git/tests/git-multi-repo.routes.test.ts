import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import * as fsPromises from 'node:fs/promises';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import spawn from 'cross-spawn';

import { createGitRouter } from '@/modules/git/git.routes.js';

/** A folder that is not a repository but holds two, driven through the real router and real git. */
async function withWorkspace(run: (call: (route: string) => Promise<any>, root: string) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'git-multi-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' });

  for (const name of ['api', 'web']) {
    const repoPath = path.join(root, name);
    mkdirSync(repoPath);
    git(repoPath, 'init', '-b', name === 'api' ? 'develop' : 'main');
    git(repoPath, 'config', 'user.email', 't@example.com');
    git(repoPath, 'config', 'user.name', 't');
    writeFileSync(path.join(repoPath, 'file.txt'), 'one');
    git(repoPath, 'add', '.');
    git(repoPath, 'commit', '-m', 'init');
  }
  writeFileSync(path.join(root, 'web', 'changed.txt'), 'new');

  const unexpectedProvider = async (): Promise<never> => { throw new Error('unexpected provider call'); };
  const router = createGitRouter({
    fileSystem: fsPromises as unknown as Parameters<typeof createGitRouter>[0]['fileSystem'],
    spawnProcess: spawn as unknown as Parameters<typeof createGitRouter>[0]['spawnProcess'],
    resolveProjectPathById: () => root,
    queryClaude: unexpectedProvider,
    queryCursor: unexpectedProvider,
  });
  const app = express();
  app.use(express.json());
  app.use('/api/git', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/git`;

  try {
    await run(async (route) => (await fetch(`${base}${route}`)).json(), root);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

test('lists the repositories inside a project folder that is not a repository', async () => {
  await withWorkspace(async (call) => {
    const body = await call('/repositories?project=p1');
    assert.deepEqual(
      body.repositories.map((entry: { path: string; branch: string }) => [entry.path, entry.branch]),
      [['api', 'develop'], ['web', 'main']],
    );
    assert.equal(body.truncated, false);
  });
});

test('status without a repository reports the folder as not a repository', async () => {
  await withWorkspace(async (call) => {
    const body = await call('/status?project=p1');
    assert.equal(body.notGitRepository, true);
  });
});

test('status with a repository reports that repository only', async () => {
  await withWorkspace(async (call) => {
    const web = await call('/status?project=p1&repo=web');
    assert.equal(web.branch, 'main');
    assert.deepEqual(web.untracked, ['changed.txt']);

    const api = await call('/status?project=p1&repo=api');
    assert.equal(api.branch, 'develop');
    assert.deepEqual(api.untracked, []);
  });
});

test('a repository path outside the project is refused', async () => {
  await withWorkspace(async (call) => {
    for (const repo of ['..', '../api', encodeURIComponent(os.tmpdir())]) {
      const body = await call(`/status?project=p1&repo=${repo}`);
      assert.ok(body.error, `expected an error for repo=${repo}`);
      assert.equal(body.branch, undefined);
    }
  });
});

test('remote access reports a repository without a remote', async () => {
  await withWorkspace(async (call) => {
    const body = await call('/remote-access?project=p1&repo=web');
    assert.equal(body.state, 'no-remote');
  });
});
