import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginKiroCompaction,
  isKiroSessionCompacting,
  listKiroCompactions,
} from '@/modules/providers/list/kiro/kiro-compaction-registry.js';
import { kiroRuntime } from '@/modules/providers/list/kiro/kiro-runtime.provider.js';
import { compactKiroSession } from '@/modules/providers/list/kiro/kiro-session-commands.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

test('a compaction claims its session until it is released', () => {
  const release = beginKiroCompaction('sess_claim', 'app-claim');

  assert.equal(isKiroSessionCompacting('sess_claim'), true);
  assert.equal(isKiroSessionCompacting('sess_other'), false);
  assert.deepEqual(listKiroCompactions().filter((entry) => entry.sessionId === 'app-claim').length, 1);

  release();
  assert.equal(isKiroSessionCompacting('sess_claim'), false);
  assert.equal(listKiroCompactions().some((entry) => entry.sessionId === 'app-claim'), false);
});

test('a second compaction of the same session is refused with a 409', () => {
  const release = beginKiroCompaction('sess_twice', 'app-twice');
  try {
    assert.throws(
      () => beginKiroCompaction('sess_twice', 'app-twice'),
      (error: unknown) => (
        (error as { code?: string }).code === 'KIRO_COMPACT_IN_PROGRESS'
        && (error as { statusCode?: number }).statusCode === 409
      ),
    );
  } finally {
    release();
  }
});

test('releasing twice never frees a newer claim on the same session', () => {
  const first = beginKiroCompaction('sess_reclaim', 'app-reclaim');
  first();
  const second = beginKiroCompaction('sess_reclaim', 'app-reclaim');

  first();
  assert.equal(isKiroSessionCompacting('sess_reclaim'), true, 'a stale release must not free the new claim');

  second();
  assert.equal(isKiroSessionCompacting('sess_reclaim'), false);
});

test('different sessions can compact at the same time', () => {
  const releaseA = beginKiroCompaction('sess_a', 'app-a');
  const releaseB = beginKiroCompaction('sess_b', 'app-b');
  try {
    assert.equal(isKiroSessionCompacting('sess_a'), true);
    assert.equal(isKiroSessionCompacting('sess_b'), true);
  } finally {
    releaseA();
    releaseB();
  }
});

test('compacting a session that has not started is refused before anything is claimed', async () => {
  await assert.rejects(
    compactKiroSession('not-a-kiro-session'),
    (error: unknown) => (error as { code?: string }).code === 'KIRO_SESSION_NOT_STARTED',
  );
  assert.equal(listKiroCompactions().length, 0);
});

test('a second /compact on a session already compacting fails without a second claim', async () => {
  const release = beginKiroCompaction('sess_running', 'app-running');
  try {
    await assert.rejects(
      compactKiroSession('sess_running'),
      (error: unknown) => (error as { code?: string }).code === 'KIRO_COMPACT_IN_PROGRESS',
    );
    assert.equal(isKiroSessionCompacting('sess_running'), true, 'the first compaction keeps its claim');
  } finally {
    release();
  }
});

test('a chat turn sent while the session compacts is refused without starting Kiro', async () => {
  const release = beginKiroCompaction('sess_chat', 'app-chat');
  const messages: Array<Record<string, any>> = [];
  const ws = { send: (message: Record<string, any>) => { messages.push(message); } };
  const context = {
    resolveProviderSessionId: () => 'sess_chat',
    resolveResumeModel: async () => 'fake-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'fake-model' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  } as unknown as ProviderRuntimeContext;

  try {
    await kiroRuntime.run('hello', { cwd: process.cwd(), sessionId: 'app-chat' }, ws, context);
  } finally {
    release();
  }

  assert.match(messages.find((message) => message.kind === 'error')?.content ?? '', /compacting/i);
  const complete = messages.filter((message) => message.kind === 'complete');
  assert.equal(complete.length, 1);
  assert.equal(complete[0].exitCode, 1);
  assert.ok(!messages.some((message) => message.kind === 'session_created'), 'no Kiro process was started');
});
