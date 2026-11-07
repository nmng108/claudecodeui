import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import SshKeySection from '@/modules/settings/tabs/git-settings/SshKeySection';
import type { SshKeyInfo } from '@/shared/types';

// The Git settings tab shows the public SSH key and creates one only on request.

const json = (data: unknown, status = 200) => new Response(
  JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: data }),
  { status, headers: { 'Content-Type': 'application/json' } },
);

const missing: SshKeyInfo = {
  status: 'missing', origin: null, type: null, publicKey: null, fingerprint: null, comment: null,
  location: '~/.ssh', canGenerate: true, canReplace: false, reason: null, provider: 'native',
};
const generated: SshKeyInfo = {
  status: 'present', origin: 'generated', type: 'ED25519',
  publicKey: 'ssh-ed25519 AAAAC3Nza cloudcli@host', fingerprint: 'SHA256:abc', comment: 'cloudcli@host',
  location: '~/.ssh/id_ed25519', canGenerate: false, canReplace: true, reason: null, provider: 'native',
};

let current: SshKeyInfo;
const generateCalls: unknown[] = [];
let generateResult: () => Response;

vi.mock('@/shared/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    api: {
      sshKeys: {
        get: async () => json(current),
        generate: async (options: unknown) => {
          generateCalls.push(options);
          return generateResult();
        },
      },
    },
  };
});

describe('SshKeySection', () => {
  beforeEach(() => {
    generateCalls.length = 0;
    generateResult = () => json(generated);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('offers to generate a key when none exists, and creates it only on click', async () => {
    current = missing;
    render(<SshKeySection />);

    const button = await screen.findByRole('button', { name: 'Generate SSH key' });
    expect(generateCalls).toHaveLength(0);

    fireEvent.click(button);
    expect(await screen.findByDisplayValue('ssh-ed25519 AAAAC3Nza cloudcli@host')).toBeTruthy();
    expect(generateCalls).toEqual([{}]);
    expect(screen.getByText('SHA256:abc')).toBeTruthy();
  });

  it('explains when a key cannot be generated because the directory is read-only', async () => {
    current = { ...missing, canGenerate: false, reason: 'read-only' };
    render(<SshKeySection />);

    expect(await screen.findByText(/is read-only/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Generate SSH key' })).toBeNull();
  });

  it('shows the public key with a copy button and the places to add it', async () => {
    current = generated;
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<SshKeySection />);

    await screen.findByDisplayValue('ssh-ed25519 AAAAC3Nza cloudcli@host');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ssh-ed25519 AAAAC3Nza cloudcli@host'));

    expect(screen.getByRole('link', { name: /GitHub/ }).getAttribute('href')).toBe('https://github.com/settings/ssh/new');
    expect(screen.getByRole('link', { name: /GitLab/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Bitbucket/ })).toBeTruthy();
  });

  it('asks for confirmation before replacing a generated key', async () => {
    current = generated;
    render(<SshKeySection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Replace key' }));
    expect(generateCalls).toHaveLength(0);
    expect(screen.getByText(/Remove the old key from your git servers/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(generateCalls).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Replace key' }));
    await waitFor(() => expect(generateCalls).toEqual([{ replace: true }]));
  });

  it('never offers to replace a key the user brought', async () => {
    current = { ...generated, origin: 'existing', canReplace: false };
    render(<SshKeySection />);

    await screen.findByDisplayValue('ssh-ed25519 AAAAC3Nza cloudcli@host');
    expect(screen.getByText('Existing key')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Replace key' })).toBeNull();
  });

  it('reports a key whose public half cannot be read', async () => {
    current = { ...missing, status: 'unreadable', origin: 'existing', canGenerate: false, location: '~/.ssh/id_rsa', reason: 'passphrase-or-unreadable' };
    render(<SshKeySection />);

    expect(await screen.findByText(/public key could not be read/)).toBeTruthy();
  });

  it('shows the server message when generating fails', async () => {
    current = missing;
    generateResult = () => json({ code: 'SSH_KEYGEN_MISSING', message: 'ssh-keygen is not installed' }, 501);
    render(<SshKeySection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Generate SSH key' }));
    expect((await screen.findByRole('alert')).textContent).toContain('ssh-keygen is not installed');
  });

  it('warns that every process in the environment can use the key', async () => {
    current = missing;
    render(<SshKeySection />);
    expect(await screen.findByText(/Every process in this environment/)).toBeTruthy();
  });
});