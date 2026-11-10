import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { describeCentralFailures, useCentralMcpServers } from '@/modules/mcp/hooks/useCentralMcpServers';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const listCalls = vi.fn();
const resyncCalls = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      centralMcpServers: vi.fn(async () => {
        listCalls();
        return json({ success: true, data: { servers: [{ id: 1, name: 's', scope: 'user', transport: 'http', url: 'https://x', targets: [] }] } });
      }),
      resyncCentralMcpServer: vi.fn(async (id: number, payload: { provider?: string }) => {
        resyncCalls(id, payload);
        return json({
          success: true,
          data: { results: [{ provider: 'kiro', outcome: 'applied' }, { provider: 'cursor', outcome: 'conflict', error: 'name taken' }] },
        });
      }),
      deleteCentralMcpServer: vi.fn(async () => json({ success: false, error: { message: 'nope' } }, 500)),
    },
  },
}));

describe('describeCentralFailures', () => {
  it('reports only conflicts and failures', () => {
    expect(describeCentralFailures([
      { provider: 'kiro', outcome: 'applied' },
      { provider: 'cursor', outcome: 'conflict', error: 'name taken' },
      { provider: 'codex', outcome: 'failed' },
    ])).toBe('cursor: name taken; codex: failed');
    expect(describeCentralFailures([{ provider: 'kiro', outcome: 'removed' }])).toBeNull();
  });
});

describe('useCentralMcpServers', () => {
  it('loads the list, and refreshes it after an operation whether or not it succeeds', async () => {
    const { result } = renderHook(() => useCentralMcpServers());
    await waitFor(() => expect(result.current.servers).toHaveLength(1));
    expect(listCalls).toHaveBeenCalledTimes(1);

    let results: Awaited<ReturnType<typeof result.current.resync>> = [];
    await act(async () => { results = await result.current.resync(1, 'kiro'); });
    expect(resyncCalls).toHaveBeenCalledWith(1, { provider: 'kiro' });
    expect(results.map((entry) => entry.outcome)).toEqual(['applied', 'conflict']);
    expect(listCalls).toHaveBeenCalledTimes(2);

    await act(async () => {
      await expect(result.current.remove(1)).rejects.toThrow('nope');
    });
    expect(listCalls).toHaveBeenCalledTimes(3);
  });
});
