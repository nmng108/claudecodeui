import { defineConfig, devices } from '@playwright/test';

const SERVER_PORT = process.env.E2E_SERVER_PORT || '3101';
const CLIENT_PORT = process.env.E2E_CLIENT_PORT || '5174';
// Use an installed browser by default; set E2E_BROWSER_CHANNEL= (empty) to use the
// Chromium that `npx playwright install chromium` downloads.
const channel = process.env.E2E_BROWSER_CHANNEL ?? 'chrome';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  outputDir: './.e2e-run/results',
  // The tests share one server and one sandboxed HOME, so they run in order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${CLIENT_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: channel || undefined } }],
  webServer: [
    {
      command: 'node e2e/run-server.mjs',
      url: `http://127.0.0.1:${SERVER_PORT}/api/auth/status`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${CLIENT_PORT} --strictPort`,
      url: `http://127.0.0.1:${CLIENT_PORT}`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { SERVER_PORT, HOST: '127.0.0.1', VITE_PORT: CLIENT_PORT },
    },
  ],
});
