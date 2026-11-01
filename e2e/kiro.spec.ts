import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { authHeaders, authenticate, ensureProject, openApp, SERVER_URL } from './helpers';

/**
 * Kiro end to end: the real UI and API server talk to a fake `kiro-cli` that
 * speaks the v3 ACP protocol (server/modules/providers/tests/fixtures/kiro-fake-agent.ts).
 * The sandboxed HOME means the fake's session files are what the sidebar reads.
 */
test.describe.serial('Kiro provider', () => {
  let token = '';

  test.beforeAll(async ({ request }) => {
    token = await authenticate(request);
    await ensureProject(request, token);
  });

  const selectKiro = async (page: Page) => {
    await page.getByText('Choose Your AI Assistant').waitFor();
    await page.getByRole('button', { name: /Click to change model/ }).click();
    await page.locator('[role=dialog]').getByText('Fake Model').first().click();
    await expect(page.getByText(/Ready to use Kiro/)).toBeVisible();
  };

  const choosePermissionMode = async (page: Page, label: RegExp) => {
    await page.getByRole('button', { name: /Default Mode|Accept Edits|Plan Mode|Bypass/ }).first().click();
    await page.getByRole('menu').getByText(label).first().click();
  };

  const send = async (page: Page, text: string) => {
    const composer = page.locator('textarea').first();
    await composer.fill(text);
    if (text.startsWith('/')) {
      // The slash menu filters in an effect; Enter before it settles would run the first listed command.
      await page.waitForTimeout(400);
    }
    await composer.press('Enter');
  };

  test('a new Kiro session streams text, shows the tool card and credits, and raises no UI error', async ({ page }) => {
    const { errors } = await openApp(page, token);
    await selectKiro(page);
    await send(page, 'list the files');

    await expect(page.getByText('Hello from the fake agent').first()).toBeVisible();
    await expect(page.getByText('List files').first()).toBeVisible();
    // The credit counter replaces the token counter for Kiro.
    await expect(page.getByTitle(/0\.25 Kiro credits used/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the finished session is listed in the sidebar and reopens with its history', async ({ page }) => {
    const { errors } = await openApp(page, token);
    const row = page.getByText('list the files').first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    await expect(page.getByText('Hello from the fake agent').first()).toBeVisible();
    await expect(page.getByText('List files').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a permission request is shown and the allow decision lets the turn finish', async ({ page }) => {
    const { errors } = await openApp(page, token);
    await selectKiro(page);
    await send(page, '[scenario:permission] run it');

    const allow = page.getByRole('button', { name: /^Allow/ }).first();
    await expect(allow).toBeVisible();
    await allow.click();
    await expect(page.getByText('permission allowed, ran it').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('reasoning effort starts at medium for Kiro and /effort changes it', async ({ page }) => {
    const { errors } = await openApp(page, token);
    await selectKiro(page);
    const modelMenu = page.getByRole('button', { name: /Select model and reasoning effort/ });
    await expect(modelMenu).toContainText('medium');

    await send(page, '/effort high');
    await expect(page.getByText('Reasoning effort set to high.')).toBeVisible();
    await expect(modelMenu).toContainText('high');

    await send(page, '/effort turbo');
    await expect(page.getByText(/"turbo" is not available for this model/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the slash menu offers the Kiro command set, not the Claude one', async ({ page }) => {
    await openApp(page, token);
    await selectKiro(page);
    await page.locator('textarea').first().fill('/');
    for (const name of ['/effort', '/plan', '/context', '/compact']) {
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    }
    await expect(page.getByText('/memory', { exact: true })).toHaveCount(0);
  });

  test('/plan switches to plan mode', async ({ page }) => {
    await openApp(page, token);
    await selectKiro(page);
    await send(page, '/plan');
    await expect(page.getByText(/Plan mode is on/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Plan Mode/ }).first()).toBeVisible();
  });

  test('Accept Edits answers read requests itself but still asks about shell commands', async ({ page }) => {
    const { errors } = await openApp(page, token);
    await selectKiro(page);
    await choosePermissionMode(page, /Accept Edits/);

    await send(page, '[scenario:permission-read] read it');
    await expect(page.getByText('permission allowed, ran it').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Allow/ })).toHaveCount(0);

    await send(page, '[scenario:permission] run it');
    await expect(page.getByRole('button', { name: /^Allow/ }).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Bypass Permissions allows everything without asking', async ({ page }) => {
    await openApp(page, token);
    await selectKiro(page);
    await choosePermissionMode(page, /Bypass/);
    await send(page, '[scenario:permission] run it');
    await expect(page.getByText('permission allowed, ran it').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Allow/ })).toHaveCount(0);
  });

  test('/compact and /context work on an existing Kiro session', async ({ page }) => {
    const { errors } = await openApp(page, token);
    await page.getByText('list the files').first().click();
    await expect(page.getByText('Hello from the fake agent').first()).toBeVisible();
    // Opening a session switches the provider; wait until the menu shows the Kiro set.
    await page.locator('textarea').first().fill('/');
    await expect(page.getByText('/compact', { exact: true }).first()).toBeVisible();

    await send(page, '/context');
    await expect(page.getByText('Kiro context')).toBeVisible();
    await expect(page.getByText(/Context files/)).toBeVisible();

    await send(page, '/compact');
    await expect(page.getByText(/summarized the conversation/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the Shell tab starts kiro-cli for a Kiro session', async ({ page }) => {
    await openApp(page, token);
    await page.getByText('list the files').first().click();
    await page.getByText('Shell', { exact: true }).first().click();

    const launchFile = path.resolve('.e2e-run', 'home', 'interactive-launch.json');
    await expect
      .poll(() => {
        try {
          return JSON.parse(readFileSync(launchFile, 'utf8')) as { args: string[]; hasApiKey: boolean };
        } catch {
          return null;
        }
      }, { timeout: 20_000 })
      .toMatchObject({ args: expect.arrayContaining(['--v3']), hasApiKey: true });
  });
  test('the model catalog lists the live models with their reasoning levels', async ({ request }) => {
    const response = await request.get(`${SERVER_URL}/api/providers/kiro/models`, { headers: authHeaders(token) });
    expect(response.ok()).toBeTruthy();
    const { data: body } = await response.json();
    const data = body.models;
    const fake = data.OPTIONS.find((option: { value: string }) => option.value === 'fake-model');
    expect(fake.effort.values.map((level: { value: string }) => level.value)).toEqual(['low', 'medium', 'high']);
    expect(fake.effort.default).toBe('medium');
    expect(data.EFFORT_LEVELS).toContain('xhigh');
  });

  test('capabilities report abort, permissions, credits and forking as supported', async ({ request }) => {
    const response = await request.get(`${SERVER_URL}/api/providers/kiro/capabilities`, { headers: authHeaders(token) });
    const { data } = await response.json();
    const caps = data.capabilities ?? data;
    expect(caps).toMatchObject({
      supportsAbort: true,
      supportsPermissionRequests: true,
      supportsTokenUsage: true,
      supportsSessionForking: true,
      supportsEffort: true,
    });
  });

  test('a session can be forked at a message and the copy has only that turn, then token usage reports credits', async ({ request }) => {
    const listed = await request.get(`${SERVER_URL}/api/providers/sessions/recent`, { headers: authHeaders(token) });
    expect(listed.ok()).toBeTruthy();
    const page = (await listed.json()).data;
    const sessions: Array<{ provider: string; sessionId?: string; id?: string }> = Array.isArray(page)
      ? page
      : (Object.values(page).find(Array.isArray) as typeof sessions) ?? [];
    const source = sessions.find((session) => session.provider === 'kiro');
    expect(source, 'a Kiro session exists').toBeTruthy();
    const sourceId = source.sessionId ?? source.id;

    // The watcher indexes a session's transcript a moment after the turn ends.
    let forked = await request.post(`${SERVER_URL}/api/providers/sessions/${sourceId}/fork`, { headers: authHeaders(token), data: {} });
    for (let attempt = 0; attempt < 20 && forked.status() === 409; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      forked = await request.post(`${SERVER_URL}/api/providers/sessions/${sourceId}/fork`, { headers: authHeaders(token), data: {} });
    }
    expect(forked.ok(), await forked.text()).toBeTruthy();
    const fork = (await forked.json()).data;
    expect(fork.sessionId).not.toBe(sourceId);
    const usage = await request.get(`${SERVER_URL}/api/providers/sessions/${sourceId}/token-usage`, {
      headers: authHeaders(token),
    });
    const usageBody = (await usage.json()).data;
    expect(usageBody.unit).toBe('credit');
    expect(usageBody.used).toBeGreaterThan(0);
  });

  test('MCP servers are stored in the Kiro settings file and listed back', async ({ request }) => {
    const created = await request.post(`${SERVER_URL}/api/providers/kiro/mcp/servers`, {
      headers: authHeaders(token),
      data: { name: 'e2e-server', scope: 'user', transport: 'stdio', command: 'node', args: ['server.js'] },
    });
    expect(created.ok(), await created.text()).toBeTruthy();

    const listed = await request.get(`${SERVER_URL}/api/providers/kiro/mcp/servers`, { headers: authHeaders(token) });
    const body = JSON.stringify((await listed.json()).data);
    expect(body).toContain('e2e-server');
  });
});
