// ssh-agent sidecar: holds the SSH private key and serves it to the app through a
// socket, so the app and the AI agents next to it can authenticate with the key
// without being able to read it.
//
//   serve   (default) start ssh-agent and the control API
//   rotate  replace a key this service generated, then reload the agent
//   health  exit 0 when the control API answers
//
// See docs/ssh-keys.md. The key logic is shared with the app (ssh-key-core.ts).
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

import { createAgentFilterProxy } from './ssh-agent-proxy.ts';
import { createControlHandler, createSshKeyCore, KEY_FILE_NAMES } from './ssh-key-core.ts';

const KEYS_DIR = process.env.SSH_KEYS_DIR || '/keys';
const RUN_DIR = process.env.SSH_RUN_DIR || '/run/ssh';
// The real agent listens on a private socket (ssh-agent serves only its own user and offers every
// request). The shared socket is a filtering proxy in front of it.
const REAL_AGENT_SOCKET = process.env.SSH_REAL_AGENT_SOCKET || '/tmp/ssh-agent.sock';
const AGENT_SOCKET = path.join(RUN_DIR, 'agent.sock');
const CONTROL_SOCKET = path.join(RUN_DIR, 'control.sock');
const WATCHDOG_INTERVAL_MS = 30_000;

const agentEnv = { ...process.env, SSH_AUTH_SOCK: REAL_AGENT_SOCKET, SSH_ASKPASS_REQUIRE: 'never' };
const core = createSshKeyCore({ sshDirectory: KEYS_DIR, providerName: 'agent' });

const log = (message) => console.log(`[ssh-agent] ${message}`);

function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { env: agentEnv, timeout: 15_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Adds every key file in the keys directory to the agent. */
async function loadKeys() {
  for (const name of KEY_FILE_NAMES) {
    const file = path.join(KEYS_DIR, name);
    if (!(await exists(file))) continue;
    const added = await run('ssh-add', [file]);
    if (added.code === 0) {
      log(`loaded ${name}`);
    } else {
      // Typically a passphrase-protected key: it cannot be unlocked unattended.
      log(`could not load ${name}: ${added.stderr.trim() || `exit ${added.code}`}`);
    }
  }
}

async function reloadKeys() {
  await run('ssh-add', ['-D']);
  await loadKeys();
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await exists(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function serve() {
  await fs.rm(REAL_AGENT_SOCKET, { force: true });
  await fs.rm(AGENT_SOCKET, { force: true });
  await fs.rm(CONTROL_SOCKET, { force: true });

  const agent = spawn('ssh-agent', ['-D', '-a', REAL_AGENT_SOCKET], { stdio: ['ignore', 'ignore', 'inherit'] });
  agent.on('exit', (code) => {
    log(`ssh-agent exited (${code}); stopping so the container restarts`);
    process.exit(1);
  });
  if (!(await waitForFile(REAL_AGENT_SOCKET, 5000))) {
    log('ssh-agent did not create its socket');
    process.exit(1);
  }
  await loadKeys();

  // Clients may list public keys and ask for signatures; nothing else reaches the agent.
  const proxy = createAgentFilterProxy({ connectUpstream: () => net.connect(REAL_AGENT_SOCKET) });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(AGENT_SOCKET, resolve);
  });
  // The app container reaches the socket through the group.
  await fs.chmod(AGENT_SOCKET, 0o660);

  const server = http.createServer(createControlHandler({ core, onKeyChanged: reloadKeys }));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(CONTROL_SOCKET, resolve);
  });
  await fs.chmod(CONTROL_SOCKET, 0o660);
  log(`ready: agent ${AGENT_SOCKET} (filtered), control ${CONTROL_SOCKET}`);

  // Belt and braces: the proxy blocks removal, but if the agent ever loses its identities, put them back.
  setInterval(async () => {
    const listed = await run('ssh-add', ['-l']);
    if (listed.code === 1) await loadKeys();
  }, WATCHDOG_INTERVAL_MS).unref();

  const stop = () => {
    agent.removeAllListeners('exit');
    agent.kill();
    proxy.close();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

async function rotate() {
  const current = await core.getKey();
  if (current.status === 'missing') {
    console.error('There is no key to rotate. Generate one from Settings > Git first.');
    process.exit(1);
  }
  let info;
  try {
    info = await core.generateKey({ replace: true });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  await reloadKeys();
  console.log('Key replaced. Add the new public key to your git servers and remove the old one:');
  console.log(`\n${info.publicKey}\n\n${info.fingerprint}`);
}

function health() {
  const request = http.request({ socketPath: CONTROL_SOCKET, path: '/health', timeout: 3000 }, (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  });
  request.on('error', () => process.exit(1));
  request.on('timeout', () => process.exit(1));
  request.end();
}

const command = process.argv[2] || 'serve';
if (command === 'serve') await serve();
else if (command === 'rotate') await rotate();
else if (command === 'health') health();
else {
  console.error(`Unknown command: ${command}`);
  process.exit(2);
}