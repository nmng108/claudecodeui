import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import GitRemoteAccessBadge from '@/modules/git-panel/GitRemoteAccessBadge';
import type { GitRemoteAccess } from '@/shared/types';

const readWrite: GitRemoteAccess = {
  state: 'read-write',
  read: 'ok',
  write: 'ok',
  readVia: 'credentials',
  remote: 'origin',
  url: 'git@github.com:acme/app.git',
  host: 'github.com',
  transport: 'ssh',
  branch: 'main',
  message: null,
  checkedAt: '2026-11-07T10:00:00.000Z',
};

const renderBadge = (access: GitRemoteAccess | null, overrides: Partial<React.ComponentProps<typeof GitRemoteAccessBadge>> = {}) => {
  const onCheck = vi.fn();
  const onAutoCheckChange = vi.fn();
  render(
    <GitRemoteAccessBadge
      access={access}
      isChecking={false}
      autoCheck
      isMobile={false}
      onCheck={onCheck}
      onAutoCheckChange={onAutoCheckChange}
      {...overrides}
    />,
  );
  return { onCheck, onAutoCheckChange };
};

describe('GitRemoteAccessBadge', () => {
  it.each([
    ['read-write', 'Read & write'],
    ['read-only', 'Read only'],
    ['no-access', 'No access'],
    ['host-key', 'Host key'],
    ['unreachable', 'Unreachable'],
  ] as const)('labels the %s state', (state, label) => {
    renderBadge({ ...readWrite, state });
    expect(screen.getByText(label)).toBeTruthy();
  });

  it('shows a neutral label before the first check and while checking', () => {
    const { onCheck } = renderBadge(null);
    expect(screen.getByText('Remote access')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Remote access'));
    fireEvent.click(screen.getByRole('button', { name: 'Check access' }));
    expect(onCheck).toHaveBeenCalledWith(true);
  });

  it('explains a read-only result and flags a public repository', () => {
    renderBadge({
      ...readWrite,
      state: 'read-only',
      write: 'denied',
      readVia: 'anonymous',
      message: 'remote: Permission to acme/app denied.',
    });
    fireEvent.click(screen.getByTitle('Remote access'));

    expect(screen.getByText(/not allowed to push/)).toBeTruthy();
    expect(screen.getByText(/can be read without credentials/)).toBeTruthy();
    expect(screen.getByText('remote: Permission to acme/app denied.')).toBeTruthy();
    expect(screen.getByText(/git@github.com:acme\/app.git/)).toBeTruthy();
  });

  it('re-checks on demand and lets the user turn automatic checks off', () => {
    const { onCheck, onAutoCheckChange } = renderBadge(readWrite);
    fireEvent.click(screen.getByTitle('Remote access'));

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onCheck).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('checkbox'));
    expect(onAutoCheckChange).toHaveBeenCalledWith(false);
  });
});