import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import GitRepositorySelector from '@/modules/git-panel/GitRepositorySelector';
import type { GitRepositoryEntry } from '@/shared/types';

const repo = (path: string, branch: string | null = 'main', isProjectRoot = false): GitRepositoryEntry => ({
  path,
  name: path.split('/').pop() || 'root',
  isProjectRoot,
  branch,
});

const renderSelector = (overrides: Partial<React.ComponentProps<typeof GitRepositorySelector>> = {}) => {
  const onSelect = vi.fn();
  const onRescan = vi.fn();
  render(
    <GitRepositorySelector
      repositories={[repo('api', 'develop'), repo('web')]}
      activeRepo="api"
      truncated={false}
      isLoading={false}
      isMobile={false}
      onSelect={onSelect}
      onRescan={onRescan}
      {...overrides}
    />,
  );
  return { onSelect, onRescan };
};

describe('GitRepositorySelector', () => {
  beforeAll(() => {
    // jsdom ships no ResizeObserver or scrollIntoView, which the cmdk list uses.
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = () => undefined;
  });

  it('shows the active repository and lists the others with their branch', () => {
    renderSelector();
    expect(screen.getByRole('button', { name: /api/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /api/ }));
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByText('develop')).toBeTruthy();
  });

  it('selects another repository and closes', () => {
    const { onSelect } = renderSelector();
    fireEvent.click(screen.getByRole('button', { name: /api/ }));
    fireEvent.click(screen.getByRole('option', { name: /web/ }));

    expect(onSelect).toHaveBeenCalledWith('web');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not report a selection of the repository that is already active', () => {
    const { onSelect } = renderSelector();
    fireEvent.click(screen.getByRole('button', { name: /api/ }));
    fireEvent.click(screen.getByRole('option', { name: /api/ }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('labels the project folder entry and rescans on request', () => {
    const { onRescan } = renderSelector({
      repositories: [repo('', 'main', true), repo('vendored')],
      activeRepo: '',
    });
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.getByText('Project folder')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Rescan/ }));
    expect(onRescan).toHaveBeenCalled();
  });

  it('adds a search box for long lists and filters by path', () => {
    const many = Array.from({ length: 12 }, (_, index) => repo(`group/service-${index}`));
    renderSelector({ repositories: many, activeRepo: 'group/service-0' });
    fireEvent.click(screen.getAllByRole('button')[0]);

    fireEvent.change(screen.getByPlaceholderText('Search repositories...'), { target: { value: 'service-11' } });
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('warns when the scan was cut short', () => {
    renderSelector({ truncated: true });
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.getByText(/Only the first repositories/)).toBeTruthy();
  });

  it('moves with Up/Down from the active repository and picks with Enter', () => {
    const { onSelect } = renderSelector({
      repositories: [repo('api'), repo('web'), repo('worker')],
      activeRepo: 'api',
    });
    fireEvent.click(screen.getAllByRole('button')[0]);
    const input = screen.getByRole('combobox');

    // The list opens on the active repository.
    expect(screen.getByRole('option', { name: /api/ }).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /worker/ }).getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('web');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('wraps around at either end of the list', () => {
    renderSelector({ repositories: [repo('api'), repo('web')], activeRepo: 'api' });
    fireEvent.click(screen.getAllByRole('button')[0]);
    const input = screen.getByRole('combobox');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.getByRole('option', { name: /web/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('picks the first match with Enter after filtering', () => {
    const many = Array.from({ length: 12 }, (_, index) => repo(`group/service-${index}`));
    const { onSelect } = renderSelector({ repositories: many, activeRepo: 'group/service-0' });
    fireEvent.click(screen.getAllByRole('button')[0]);

    const input = screen.getByPlaceholderText('Search repositories...');
    fireEvent.change(input, { target: { value: 'service-11' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('group/service-11');
  });

  it('keeps keyboard navigation for short lists without showing a search box', () => {
    renderSelector();
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.getByRole('combobox').closest('.sr-only')).not.toBeNull();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    renderSelector();
    const trigger = screen.getAllByRole('button')[0];
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('opens from the closed trigger with Arrow-Down', () => {
    renderSelector();
    fireEvent.keyDown(screen.getAllByRole('button')[0], { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeTruthy();
  });
});
