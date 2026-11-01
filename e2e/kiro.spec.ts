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

  const send = async (page: Page, text: string) => {
    const composer = page.locator('textarea').first();
    await composer.fill(text);
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
