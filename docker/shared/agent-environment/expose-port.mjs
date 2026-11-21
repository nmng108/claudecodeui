// Makes an app running directly in this container reachable from the user's machine.
//
//   node expose-port.mjs <host-port> <app-port>          start (or replace) the forwarder
//   node expose-port.mjs <host-port> <app-port> stop     remove it
//
// Only the DIND_PORTS range reaches the user, and the daemon container publishes it, so
// an app in this container cannot be reached unless this service publishes its own port.
// This starts a small TCP forwarder container (alpine/socat) on the daemon that publishes
// <host-port> and relays to <app-port> in this container. The app must listen on 0.0.0.0.
//
// Written in JavaScript like the other scripts here, so a CRLF checkout cannot break it.
// Referenced from the note rendered by ../agent-environment.mjs (docker.md).
import { spawnSync } from 'node:child_process';
import dns from 'node:dns/promises';
import http from 'node:http';
import os from 'node:os';

const DEFAULT_DIND_PORTS = '7080-7089';
const FORWARDER_IMAGE = 'alpine/socat';

function fail(message) {
  console.error(`expose-port: ${message}`);
  process.exit(1);
}

/** Runs `docker` with an argument list (no shell). */
function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error) fail(`cannot run docker: ${result.error.message}`);
  return result;
}

function parseRange(text) {
  const [first, last = first] = text.split('-').map((part) => Number.parseInt(part.trim(), 10));
  if (!Number.isInteger(first) || !Number.isInteger(last) || first > last) {
    fail(`DIND_PORTS=${text} is not a port or a first-last range.`);
  }
  return { first, last };
}

/** Host name of the daemon in DOCKER_HOST (tcp://<host>:<port>). */
function daemonHost() {
  try {
    const url = new URL(process.env.DOCKER_HOST ?? '');
    if (url.protocol === 'tcp:' && url.hostname) return url.hostname;
  } catch {
    // Falls through to the error below.
  }
  return fail('DOCKER_HOST is not a tcp:// address, so there is no daemon container to publish ports.');
}

const toInt = (address) => address.split('.').reduce((sum, octet) => sum * 256 + Number(octet), 0);

/** This container's IPv4 address on the network it shares with the daemon container. */
function addressSharedWith(daemonAddress) {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const mask = toInt(entry.netmask);
      // `>>> 0` keeps the bitwise result unsigned.
      if (((toInt(entry.address) & mask) >>> 0) === ((toInt(daemonAddress) & mask) >>> 0)) {
        return entry.address;
      }
    }
  }
  return null;
}

/** Resolves with the HTTP status line's code, or rejects when nothing answers. */
function probe(host, port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: '/', timeout: 5000 }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
  });
}

const [hostPortArg, appPortArg, action = 'start'] = process.argv.slice(2);
const range = parseRange((process.env.DIND_PORTS || DEFAULT_DIND_PORTS).trim());
const hostPort = Number.parseInt(hostPortArg, 10);
const appPort = Number.parseInt(appPortArg, 10);
if (
  !Number.isInteger(hostPort) || hostPort < range.first || hostPort > range.last ||
  !Number.isInteger(appPort) || appPort < 1 || appPort > 65535 || !['start', 'stop'].includes(action)
) {
  fail(`usage: expose-port.mjs <host-port ${range.first}-${range.last}> <app-port> [stop]`);
}

const name = `cloudcli-expose-${hostPort}`;
const existing = docker(['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}']);
if (existing.status !== 0) fail(`docker failed: ${existing.stderr.trim()}`);
const ours = existing.stdout.trim() === name;

if (action === 'stop') {
  if (ours) docker(['rm', '-f', name]);
  console.log(ours ? `Removed ${name}.` : `${name} does not exist.`);
  process.exit(0);
}

if (ours) {
  docker(['rm', '-f', name]);
} else {
  // Never replace a container this script did not create.
  const running = docker(['ps', '--format', '{{.Names}} {{.Ports}}']).stdout.split('\n');
  const holder = running.find((line) => line.includes(`:${hostPort}->`));
  if (holder) fail(`host port ${hostPort} is already published by ${holder.split(' ')[0]}.`);
}

const dindHost = daemonHost();
const { address: dindAddress } = await dns.lookup(dindHost, { family: 4 }).catch((error) => {
  return fail(`cannot resolve ${dindHost}: ${error.message}`);
});
const selfAddress = addressSharedWith(dindAddress);
if (!selfAddress) fail(`this container has no address on the network of ${dindHost} (${dindAddress}).`);

const started = docker([
  'run', '-d', '--name', name, '-p', `${hostPort}:${hostPort}`, FORWARDER_IMAGE,
  `tcp-listen:${hostPort},fork,reuseaddr`, `tcp:${selfAddress}:${appPort}`,
]);
if (started.status !== 0) fail(`could not start the forwarder: ${started.stderr.trim()}`);
await new Promise((resolve) => setTimeout(resolve, 1500));

try {
  const status = await probe(dindHost, hostPort);
  console.log(`OK: http://localhost:${hostPort} -> ${selfAddress}:${appPort} (app answered HTTP ${status}).`);
} catch (error) {
  console.error(
    `expose-port: the forwarder is up, but nothing answered through it (${error.message}). ` +
    `Check that the app runs and listens on 0.0.0.0:${appPort}. Forwarder logs: docker logs ${name}`,
  );
  process.exit(1);
}
