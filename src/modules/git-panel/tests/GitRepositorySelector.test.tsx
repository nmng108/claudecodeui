import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

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
});