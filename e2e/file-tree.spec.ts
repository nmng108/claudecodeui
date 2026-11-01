import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { authHeaders, authenticate, openApp, SERVER_URL } from './helpers';

/**
 * File tree end to end, on a workspace shaped like a real multi-repo checkout:
 * several repositories next to a `.kiro/` folder holding thousands of generated
 * files. The tree used to refuse any project over 10,000 visible entries; it now
 * lists one folder per request and searches on the server.
 */
const BIG_WORKSPACE = path.resolve('.e2e-run', 'home', 'big-workspace');
const GENERATED_FILES = 12_000;

const write = (relativePath: string, content = '') => {
  const target = path.join(BIG_WORKSPACE, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

test.describe.serial('File tree', () => {
  let token = '';
  let projectId = '';

  test.beforeAll(async ({ request }) => {
    token = await authenticate(request);

    // More files than the old whole-project cap allowed, spread over folders.
    for (let index = 0; index < GENERATED_FILES; index += 1) {
      write(path.join('.kiro', 'generated', `batch-${index % 12}`, `doc-${index}.md`));
    }
    write(path.join('repo-a', '.gitignore'), 'build-output/\n');
    write(path.join('repo-a', 'build-output', 'ignored-needle.ts'));
    write(path.join('repo-a', 'src', 'needle-target.ts'));
    write(path.join('repo-b', 'README.md'));
    write(path.join('repo-b', 'build-output', 'visible-needle.ts'));

    const response = await request.post(`${SERVER_URL}/api/projects/create-project`, {
      headers: authHeaders(token),
      data: { path: BIG_WORKSPACE },
    });
    expect(response.ok(), `create-project failed: ${await response.text()}`).toBeTruthy();
    const body = await response.json();
    projectId = (body.project?.projectId ?? body.projectId) as string;
    expect(projectId).toBeTruthy();
  });

  // Other specs expect the sandbox to hold a single project (the app only
  // auto-selects when there is one), so this one is removed afterwards.
  test.afterAll(async ({ request }) => {
    if (projectId) {
      await request.delete(`${SERVER_URL}/api/projects/${projectId}?force=true`, { headers: authHeaders(token) });
    }
  });

  test('a project with far more than 10,000 files lists its root', async ({ request }) => {
    const response = await request.get(`${SERVER_URL}/api/file-tree/projects/${projectId}/files`, {
      headers: authHeaders(token),
    });

    expect(response.status()).toBe(200);
    const listing = await response.json();
    expect(listing.entries.map((entry: { name: string }) => entry.name)).toEqual(['.kiro', 'repo-a', 'repo-b']);
    expect(listing.truncated).toBe(false);
  });

  test('a folder lists only its own level and nested gitignore files apply per repository', async ({ request }) => {
    const list = async (directory: string) => {
      const response = await request.get(
        `${SERVER_URL}/api/file-tree/projects/${projectId}/files?respectGitignore=true&path=${encodeURIComponent(directory)}`,
        { headers: authHeaders(token) },
      );
      expect(response.status()).toBe(200);
      return (await response.json()).entries.map((entry: { name: string }) => entry.name) as string[];
    };

    expect((await list(path.join(BIG_WORKSPACE, '.kiro', 'generated', 'batch-0'))).length).toBe(GENERATED_FILES / 12);
    // repo-a's own .gitignore hides build-output; repo-b has none, so its folder stays.
    expect(await list(path.join(BIG_WORKSPACE, 'repo-a'))).toEqual(['src', '.gitignore']);
    expect(await list(path.join(BIG_WORKSPACE, 'repo-b'))).toContain('build-output');
  });

  test('a path outside the project is refused', async ({ request }) => {
    const response = await request.get(
      `${SERVER_URL}/api/file-tree/projects/${projectId}/files?path=${encodeURIComponent(path.resolve('.e2e-run'))}`,
      { headers: authHeaders(token) },
    );
    expect(response.status()).toBe(403);
  });

  test('server search finds files anywhere in the workspace and honors nested gitignore', async ({ request }) => {
    const search = async (query: string, respectGitignore: boolean) => {
      const response = await request.get(
        `${SERVER_URL}/api/file-tree/projects/${projectId}/files/search?q=${query}&type=file&respectGitignore=${respectGitignore}`,
        { headers: authHeaders(token) },
      );
      expect(response.status()).toBe(200);
      return (await response.json()) as { results: Array<{ relativePath: string }>; truncated: boolean };
    };

    const respecting = await search('needle', true);
    expect(respecting.results.map((result) => result.relativePath).sort()).toEqual([
      'repo-a/src/needle-target.ts',
      'repo-b/build-output/visible-needle.ts',
    ]);

    const everything = await search('needle', false);
    expect(everything.results).toHaveLength(3);

    const deep = await search('doc-11999', true);
    expect(deep.results.map((result) => result.relativePath)).toEqual([
      '.kiro/generated/batch-11/doc-11999.md',
    ]);
  });

  test('the Files tab shows the workspace, opens a folder on click and searches', async ({ page }) => {
    const { errors } = await openApp(page, token);
    await page.getByText('big-workspace', { exact: true }).first().click();
    await page.getByText('Files', { exact: true }).first().click();

    await expect(page.getByText('Unable to load files')).toHaveCount(0);
    await expect(page.getByText('repo-a', { exact: true })).toBeVisible();
    await expect(page.getByText('.kiro', { exact: true })).toBeVisible();
    await expect(page.getByText('needle-target.ts')).toHaveCount(0);

    await page.getByText('repo-a', { exact: true }).click();
    await expect(page.getByText('src', { exact: true })).toBeVisible();

    await page.getByPlaceholder('Search files and folders...').fill('needle-target');
    await expect(page.getByText('needle-target.ts')).toBeVisible();
    await expect(page.getByText('repo-b', { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
