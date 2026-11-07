import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import '@/modules/i18n';
import KiroLoginPanel from '@/modules/provider-auth/KiroLoginPanel';
import type { KiroLoginState, ProviderAuthStatus } from '@/shared/types';

// Browser sign-in (device flow): the server runs `kiro-cli login --use-device-flow`
// and returns a verification URL and a code; the panel polls until it finishes.

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const started: KiroLoginState = {
  status: 'awaiting_confirmation',
  method: 'builder-id',
  verificationUrl: 'https://view.awsapps.com/start/#/device?user_code=ABCD-EFGH',
  userCode: 'ABCD-EFGH',
  error: null,
};
const idle: KiroLoginState = { status: 'idle', method: null, verificationUrl: null, userCode: null, error: null };

const startCalls: unknown[] = [];
let pollResult: KiroLoginState = { ...started, status: 'succeeded' };
let logoutCalls = 0;

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      providers: {
        kiroLoginState: async () => json(startCalls.length > 0 ? pollResult : idle),
        startKiroLogin: async (input: unknown) => {
          startCalls.push(input);
          return json(started);
        },
        cancelKiroLogin: async () => json({ ...idle, status: 'cancelled' }),
        kiroLogout: async () => {
          logoutCalls += 1;
          return json({ provider: 'kiro' });
        },
      },
    },
  };
});

const signedOut: ProviderAuthStatus = { authenticated: false, email: null, method: null, error: null, loading: false };
const signedIn: ProviderAuthStatus = {
  authenticated: true,
  email: 'Kiro sign-in (dev@example.com)',
  method: 'cli_login',
  error: null,
  loading: false,
};

describe('KiroLoginPanel', () => {
  beforeEach(() => {
    startCalls.length = 0;
    logoutCalls = 0;
    pollResult = { ...started, status: 'succeeded' };
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts a Builder ID sign-in, shows the link and code, and reports success once the server does', async () => {
    const onChanged = vi.fn();
    render(<KiroLoginPanel authStatus={signedOut} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy();
    const link = screen.getByRole('link', { name: /Open the sign-in page/ }) as HTMLAnchorElement;
    expect(link.href).toBe(started.verificationUrl);
    expect(link.rel).toContain('noopener');
    expect(startCalls).toEqual([{ method: 'builder-id' }]);
    expect(onChanged).not.toHaveBeenCalled();

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(await screen.findByText('Signed in.')).toBeTruthy();
  });

  it('shows the CLI error when the sign-in fails', async () => {
    pollResult = { ...started, status: 'failed', error: 'error: the device code expired' };
    const onChanged = vi.fn();
    render(<KiroLoginPanel authStatus={signedOut} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect((await screen.findByRole('alert', undefined, { timeout: 5000 })).textContent).toBe('error: the device code expired');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('needs a start URL and region for an organization and sends both', async () => {
    render(<KiroLoginPanel authStatus={signedOut} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByLabelText(/Organization \(IAM Identity Center\)/));
    const start = screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Start URL'), { target: { value: 'https://d-123.awsapps.com/start' } });
    expect(start.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'eu-central-1' } });
    expect(start.disabled).toBe(false);

    fireEvent.click(start);
    await screen.findByText('ABCD-EFGH');
    expect(startCalls).toEqual([
      { method: 'identity-center', startUrl: 'https://d-123.awsapps.com/start', region: 'eu-central-1' },
    ]);
    // Remembered for the next time the panel opens.
    expect(JSON.parse(window.localStorage.getItem('kiro-login-organization') ?? '{}')).toEqual({
      startUrl: 'https://d-123.awsapps.com/start',
      region: 'eu-central-1',
    });
  });

  it('shows an existing sign-in and signs out', async () => {
    const onChanged = vi.fn();
    render(<KiroLoginPanel authStatus={signedIn} onChanged={onChanged} />);

    expect(screen.getByText('Kiro sign-in (dev@example.com)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(logoutCalls).toBe(1);
  });
});