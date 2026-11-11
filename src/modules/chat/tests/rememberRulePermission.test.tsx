import assert from 'node:assert/strict';

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import type { PendingPermissionRequest } from '@/shared/types';
import '@/modules/i18n';
import PermissionRequestsBanner from '@/modules/chat/composer/PermissionRequestsBanner';

afterEach(cleanup);

/** What Kiro sends for the first half of `cat /abc/file | grep "123"`. */
const KIRO_REQUEST: PendingPermissionRequest = {
  requestId: 'tool-1',
  toolName: 'cat /abc/file | grep "123"',
  capability: 'shell',
  askedResource: 'cat /abc/file',
  rememberChoices: [
    { id: 'exact', kind: 'exact', pattern: 'cat /abc/file' },
    { id: 'command', kind: 'command', pattern: 'cat *' },
    { id: 'tool', kind: 'tool', pattern: '*' },
  ],
  rememberScopes: ['session', 'workspace', 'user'],
};

const renderBanner = (request: PendingPermissionRequest) => {
  const onDecision = vi.fn();
  const view = render(
    <PermissionRequestsBanner
      pendingPermissionRequests={[request]}
      handlePermissionDecision={onDecision}
      handleGrantToolPermission={vi.fn(() => ({ success: true }))}
    />,
  );
  return { ...view, onDecision };
};

test('Allow once and Deny answer without saving anything', () => {
  const { getByText, onDecision } = renderBanner(KIRO_REQUEST);

  assert.ok(getByText('cat /abc/file'), 'shows the sub-command being asked about');
  fireEvent.click(getByText('Allow once'));
  assert.deepEqual(onDecision.mock.calls[0], ['tool-1', { allow: true }]);

  fireEvent.click(getByText('Deny'));
  assert.equal(onDecision.mock.calls[1][1].allow, false);
});

test('Always allow offers every pattern and scope, starting on the narrowest', () => {
  const { getByText, getAllByRole, onDecision } = renderBanner(KIRO_REQUEST);

  fireEvent.click(getByText('Always allow…'));
  for (const text of ['Only this one', 'This command with any arguments', 'Entire tool (shell)', 'cat *', 'This session', 'This workspace', 'All workspaces']) {
    assert.ok(getByText(text), text);
  }
  const radios = getAllByRole('radio') as HTMLInputElement[];
  assert.deepEqual(radios.map((radio) => radio.checked), [true, false, false, true, false, false]);

  fireEvent.click(getByText('Allow & remember'));
  assert.deepEqual(onDecision.mock.calls[0], [
    'tool-1',
    { allow: true, rememberChoice: { choiceId: 'exact', scope: 'session' } },
  ]);
});

test('the picked pattern and scope are what is sent', () => {
  const { getByText, onDecision } = renderBanner(KIRO_REQUEST);

  fireEvent.click(getByText('Always allow…'));
  fireEvent.click(getByText('This command with any arguments'));
  fireEvent.click(getByText('All workspaces'));
  fireEvent.click(getByText('Allow & remember'));

  assert.deepEqual(onDecision.mock.calls[0][1], { allow: true, rememberChoice: { choiceId: 'command', scope: 'user' } });
});

test('Back closes the picker without answering', () => {
  const { getByText, queryByText, onDecision } = renderBanner(KIRO_REQUEST);

  fireEvent.click(getByText('Always allow…'));
  fireEvent.click(getByText('Back'));

  assert.ok(getByText('Allow once'));
  assert.equal(queryByText('Allow & remember'), null);
  assert.equal(onDecision.mock.calls.length, 0);
});

test('a request with no rules to save keeps the standard prompt', () => {
  const { queryByText, getByText } = renderBanner({ requestId: 'r', toolName: 'Bash', input: { command: 'ls' } });

  assert.equal(queryByText('Always allow…'), null);
  assert.ok(getByText('Allow once'));
  assert.ok(getByText('Allow & remember'));
});

test('a Kiro request it will not remember offers only Allow once and Deny', () => {
  const { queryByText, getByText } = renderBanner({
    requestId: 'r',
    toolName: 'Run a command',
    capability: 'shell',
    askedResource: 'rm -rf build',
    rememberChoices: [],
    rememberScopes: [],
  });

  assert.equal(queryByText('Always allow…'), null);
  assert.equal(queryByText('Allow & remember'), null);
  assert.ok(getByText('rm -rf build'));
  assert.ok(getByText('Allow once'));
  assert.ok(getByText('Deny'));
});
