import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveKiroEffort, shouldAutoApproveKiroPermission } from '@/modules/providers/list/kiro/kiro-runtime.provider.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';

const catalog = {
  DEFAULT: 'claude-sonnet-5.5',
  OPTIONS: [
    { value: 'auto', label: 'Auto' },
    {
      value: 'claude-sonnet-5.5',
      label: 'Claude Sonnet 5.5',
      effort: { values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] },
    },
  ],
};

test('resolveKiroEffort only sends a level the selected model declares', () => {
  assert.equal(resolveKiroEffort('claude-sonnet-5.5', 'high', catalog), 'high');
  assert.equal(resolveKiroEffort('claude-sonnet-5.5', 'max', catalog), undefined, 'level the model does not list');
  assert.equal(resolveKiroEffort('claude-sonnet-5.5', 42, catalog), 'medium', 'a non-string choice means the default');
  assert.equal(resolveKiroEffort('auto', 'high', catalog), undefined, 'model without effort metadata');
  assert.equal(resolveKiroEffort('unknown', 'high', catalog), undefined);
  assert.equal(resolveKiroEffort(undefined, 'high', catalog), undefined);
});

test('Kiro advertises the agreed reasoning levels, weakest first', () => {
  const capabilities = providerCapabilitiesService.getProviderCapabilities('kiro');
  assert.equal(capabilities.supportsEffort, true);
  assert.deepEqual(capabilities.effortLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('with no explicit choice Kiro starts at medium, as kiro-ui does', () => {
  assert.equal(resolveKiroEffort('claude-sonnet-5.5', undefined, catalog), 'medium');
  assert.equal(resolveKiroEffort('claude-sonnet-5.5', 'default', catalog), 'medium');
  assert.equal(resolveKiroEffort('claude-sonnet-5.5', '', catalog), 'medium');
  const noMedium = { OPTIONS: [{ value: 'm', label: 'm', effort: { values: [{ value: 'low' }, { value: 'high' }] } }], DEFAULT: 'm' };
  assert.equal(resolveKiroEffort('m', undefined, noMedium), undefined, 'a model without medium keeps its own default');
});

test('permission modes map onto what Kiro asks about', () => {
  // Always ask: default and plan never auto-approve.
  for (const capability of ['read', 'write', 'shell', 'web', undefined]) {
    assert.equal(shouldAutoApproveKiroPermission('default', capability), false, `default/${capability}`);
    assert.equal(shouldAutoApproveKiroPermission('plan', capability), false, `plan/${capability}`);
  }
  // Allow all.
  for (const capability of ['read', 'write', 'shell', 'web', undefined]) {
    assert.equal(shouldAutoApproveKiroPermission('bypassPermissions', capability), true, `bypass/${capability}`);
  }
  // Accept edits: reads and edits, but never shell, web or an unknown capability.
  assert.equal(shouldAutoApproveKiroPermission('acceptEdits', 'read'), true);
  assert.equal(shouldAutoApproveKiroPermission('acceptEdits', 'write'), true);
  assert.equal(shouldAutoApproveKiroPermission('acceptEdits', 'shell'), false);
  assert.equal(shouldAutoApproveKiroPermission('acceptEdits', 'web'), false);
  assert.equal(shouldAutoApproveKiroPermission('acceptEdits', undefined), false);
});
