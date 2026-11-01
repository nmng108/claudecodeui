import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveKiroEffort } from '@/modules/providers/list/kiro/kiro-runtime.provider.js';
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
  assert.equal(resolveKiroEffort('claude-sonnet-5.5', 'default', catalog), undefined);
  assert.equal(resolveKiroEffort('claude-sonnet-5.5', undefined, catalog), undefined);
  assert.equal(resolveKiroEffort('claude-sonnet-5.5', 42, catalog), undefined);
  assert.equal(resolveKiroEffort('auto', 'high', catalog), undefined, 'model without effort metadata');
  assert.equal(resolveKiroEffort('unknown', 'high', catalog), undefined);
  assert.equal(resolveKiroEffort(undefined, 'high', catalog), undefined);
});

test('Kiro advertises the agreed reasoning levels, weakest first', () => {
  const capabilities = providerCapabilitiesService.getProviderCapabilities('kiro');
  assert.equal(capabilities.supportsEffort, true);
  assert.deepEqual(capabilities.effortLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});
