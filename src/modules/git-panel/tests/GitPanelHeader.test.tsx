import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import GitPanelHeader from '@/modules/git-panel/GitPanelHeader';

const renderHeader = (overrides: Partial<React.ComponentProps<typeof GitPanelHeader>> = {}) => {
  const onSwitchBranch = vi.fn(async () => true);
  render(
    <GitPanelHeader
      isMobile={false}
      currentBranch="main"
      branches={['main', 'develop', 'feature/login']}
      remoteStatus={null}
      isLoading={false}
      isCreatingBranch={false}
      isFetching={false}
      isPulling={false}
      isPushing={false}
      isPublishing={false}
      isRevertingLocalCommit={false}
      operationError={null}
      onRefresh={vi.fn()}
      onRevertLocalCommit={vi.fn(async () => {})}
      onSwitchBranch={onSwitchBranch}
      onCreateBranch={vi.fn(async () => true)}
      onFetch={vi.fn(async () => {})}
      onPull={vi.fn(async () => {})}
      onPush={vi.fn(async () => {})}
      onPublish={vi.fn(async () => {})}
      onClearError={vi.fn()}
      onRequestConfirmation={vi.fn()}
      {...overrides}
    />,
  );
  return { onSwitchBranch, trigger: screen.getByRole('button', { name: /main/ }) };
};

describe('GitPanelHeader branch dropdown', () => {
  beforeAll(() => {
    // jsdom ships no ResizeObserver or scrollIntoView, which the cmdk list uses.
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = () => undefined;
  });

  it('opens on the current branch and switches with Down + Enter', async () => {
    const { onSwitchBranch, trigger } = renderHeader();
    fireEvent.click(trigger);
    const input = screen.getByRole('combobox');

    expect(screen.getByRole('option', { name: /main/ }).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onSwitchBranch).toHaveBeenCalledWith('develop'));
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it('switches to the first match after filtering and pressing Enter', async () => {
    const { onSwitchBranch, trigger } = renderHeader();
    fireEvent.click(trigger);
    const input = screen.getByRole('combobox');

    fireEvent.change(input, { target: { value: 'login' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onSwitchBranch).toHaveBeenCalledWith('feature/login'));
  });

  it('stays open when the switch fails', async () => {
    const { trigger } = renderHeader({ onSwitchBranch: vi.fn(async () => false) });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    await act(async () => {});
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('ignores a second Enter while the first switch is still running', async () => {
    let finishSwitch: (value: boolean) => void = () => {};
    const slowSwitch = vi.fn(() => new Promise<boolean>((resolve) => { finishSwitch = resolve; }));
    const { trigger } = renderHeader({ onSwitchBranch: slowSwitch });
    fireEvent.click(trigger);
    const input = screen.getByRole('combobox');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(slowSwitch).toHaveBeenCalledTimes(1);

    await act(async () => finishSwitch(true));
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const { trigger } = renderHeader();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('opens from the closed trigger with Arrow-Down', () => {
    const { trigger } = renderHeader();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('offers branch creation under the list', () => {
    const { trigger } = renderHeader();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: /Create new branch/i }));

    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
