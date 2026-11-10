import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useMcpRawConfig } from '@/modules/mcp/hooks/useMcpRawConfig';
import type { ProviderMcpRawConfig } from '@/shared/types';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const baseConfig: ProviderMcpRawConfig = {
  provider: 'kiro',
  scope: 'user',
  filePath: '/home/u/.kiro/settings/mcp.json',
  format: 'json',
  content: '{"mcpServers":{}}',
  exists: true,
  hash: 'hash-1',
  partial: false,
};

const saveCalls: Array<Record<string, unknown>> = [];

vi.mock('@/shared/api', () => ({
  api: {
    providers: {
      mcpRawConfig: vi.fn(async () => json({ success: true, data: { config: baseConfig } })),
      saveMcpRawConfig: vi.fn(async (_provider: string, payload: Record<string, unknown>) => {
        saveCalls.push(payload);
        if (payload.expectedHash === 'stale') {
          return json({ success: false, error: { message: 'changed on disk' } }, 409);
        }
        return json({
          success: true,
          data: {
            result: { ...baseConfig, content: String(payload.content), hash: 'hash-2', added: ['x'], changed: [], removed: [], written: !payload.dryRun },
          },
        });
      }),
    },
  },
}));

describe('useMcpRawConfig', () => {
  beforeEach(() => {
    saveCalls.length = 0;
  });

  it('loads the file text, previews with a dry run, then saves with the loaded hash', async () => {
    const onSaved = vi.fn(async () => {});
    const { result } = renderHook(() => useMcpRawConfig({ provider: 'kiro', currentProjects: [], onSaved }));

    await waitFor(() => expect(result.current.loaded?.hash).toBe('hash-1'));
    expect(result.current.draft).toBe(baseConfig.content);
    expect(result.current.isUnchanged).toBe(true);

    act(() => result.current.updateDraft('{"mcpServers":{"x":{"command":"a"}}}'));
    expect(result.current.isUnchanged).toBe(false);

    await act(async () => { await result.current.previewChanges(); });
    expect(saveCalls[0]).toMatchObject({ dryRun: true, expectedHash: 'hash-1', mode: 'replace' });
    expect(result.current.preview?.added).toEqual(['x']);

    await act(async () => { await result.current.save(); });
    expect(saveCalls[1]).toMatchObject({ dryRun: false, expectedHash: 'hash-1' });
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(result.current.loaded?.hash).toBe('hash-2');
  });

  it('starts with an empty draft in merge mode and surfaces server errors', async () => {
    const { result } = renderHook(() => useMcpRawConfig({ provider: 'kiro', currentProjects: [], onSaved: async () => {} }));
    await waitFor(() => expect(result.current.loaded).not.toBeNull());

    act(() => result.current.changeMode('merge'));
    expect(result.current.draft).toBe('');
    act(() => result.current.changeMode('replace'));
    expect(result.current.draft).toBe(baseConfig.content);

    const { api } = await import('@/shared/api');
    vi.mocked(api.providers.mcpRawConfig).mockResolvedValueOnce(json({ success: true, data: { config: { ...baseConfig, hash: 'stale' } } }));
    await act(async () => { await result.current.reload(); });
    act(() => result.current.updateDraft('{}'));
    await act(async () => { await result.current.save(); });
    expect(result.current.error).toBe('changed on disk');
  });
});
