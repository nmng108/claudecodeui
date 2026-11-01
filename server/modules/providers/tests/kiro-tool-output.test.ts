import assert from 'node:assert/strict';
import test from 'node:test';

import { acpContentToText, buildKiroToolResult } from '@/modules/providers/list/kiro/kiro-tool-output.js';

test('buildKiroToolResult ignores updates for tools that have not finished', () => {
  assert.equal(buildKiroToolResult({ status: 'pending' }), null);
  assert.equal(buildKiroToolResult({ status: 'in_progress', rawOutput: 'partial' }), null);
  assert.equal(buildKiroToolResult({}), null);
});

test('buildKiroToolResult always returns string content, even with no output', () => {
  assert.deepEqual(buildKiroToolResult({ status: 'completed' }), {
    content: '',
    isError: false,
    toolResult: { content: '' },
  });
  assert.equal(buildKiroToolResult({ status: 'completed', rawOutput: null })?.content, '');
});

test('buildKiroToolResult prefers the ACP content blocks, then rawOutput', () => {
  const block = [{ type: 'content', content: { type: 'text', text: 'from block' } }];
  assert.equal(buildKiroToolResult({ status: 'completed', rawOutput: 'out' })?.content, 'out');
  assert.equal(buildKiroToolResult({ status: 'completed', rawOutput: { a: 1 } })?.content, '{"a":1}');
  assert.equal(buildKiroToolResult({ status: 'completed', content: block })?.content, 'from block');
  assert.equal(buildKiroToolResult({ status: 'completed', content: block, rawOutput: 'raw' })?.content, 'from block');
  // A Kiro tool object: the readable message is used, not the JSON.
  assert.equal(
    buildKiroToolResult({ status: 'completed', rawOutput: { output: 'hi', exitCode: 0, message: 'Output:\nhi' } })?.content,
    'Output:\nhi',
  );
});
test('buildKiroToolResult marks failed tools as errors', () => {
  const result = buildKiroToolResult({ status: 'failed', rawOutput: 'boom' });
  assert.equal(result?.isError, true);
  assert.equal(result?.content, 'boom');
});

test('acpContentToText flattens text and diff blocks and ignores junk', () => {
  assert.equal(
    acpContentToText([
      { type: 'content', content: { type: 'text', text: 'a' } },
      { type: 'diff', path: 'x.ts' },
      null,
      'junk',
      { type: 'text', text: 'b' },
    ]),
    'a\nEdited x.ts\nb',
  );
  assert.equal(acpContentToText(undefined), '');
});
