import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KiroSessionsProvider,
  normalizeKiroTranscriptLines,
} from '@/modules/providers/list/kiro/kiro-sessions.provider.js';
import {
  kiroMessageLine,
  withKiroHome,
  writeKiroSession,
} from '@/modules/providers/tests/fixtures/kiro-home.js';

const SESSION_ID = 'sess_4c480f3b-074f-4960-8401-abe0a696740e';
const WORKSPACE = 'c:\\users\\admin\\.kiro-ui\\workspace';

const lines = (...rows: Array<Record<string, unknown> | string>): string[] =>
  rows.map((row) => (typeof row === 'string' ? row : JSON.stringify(row)));

test('transcript lines become user, assistant, thinking and tool messages', () => {
  const messages = normalizeKiroTranscriptLines(lines(
    kiroMessageLine('m0', { type: 'agent_note', content: 'injected context' }),
    kiroMessageLine('m1', { type: 'turn_start', executionId: 'e1' }),
    kiroMessageLine('m2', { type: 'user', content: 'list the files', source: 'chat' }),
    kiroMessageLine('m3', { type: 'assistant', operationType: 'Reasoning', content: 'I should call shell' }),
    kiroMessageLine('m4', { type: 'tool_call', toolCallId: 't1', toolName: 'shell', args: { command: 'ls' }, status: 'approved' }),
    kiroMessageLine('m5', { type: 'pending_interaction', toolCallId: 't1' }),
    kiroMessageLine('m6', { type: 'interaction_resolved', toolCallId: 't1' }),
    kiroMessageLine('m7', { type: 'tool_result', toolCallId: 't1', content: 'a.txt\nb.txt', success: true }),
    kiroMessageLine('m8', { type: 'assistant', operationType: 'Say', content: 'Two files.', reasoningModelId: 'claude-sonnet-5.5' }),
    kiroMessageLine('m9', { type: 'usage_summary', elapsedTime: 12 }),
    kiroMessageLine('m10', { type: 'turn_end', stopReason: 'end_turn' }),
  ), SESSION_ID);

  assert.deepEqual(
    messages.map((message) => message.kind),
    ['text', 'thinking', 'tool_use', 'text'],
  );
  assert.deepEqual(
    [messages[0].role, messages[0].content],
    ['user', 'list the files'],
  );
  assert.equal(messages[1].content, 'I should call shell');
  assert.equal(messages[2].toolName, 'shell');
  assert.deepEqual(messages[2].toolInput, { command: 'ls' });
  assert.equal(messages[2].toolId, 't1');
  assert.deepEqual(messages[2].toolResult, { content: 'a.txt\nb.txt', isError: false });
  assert.equal(messages[3].role, 'assistant');
  assert.equal(messages[3].model, 'claude-sonnet-5.5');

  assert.equal(new Set(messages.map((message) => message.id)).size, messages.length, 'ids are unique');
  assert.ok(messages.every((message) => message.provider === 'kiro' && message.sessionId === SESSION_ID));
});

test('a failed tool result is marked as an error and an orphan result stays visible', () => {
  const messages = normalizeKiroTranscriptLines(lines(
    kiroMessageLine('a', { type: 'tool_call', toolCallId: 't1', toolName: 'write', args: {} }),
    kiroMessageLine('b', { type: 'tool_result', toolCallId: 't1', content: 'denied', success: false }),
    kiroMessageLine('c', { type: 'tool_result', toolCallId: 'unknown', content: { detail: 1 }, success: true }),
  ), SESSION_ID);

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].toolResult, { content: 'denied', isError: true });
  assert.equal(messages[1].kind, 'tool_result');
  assert.equal(messages[1].toolResult?.content, '{"detail":1}');
});

test('blank, malformed and half-written lines are skipped without throwing', () => {
  const messages = normalizeKiroTranscriptLines(lines(
    '',
    'not json',
    '[1,2]',
    kiroMessageLine('a', { type: 'user', content: '   ' }),
    kiroMessageLine('b', { type: 'assistant', operationType: 'Say', content: '' }),
    kiroMessageLine('c', { type: 'user', content: 'kept' }),
    '{"id":"d","timestamp":"2026-11-01T10:00:00.000Z","payload":{"type":"assis',
  ), SESSION_ID);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'kept');
});

const writeHistorySession = async (homeDir: string, count: number) => {
  await writeKiroSession(homeDir, {
    id: SESSION_ID,
    workspacePath: WORKSPACE,
    messages: Array.from({ length: count }, (_, index) =>
      kiroMessageLine(`m${index}`, { type: 'user', content: `message ${index}` })),
  });
};

test('fetchHistory pages from the newest messages and reports totals', async () => {
  await withKiroHome(async (homeDir) => {
    await writeHistorySession(homeDir, 5);
    const provider = new KiroSessionsProvider();

    const all = await provider.fetchHistory(SESSION_ID);
    assert.equal(all.total, 5);
    assert.equal(all.messages.length, 5);
    assert.equal(all.hasMore, false);
    assert.equal(all.limit, null);

    const newest = await provider.fetchHistory(SESSION_ID, { limit: 2 });
    assert.deepEqual(newest.messages.map((message) => message.content), ['message 3', 'message 4']);
    assert.equal(newest.hasMore, true);
    assert.equal(newest.offset, 0);
    assert.equal(newest.limit, 2);

    const older = await provider.fetchHistory(SESSION_ID, { limit: 2, offset: 2 });
    assert.deepEqual(older.messages.map((message) => message.content), ['message 1', 'message 2']);
    assert.equal(older.hasMore, true);

    const oldest = await provider.fetchHistory(SESSION_ID, { limit: 2, offset: 4 });
    assert.deepEqual(oldest.messages.map((message) => message.content), ['message 0']);
    assert.equal(oldest.hasMore, false);

    const none = await provider.fetchHistory(SESSION_ID, { limit: 0 });
    assert.deepEqual(none.messages, []);
    assert.equal(none.total, 5);
    assert.equal(none.limit, 0);
  });
});

test('fetchHistory resolves the Kiro id from providerSessionId and rejects unsafe ids', async () => {
  await withKiroHome(async (homeDir) => {
    await writeHistorySession(homeDir, 2);
    const provider = new KiroSessionsProvider();

    const viaProviderId = await provider.fetchHistory('app-session-id', { providerSessionId: SESSION_ID });
    assert.equal(viaProviderId.total, 2);
    assert.ok(viaProviderId.messages.every((message) => message.sessionId === 'app-session-id'));

    for (const unsafe of ['../../etc/passwd', 'sess_..\\..\\x', 'missing', 'sess_does-not-exist', '']) {
      const result = await provider.fetchHistory(unsafe);
      assert.deepEqual(result.messages, [], unsafe);
      assert.equal(result.total, 0, unsafe);
    }
  });
});

test('fetchHistory returns nothing when the session has no transcript yet', async () => {
  await withKiroHome(async (homeDir) => {
    await writeKiroSession(homeDir, { id: SESSION_ID, workspacePath: WORKSPACE });
    const result = await new KiroSessionsProvider().fetchHistory(SESSION_ID);
    assert.equal(result.total, 0);
  });
});

test('normalizeMessage passes already-normalized events through and drops the rest', () => {
  const provider = new KiroSessionsProvider();
  const normalized = { id: '1', kind: 'status', sessionId: 's', timestamp: 't', provider: 'kiro' };
  assert.deepEqual(provider.normalizeMessage(normalized, 's'), [normalized]);
  assert.deepEqual(provider.normalizeMessage({ type: 'agent_message_chunk' }, 's'), []);
  assert.deepEqual(provider.normalizeMessage(null, 's'), []);
});
