import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPluginEnv } from '../plugin-process.service.js';

const HOST_ENV = {
  PATH: '/usr/bin',
  HOME: '/home/agent',
  KIRO_API_KEY: 'secret',
  DOCKER_HOST: 'tcp://dind:2376',
  SSH_AUTH_SOCK: '/run/ssh/agent.sock',
};

test('a plugin server gets only the essentials by default', () => {
  const env = buildPluginEnv('terminal', HOST_ENV);

  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/agent',
    NODE_ENV: 'production',
    PLUGIN_NAME: 'terminal',
  });
});

test('only the variables named in CLOUDCLI_PLUGIN_ENV_PASSTHROUGH are forwarded', () => {
  const env = buildPluginEnv('terminal', {
    ...HOST_ENV,
    CLOUDCLI_PLUGIN_ENV_PASSTHROUGH: 'DOCKER_HOST, SSH_AUTH_SOCK,MISSING_VAR',
  });

  assert.equal(env.DOCKER_HOST, 'tcp://dind:2376');
  assert.equal(env.SSH_AUTH_SOCK, '/run/ssh/agent.sock');
  assert.equal('MISSING_VAR' in env, false);
  assert.equal('KIRO_API_KEY' in env, false);
  assert.equal('CLOUDCLI_PLUGIN_ENV_PASSTHROUGH' in env, false);
});

test('the passthrough list cannot override the essentials or smuggle in malformed names', () => {
  const env = buildPluginEnv('terminal', {
    ...HOST_ENV,
    NODE_ENV: 'development',
    CLOUDCLI_PLUGIN_ENV_PASSTHROUGH: 'PLUGIN_NAME,PATH,HOME,NODE_ENV,bad name!,=X,1ABC',
  });

  assert.equal(env.PLUGIN_NAME, 'terminal');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/agent');
  assert.equal(env.NODE_ENV, 'development');
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'NODE_ENV', 'PATH', 'PLUGIN_NAME']);
});
