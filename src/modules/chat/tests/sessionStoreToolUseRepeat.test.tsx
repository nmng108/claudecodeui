import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, it, vi } from 'vitest';

import type { NormalizedMessage } from '@/shared/types';

/**
 * Kiro announces one tool call more than once under the same id, the later
 * announcement carrying the final title and input. The chat must show one card.
 */

vi.mock('@/shared/api', () => ({ api: { providers: { sessionMessages: vi.fn() } } }));

const row = (id: string, fields: Partial<NormalizedMessage>): NormalizedMessage => ({
  id,
  provider: 'kiro',
  sessionId: 'session-1',
  timestamp: '2026-01-01T00:00:01.000Z',
  ...fields,
} as NormalizedMessage);

afterEach(() => {
  vi.resetModules();
});

async function openStore() {
  const { useSessionStore } = await import('@/modules/chat/hooks/useSessionStore');
  return renderHook(() => useSessionStore());
}

describe('live tool_use rows announced twice', () => {
  it('shows one row carrying the latest title and input, in the first row\'s place', async () => {
    const { result } = await openStore();

    act(() => {
      result.current.appendRealtime('session-1', row('first', {
        kind: 'tool_use',
        toolId: 'T1',
        toolName: 'execute_bash',
        toolInput: { command: 'ls' },
      }));
      result.current.appendRealtime('session-1', row('between', { kind: 'text', role: 'assistant', content: 'x' }));
      result.current.appendRealtime('session-1', row('second', {
        kind: 'tool_use',
        toolId: 'T1',
        toolName: 'Inspect files',
        toolInput: { command: 'ls', description: 'Inspect files', run_in_background: false },
      }));
    });

    const rows = result.current.getMessages('session-1');
    assert.deepEqual(rows.map((r) => r.id), ['first', 'between']);
    assert.equal(rows[0].toolName, 'Inspect files');
    assert.deepEqual(rows[0].toolInput, { command: 'ls', description: 'Inspect files', run_in_background: false });
  });

  it('keeps the earlier input when a chunk carries none, and keeps separate calls apart', async () => {
    const { result } = await openStore();

    act(() => {
      result.current.appendRealtime('session-1', row('a', { kind: 'tool_use', toolId: 'T1', toolName: 'read', toolInput: { path: 'f' } }));
      result.current.appendRealtime('session-1', row('b', { kind: 'tool_use', toolId: 'T1', toolName: 'read' }));
      result.current.appendRealtime('session-1', row('c', { kind: 'tool_use', toolId: 'T2', toolName: 'read', toolInput: { path: 'g' } }));
    });

    const rows = result.current.getMessages('session-1');
    assert.deepEqual(rows.map((r) => r.id), ['a', 'c']);
    assert.deepEqual(rows[0].toolInput, { path: 'f' });
  });
});
