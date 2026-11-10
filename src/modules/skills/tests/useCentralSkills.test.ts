import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { describeCentralSkillProblems, useCentralSkills } from '@/modules/skills/hooks/useCentralSkills';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const listCalls = vi.fn();
const adoptCalls = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      centralSkills: vi.fn(async () => {
        listCalls();
        return json({ success: true, data: { skills: [{ directoryName: 's', name: 's', description: '', sourcePath: '/h/.agents/skills/s/SKILL.md', providers: [] }] } });
      }),
      adoptCentralSkill: vi.fn(async (payload: { provider: string; directoryName: string }) => {
        adoptCalls(payload);
        return json({ success: true, data: { results: [{ provider: 'claude', outcome: 'linked' }] } });
      }),
      deleteCentralSkill: vi.fn(async () => json({ success: false, error: { message: 'still linked' } }, 500)),
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

    await act(async () => {
      await expect(result.current.remove('s')).rejects.toThrow('still linked');
    });
    expect(listCalls).toHaveBeenCalledTimes(3);
  });
});
