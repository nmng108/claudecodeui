import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { describeCentralSkillProblems, useCentralSkills } from '@/modules/skills/hooks/useCentralSkills';
import { api } from '@/shared/api';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const listCalls = vi.fn();
const adoptCalls = vi.fn();
const projectCalls = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      centralSkills: vi.fn(async (scope: { projectId?: string } = {}) => {
        listCalls();
        const skill = (directoryName: string) => ({ directoryName, name: directoryName, description: '', sourcePath: `/h/.agents/skills/${directoryName}/SKILL.md`, providers: [] });
        return json({
          success: true,
          data: scope.projectId
            ? { skills: [skill('project-skill')], providers: [{ provider: 'cursor', native: true, linkable: false }] }
            : { skills: [skill('s')], providers: [{ provider: 'cursor', native: false, linkable: true }] },
        });
      }),
      linkCentralSkill: vi.fn(async (directoryName: string, payload: unknown) => {
        projectCalls('link', directoryName, payload);
        return json({ success: true, data: { results: [] } });
      }),
      deleteCentralSkill: vi.fn(async (directoryName: string, scope: unknown) => {
        projectCalls('delete', directoryName, scope);
        return json({ success: true, data: { removed: true, results: [] } });
      }),
      adoptCentralSkill: vi.fn(async (payload: { provider: string; directoryName: string }) => {
        adoptCalls(payload);
        return json({ success: true, data: { results: [{ provider: 'claude', outcome: 'linked' }] } });
      }),
    },
  },
}));

describe('describeCentralSkillProblems', () => {
  it('reports only conflicts and failures', () => {
    expect(describeCentralSkillProblems([
      { provider: 'claude', outcome: 'linked' },
      { provider: 'cursor', outcome: 'conflict', error: 'folder in the way' },
    ])).toBe('cursor: folder in the way');
    expect(describeCentralSkillProblems([{ provider: 'kiro', outcome: 'unlinked' }])).toBeNull();
  });
});

describe('useCentralSkills', () => {
  it('loads the list and refreshes it after an operation whether or not it succeeds', async () => {
    const { result } = renderHook(() => useCentralSkills());
    await waitFor(() => expect(result.current.skills).toHaveLength(1));

    await act(async () => { await result.current.adopt('claude', 's'); });
    expect(adoptCalls).toHaveBeenCalledWith({ provider: 'claude', directoryName: 's' });
    expect(listCalls).toHaveBeenCalledTimes(2);

    await act(async () => { await result.current.remove('s'); });
    expect(listCalls).toHaveBeenCalledTimes(3);
  });
});

describe('useCentralSkills failures', () => {
  it('reports the server\'s reason and still refreshes the list', async () => {
    const { result } = renderHook(() => useCentralSkills());
    await waitFor(() => expect(result.current.skills).toHaveLength(1));
    listCalls.mockClear();
    vi.mocked(api.providers.deleteCentralSkill).mockImplementationOnce(
      async () => json({ success: false, error: { message: 'still linked' } }, 500),
    );

    await act(async () => {
      await expect(result.current.remove('s')).rejects.toThrow('still linked');
    });
    expect(listCalls).toHaveBeenCalledTimes(1);
  });
});

describe('useCentralSkills scopes', () => {
  it('lists a project\'s shared skills, with which providers read the folder themselves', async () => {
    const { result } = renderHook(() => useCentralSkills('project-1'));
    await waitFor(() => expect(result.current.skills.map((skill) => skill.directoryName)).toEqual(['project-skill']));

    expect(result.current.providers).toEqual([{ provider: 'cursor', native: true, linkable: false }]);
  });

  it('sends the project id with every operation, and nothing extra for the user scope', async () => {
    projectCalls.mockClear();
    const project = renderHook(() => useCentralSkills('project-1'));
    await waitFor(() => expect(project.result.current.skills).toHaveLength(1));
    await act(async () => { await project.result.current.link('project-skill', ['kiro']); });
    await act(async () => { await project.result.current.remove('project-skill'); });

    expect(projectCalls).toHaveBeenCalledWith('link', 'project-skill', { providers: ['kiro'], mode: undefined, projectId: 'project-1' });
    expect(projectCalls).toHaveBeenCalledWith('delete', 'project-skill', { projectId: 'project-1' });

    projectCalls.mockClear();
    const user = renderHook(() => useCentralSkills());
    await waitFor(() => expect(user.result.current.skills).toHaveLength(1));
    await act(async () => { await user.result.current.remove('s'); });
    expect(projectCalls).toHaveBeenCalledWith('delete', 's', {});
  });

  it('never shows one scope\'s list while another scope is loading', async () => {
    const { result, rerender } = renderHook(({ projectId }: { projectId?: string }) => useCentralSkills(projectId), {
      initialProps: {} as { projectId?: string },
    });
    await waitFor(() => expect(result.current.skills.map((skill) => skill.directoryName)).toEqual(['s']));

    rerender({ projectId: 'project-1' });
    // Straight after the switch the user's list is already gone from view.
    expect(result.current.skills).toEqual([]);
    await waitFor(() => expect(result.current.skills.map((skill) => skill.directoryName)).toEqual(['project-skill']));
  });
});
