import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import '@/modules/i18n';
import KiroApiKeyPanel from '@/modules/provider-auth/KiroApiKeyPanel';
import type { ProviderAuthStatus } from '@/shared/types';

// T7: Kiro authenticates with a pasted API key instead of a CLI login shell.
// The server never echoes the key back (POST/DELETE /api/providers/kiro/api-key),
// so these tests also guard that the panel never surfaces or retains the raw key.

const calls: Array<{ method: string; provider: string; apiKey?: string }> = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const responses: { save: () => Response | Promise<Response>; delete: () => Response | Promise<Response> } = {
  save: () => json({ success: true, data: { masked: 'Kiro API key (...abcd)', method: 'credentials_file' } }),
  delete: () => new Response(null, { status: 204 }),
};

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      providers: {
        saveApiKey: async (provider: string, apiKey: string) => {
          calls.push({ method: 'POST', provider, apiKey });
          return responses.save();
        },
        deleteApiKey: async (provider: string) => {
          calls.push({ method: 'DELETE', provider });
          return responses.delete();
        },
      },
    },
  };
});

const notStored: ProviderAuthStatus = {
  authenticated: false,
  email: null,
  method: null,
  error: null,
  loading: false,
};

const storedByFile: ProviderAuthStatus = {
  authenticated: true,
  email: 'Kiro API key (...abcd)',
  method: 'credentials_file',
  error: null,
  loading: false,
};

const managedByEnvironment: ProviderAuthStatus = {
  authenticated: true,
  email: 'Kiro API key (env)',
  method: 'environment',
  error: null,
  loading: false,
};

describe('KiroApiKeyPanel', () => {
  beforeEach(() => {
    calls.length = 0;
    responses.save = () => json({ success: true, data: { masked: 'Kiro API key (...abcd)', method: 'credentials_file' } });
    responses.delete = () => new Response(null, { status: 204 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves a pasted key, clears the input, and never echoes the raw key back', async () => {
    const onChanged = vi.fn();
    render(<KiroApiKeyPanel authStatus={notStored} onChanged={onChanged} />);

    const input = screen.getByLabelText('API key') as HTMLInputElement;
    expect(input.type).toBe('password');

    fireEvent.change(input, { target: { value: 'sk-kiro-super-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));

    expect(calls).toEqual([{ method: 'POST', provider: 'kiro', apiKey: 'sk-kiro-super-secret' }]);
    // The input is cleared after a successful save.
    expect(input.value).toBe('');
    // The raw key never appears anywhere in the rendered output.
    expect(document.body.textContent).not.toContain('sk-kiro-super-secret');
  });

  it('shows the masked identity for a stored key and clears it on request', async () => {
    const onChanged = vi.fn();
    render(<KiroApiKeyPanel authStatus={storedByFile} onChanged={onChanged} />);

    expect(screen.getByText('Kiro API key (...abcd)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await vi.waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([{ method: 'DELETE', provider: 'kiro' }]);
  });

  it('shows an error and keeps the key out of state when the save is rejected', async () => {
    responses.save = () => json({ success: false, error: { message: 'Invalid API key' } }, 400);
    const onChanged = vi.fn();
    render(<KiroApiKeyPanel authStatus={notStored} onChanged={onChanged} />);

    const input = screen.getByLabelText('API key') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'bad-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Invalid API key');
    expect(onChanged).not.toHaveBeenCalled();
    // Even on failure, the panel source never renders the attempted key value in the DOM outside the input.
    const article = document.body.textContent ?? '';
    expect(article.includes('bad-key')).toBe(false);
  });

  it('hides the save/clear form and explains that an environment key cannot be cleared from the UI', () => {
    render(<KiroApiKeyPanel authStatus={managedByEnvironment} onChanged={() => {}} />);

    expect(screen.getByText('Managed by the KIRO_API_KEY environment variable')).toBeTruthy();
    expect(screen.getByText(/cannot be cleared from the UI/)).toBeTruthy();
    expect(screen.queryByLabelText('API key')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('links to app.kiro.dev to generate a new key', () => {
    render(<KiroApiKeyPanel authStatus={notStored} onChanged={() => {}} />);
    const link = screen.getByRole('link', { name: /app\.kiro\.dev/ }) as HTMLAnchorElement;
    expect(link.href).toBe('https://app.kiro.dev/');
    expect(link.target).toBe('_blank');
  });
});
