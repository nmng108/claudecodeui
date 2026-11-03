// Start script for the development container (docker/dev/Dockerfile).
//
// Written in JavaScript rather than shell on purpose: this file is read from
// the bind-mounted repository, and a shell script checked out with CRLF line
// endings on Windows would not run in the Linux container.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const MANIFEST = 'package.json';
const LOCKFILE = 'package-lock.json';
// Lives in the node_modules volume, so a fresh volume always triggers an install.
const STAMP = 'node_modules/.docker-dev-deps-hash';

const readIfExists = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

function dependenciesHash() {
  return createHash('sha256')
    .update(readIfExists(MANIFEST))
    .update(readIfExists(LOCKFILE))
    .digest('hex');
}

function installDependencies() {
  console.log('[dev] Installing dependencies (first start, or package*.json changed)...');
  const lockBefore = readIfExists(LOCKFILE);

  // `npm ci` would delete node_modules, which fails (EBUSY) because it is a
  // volume mount point, so `npm install` is used. With an in-sync lockfile it
  // installs exactly the locked versions.
  const result = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { stdio: 'inherit' });
  if (result.status !== 0) {
    console.error('[dev] npm install failed.');
    process.exit(result.status ?? 1);
  }

  // The lockfile is part of the host working tree; never leave it modified by the container.
  if (lockBefore && readIfExists(LOCKFILE) !== lockBefore) {
    writeFileSync(LOCKFILE, lockBefore);
    console.log(`[dev] Restored ${LOCKFILE} (the install would have rewritten it).`);
  }
}

// The language runtimes were installed at image build time into the dev-mise-data
// volume, so a changed docker/mise.toml is picked up here without a rebuild
// (a no-op when everything is already installed). A failure does not stop the app.
const mise = spawnSync('mise', ['install'], { stdio: 'inherit' });
if (mise.status !== 0) {
  console.warn('[dev] mise install failed; continuing without the missing runtimes.');
}

const expectedHash = dependenciesHash();
if (readIfExists(STAMP) !== expectedHash) {
  installDependencies();
  writeFileSync(STAMP, expectedHash);
}

console.log(`[dev] UI:  http://localhost:${process.env.VITE_PORT || 5173}`);
console.log(`[dev] API: http://localhost:${process.env.SERVER_PORT || 3001}`);

// `server:dev-watch` restarts the API server when server files change; `client` is Vite with HMR.
const child = spawn(
  'npx',
  [
    'concurrently',
    '--kill-others',
    '--names', 'server,client',
    'npm run server:dev-watch',
    'npm run client',
  ],
  { stdio: 'inherit' },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
