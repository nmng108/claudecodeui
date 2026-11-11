import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildKiroRememberChoices,
  describeKiroAskedResource,
  readKiroConsent,
  resolveKiroRememberSelection,
} from '@/modules/providers/list/kiro/kiro-permission-choices.js';

const WITH_ALWAYS = [
  { optionId: 'accept', kind: 'allow_once' },
  { optionId: 'always-accept', kind: 'allow_always' },
  { optionId: 'reject', kind: 'reject_once' },
];

const patternsFor = (capability: string, resource: string, extra: Record<string, unknown> = {}) =>
  buildKiroRememberChoices({ capability, resource, ...extra }, WITH_ALWAYS).map((choice) => choice.pattern);

test('a shell command is offered exactly, by subcommand, by command and as the whole tool', () => {
  assert.deepEqual(patternsFor('shell', 'git stash pop'), ['git stash pop', 'git stash *', 'git *', '*']);
  assert.deepEqual(patternsFor('shell', 'cat /abc/file'), ['cat /abc/file', 'cat *', '*']);
  assert.deepEqual(patternsFor('shell', 'ls'), ['ls', '*'], 'a bare command has nothing to widen');
  assert.deepEqual(patternsFor('shell', 'git status'), ['git status', 'git *', '*'], 'the subcommand tier must differ from the command');
  assert.deepEqual(patternsFor('shell', 'npm run build -- --watch'), ['npm run build -- --watch', 'npm run *', 'npm *', '*']);
});

test('only the sub-command being asked about is generalised in a chain', () => {
  // `cat /abc/file | grep "123"` is asked as two requests; this is the first.
  assert.deepEqual(
    patternsFor('shell', 'cat /abc/file | grep "123"', { triggeringResource: 'cat /abc/file' }),
    ['cat /abc/file', 'cat *', '*'],
  );
  assert.equal(describeKiroAskedResource({ resource: 'a | b', triggeringResource: 'a' }), 'a');
  assert.equal(describeKiroAskedResource({ resource: 'ls' }), 'ls');
  assert.equal(describeKiroAskedResource(undefined), undefined);
});

test('no wildcard is offered for wrappers, assignments or shell syntax', () => {
  assert.deepEqual(patternsFor('shell', 'sudo rm -rf build'), ['sudo rm -rf build', '*']);
  assert.deepEqual(patternsFor('shell', 'env FOO=1 make test'), ['env FOO=1 make test', '*']);
  assert.deepEqual(patternsFor('shell', 'FOO=1 make test'), ['FOO=1 make test', '*']);
  assert.deepEqual(patternsFor('shell', 'cat a > b'), ['cat a > b', '*']);
  assert.deepEqual(patternsFor('shell', 'cat $(rm x)'), ['cat $(rm x)', '*']);
  assert.deepEqual(patternsFor('shell', 'rm *.log'), ['rm *', '*'], 'a command that already holds a wildcard is not offered as exact');
});

test('a file is offered exactly, by folder and as the whole tool', () => {
  assert.deepEqual(patternsFor('fs_write', 'src/app/main.ts'), ['src/app/main.ts', 'src/app/**', '*']);
  assert.deepEqual(patternsFor('fs_write', 'x.txt'), ['x.txt', '*'], 'a top-level file has no folder');
  assert.deepEqual(patternsFor('fs_read', '/etc/hostname'), ['/etc/hostname', '/etc/**', '*']);
});

test('other capabilities are offered exactly and as the whole tool', () => {
  assert.deepEqual(patternsFor('web_fetch', 'https://example.com/a'), ['https://example.com/a', '*']);
  assert.deepEqual(buildKiroRememberChoices({ capability: 'mcp' }, WITH_ALWAYS).map((c) => c.pattern), ['*']);
});

test('nothing is offered when Kiro would not save the rule', () => {
  const consent = { capability: 'shell', resource: 'ls -la' };
  const withoutAlways = WITH_ALWAYS.filter((option) => option.kind !== 'allow_always');
  assert.deepEqual(buildKiroRememberChoices(consent, withoutAlways), []);
  assert.deepEqual(buildKiroRememberChoices({ ...consent, askType: 'explicit' }, WITH_ALWAYS), []);
  assert.deepEqual(buildKiroRememberChoices({ ...consent, persistableConsent: false }, WITH_ALWAYS), []);
  assert.deepEqual(buildKiroRememberChoices({ resource: 'ls -la' }, WITH_ALWAYS), [], 'no capability to attach a rule to');
  assert.deepEqual(buildKiroRememberChoices(undefined, WITH_ALWAYS), []);
});

test('a selection resolves only to a choice that was offered, at a scope Kiro supports', () => {
  const choices = buildKiroRememberChoices({ capability: 'shell', resource: 'cat a' }, WITH_ALWAYS);

  assert.deepEqual(resolveKiroRememberSelection(choices, { choiceId: 'command', scope: 'user' }, WITH_ALWAYS), {
    optionId: 'always-accept',
    consent: { scope: 'user', resource: 'cat *' },
  });
  for (const scope of ['session', 'workspace', 'user']) {
    assert.ok(resolveKiroRememberSelection(choices, { choiceId: 'tool', scope }, WITH_ALWAYS), scope);
  }
  assert.equal(resolveKiroRememberSelection(choices, { choiceId: 'command', scope: 'invocation' }, WITH_ALWAYS), null);
  assert.equal(resolveKiroRememberSelection(choices, { choiceId: 'rm *', scope: 'user' }, WITH_ALWAYS), null);
  assert.equal(resolveKiroRememberSelection(choices, undefined, WITH_ALWAYS), null);
  assert.equal(
    resolveKiroRememberSelection(choices, { choiceId: 'tool', scope: 'user' }, WITH_ALWAYS.filter((o) => o.kind !== 'allow_always')),
    null,
  );
});

test('readKiroConsent keeps only well-typed fields', () => {
  assert.deepEqual(
    readKiroConsent({ _meta: { kiro: { consent: { capability: 'shell', resource: 5, triggeringResource: 'ls', askType: 'implicit', persistableConsent: 'no' } } } }),
    { capability: 'shell', resource: undefined, triggeringResource: 'ls', askType: 'implicit' },
  );
  assert.equal(readKiroConsent({}), undefined);
});
