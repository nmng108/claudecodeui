import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import ProviderSkills from '@/modules/skills/ProviderSkills';
import { api } from '@/shared/api';
import type { SkillsProject } from '@/shared/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const PROJECT: SkillsProject = { projectId: 'proj-1', displayName: 'App', fullPath: '/work/app' };

const skill = (name: string, scope: string, sourcePath: string) => ({
  name,
  description: `${name} skill`,
  command: `/${name}`,
  scope,
  sourcePath,
});

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      // The server lists a provider's skills for one workspace at a time.
      skills: vi.fn(async (_provider: string, { workspacePath }: { workspacePath?: string } = {}) => json({
        success: true,
        data: {
          provider: 'kiro',
          skills: workspacePath === '/work/app'
            ? [skill('team-skill', 'project', '/work/app/.kiro/skills/team-skill/SKILL.md')]
            : [
              skill('my-skill', 'user', '/home/me/.kiro/skills/my-skill/SKILL.md'),
              // The server's own working folder is not an added project.
              skill('cwd-skill', 'project', '/server/.kiro/skills/cwd-skill/SKILL.md'),
            ],
        },
      })),
      saveSkills: vi.fn(async () => json({ success: true, data: { provider: 'kiro', skills: [] } })),
      deleteSkill: vi.fn(async () => json({ success: true, data: { removed: true, provider: 'kiro', directoryName: 'x' } })),
      centralSkills: vi.fn(async ({ projectId }: { projectId?: string } = {}) => json({
        success: true,
        data: {
          skills: projectId
            ? [{
              directoryName: 'team-shared',
              name: 'team-shared',
              description: 'Shared in the project',
              sourcePath: '/work/app/.agents/skills/team-shared/SKILL.md',
              providers: [
                { provider: 'kiro', state: 'unlinked' },
                // Cursor reads a project's .agents/skills itself: nothing to link.
                { provider: 'cursor', state: 'native' },
              ],
            }]
            : [],
          providers: [{ provider: 'kiro', native: false, linkable: true }],
        },
      })),
      adoptCentralSkill: vi.fn(async () => json({ success: true, data: { results: [{ provider: 'kiro', outcome: 'linked' }] } })),
    },
  },
}));

describe('ProviderSkills scopes', () => {
  beforeEach(() => {
    vi.mocked(api.providers.deleteSkill).mockClear();
    vi.mocked(api.providers.adoptCentralSkill).mockClear();
    vi.mocked(api.providers.centralSkills).mockClear();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderTab = (projects: SkillsProject[] = [PROJECT]) => render(
    <ProviderSkills selectedProvider="kiro" currentProjects={projects} />,
  );

  it('lists the global scope first, without skills of folders that are not added projects', async () => {
    renderTab();

    expect(await screen.findByText('/my-skill')).toBeTruthy();
    expect(screen.queryByText('/team-skill')).toBeNull();
    expect(screen.queryByText('/cwd-skill')).toBeNull();
  });

  it('offers a scope picker only when there are projects, listing only the added ones', async () => {
    const { unmount } = renderTab();
    const picker = await screen.findByLabelText('Skills for');
    expect(Array.from(picker.querySelectorAll('option')).map((option) => option.textContent)).toEqual(['Global', 'Project: App']);
    unmount();

    renderTab([]);
    await screen.findByText('/my-skill');
    expect(screen.queryByLabelText('Skills for')).toBeNull();
  });

  it('switches to a project and shows that project\'s skills, with its own shared skills list', async () => {
    renderTab();
    await screen.findByText('/my-skill');

    fireEvent.change(screen.getByLabelText('Skills for'), { target: { value: 'proj-1' } });

    expect(await screen.findByText('/team-skill')).toBeTruthy();
    expect(screen.queryByText('/my-skill')).toBeNull();
    await waitFor(() => expect(api.providers.centralSkills).toHaveBeenCalledWith({ projectId: 'proj-1' }));
  });

  it('deletes a project skill from that project\'s folder after confirming', async () => {
    renderTab();
    await screen.findByText('/my-skill');
    fireEvent.change(screen.getByLabelText('Skills for'), { target: { value: 'proj-1' } });
    await screen.findByText('/team-skill');

    fireEvent.click(screen.getByRole('button', { name: 'Delete team-skill' }));

    await waitFor(() => expect(api.providers.deleteSkill).toHaveBeenCalledWith('kiro', 'team-skill', { projectId: 'proj-1' }));
  });

  it('deletes a global skill without a project id, and does nothing when the user declines', async () => {
    renderTab();
    await screen.findByText('/my-skill');

    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Delete my-skill' }));
    expect(api.providers.deleteSkill).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Delete my-skill' }));
    await waitFor(() => expect(api.providers.deleteSkill).toHaveBeenCalledWith('kiro', 'my-skill', { projectId: undefined }));
  });

  it('shares a project skill into that project\'s shared folder', async () => {
    renderTab();
    await screen.findByText('/my-skill');
    fireEvent.change(screen.getByLabelText('Skills for'), { target: { value: 'proj-1' } });
    await screen.findByText('/team-skill');
    // The Share action needs the scope's provider list, which arrives with the shared skills.
    const share = await screen.findByRole('button', { name: 'Share' });

    fireEvent.click(share);

    await waitFor(() => expect(api.providers.adoptCentralSkill).toHaveBeenCalledWith({
      provider: 'kiro',
      directoryName: 'team-skill',
      projectId: 'proj-1',
    }));
  });

  it('opens the shared skills dialog for the chosen scope, with native providers marked as reading the folder', async () => {
    renderTab();
    await screen.findByText('/my-skill');
    fireEvent.change(screen.getByLabelText('Skills for'), { target: { value: 'proj-1' } });
    await screen.findByText('/team-skill');

    fireEvent.click(await screen.findByRole('button', { name: /Shared skills/ }));

    expect(await screen.findByRole('heading', { name: 'Shared skills: App' })).toBeTruthy();
    expect(screen.getByText(/<project>\/\.agents\/skills/)).toBeTruthy();
    expect(await screen.findByText('team-shared')).toBeTruthy();
    expect(screen.getByText('Reads shared folder')).toBeTruthy();
    expect(screen.getByText('Not linked')).toBeTruthy();
  });
});
