import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';
import type { TFunction } from 'i18next';

import SidebarModals from '@/modules/sidebar/SidebarModals';
import type { PendingSidebarDeletion } from '@/shared/types';

// The settings and wizard modals are closed here; stubbing them keeps this test
// about the delete confirmation alone.
vi.mock('@/modules/settings', () => ({ Settings: () => null }));
vi.mock('@/modules/version-upgrade', () => ({ VersionUpgradeModal: () => null }));
vi.mock('@/modules/project-creation-wizard', () => ({ ProjectCreationWizard: () => null }));

// Echoes the default text so the test reads the strings the dialog would show.
const t = ((key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key)) as unknown as TFunction;

const renderDialog = (pendingDeletion: PendingSidebarDeletion) => render(
  <SidebarModals
    projects={[]}
    showSettings={false}
    settingsInitialTab="agents"
    onCloseSettings={() => {}}
    showNewProject={false}
    onCloseNewProject={() => {}}
    onProjectCreated={() => {}}
    pendingDeletion={pendingDeletion}
    onCancelDeletion={() => {}}
    onConfirmDeleteProject={() => {}}
    onConfirmDeleteSession={() => {}}
    onConfirmDeleteSessions={() => {}}
    showVersionModal={false}
    onCloseVersionModal={() => {}}
    releaseInfo={null}
    currentVersion="1.0.0"
    latestVersion={null}
    installMode="git"
    t={t}
  />,
);

test('deleting a Kiro session warns that it is also removed from Kiro and kiro-ui', () => {
  renderDialog({ kind: 'session', sessionId: 's1', sessionTitle: 'Kiro chat', isArchived: false, provider: 'kiro' });

  screen.getByText('Deleting permanently also removes this session from Kiro and kiro-ui.');
  screen.getByRole('button', { name: /Delete permanently/ });
});

test('other providers get no Kiro warning', () => {
  renderDialog({ kind: 'session', sessionId: 's2', sessionTitle: 'Claude chat', isArchived: false, provider: 'claude' });

  assert.equal(screen.queryByText(/Kiro and kiro-ui/), null);
  screen.getByRole('button', { name: /Delete permanently/ });
});

test('a session without a known provider gets no Kiro warning', () => {
  renderDialog({ kind: 'session', sessionId: 's3', sessionTitle: 'Untyped', isArchived: true });

  assert.equal(screen.queryByText(/Kiro and kiro-ui/), null);
});
