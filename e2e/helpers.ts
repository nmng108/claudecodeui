import path from 'node:path';

import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const SERVER_URL = `http://127.0.0.1:${process.env.E2E_SERVER_PORT || '3101'}`;
export const WORKSPACE = path.resolve('.e2e-run', 'home', 'workspace');
const USERNAME = 'e2e-user';
const PASSWORD = 'e2e-password-123';

export const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Registers the first user (or logs in once registered) and returns its API token. */
export async function authenticate(request: APIRequestContext): Promise<string> {
  const status = await (await request.get(`${SERVER_URL}/api/auth/status`)).json();
  const endpoint = status.needsSetup ? 'register' : 'login';
  const response = await request.post(`${SERVER_URL}/api/auth/${endpoint}`, {
    data: { username: USERNAME, password: PASSWORD },
  });
  expect(response.ok(), `auth ${endpoint} failed`).toBeTruthy();
  const token = (await response.json()).token as string;
  // Skip the first-run wizard (git identity and agent connection).
  await request.post(`${SERVER_URL}/api/user/complete-onboarding`, { headers: authHeaders(token) });
  return token;
}

/** Creates the sandbox project (idempotent) through the API. */
export async function ensureProject(request: APIRequestContext, token: string): Promise<void> {
  const response = await request.post(`${SERVER_URL}/api/projects/create-project`, {
    headers: authHeaders(token),
    data: { path: WORKSPACE },
  });
  expect(response.ok(), `create-project failed: ${await response.text()}`).toBeTruthy();
}

/** Opens the app signed in, collecting console errors and uncaught page errors. */
export async function openApp(page: Page, token: string): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    // Only our own servers: the page also calls api.github.com (star count, update check), which rate-limits.
    if (response.status() >= 400 && /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(response.url())) {
      errors.push(`http ${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });
  page.on('console', (message) => {
    // A failed request is reported once, with its URL, by the response listener above.
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) {
      errors.push(`console: ${message.text()}`);
    }
  });
  await page.addInitScript((value) => window.localStorage.setItem('auth-token', value), token);
  await page.goto('/');
  return { errors };
}
