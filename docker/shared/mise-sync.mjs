// Keeps the language runtimes in /mise (the mise data volume) in step with the
// list shipped in the image, without touching what users installed themselves.
//
//   node mise-sync.mjs [-- command args...]
//
// 1. `mise install` installs what the image's list (system config,
//    /etc/mise/config.toml) and the user's config (/mise/config.toml, written
//    by `mise use -g`) ask for and is missing. Already installed: no-op.
// 2. Versions that an earlier start installed for the image's list but that the
//    list no longer asks for are uninstalled, unless the user's config still
//    requests them. Versions only a user installed were never in the record
//    and are left alone.
// 3. The command after `--` is started (the app). Failures above are logged
//    and never stop it, so a container without network access still starts.
//
// JavaScript rather than shell so a CRLF checkout on Windows cannot break it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dataDir = process.env.MISE_DATA_DIR || '/mise';
const systemConfig = path.join(process.env.MISE_SYSTEM_CONFIG_DIR || '/etc/mise', 'config.toml');
const recordFile = path.join(dataDir, '.managed-tools.json');
const log = (message) => console.log(`[mise-sync] ${message}`);
const warn = (message) => console.warn(`[mise-sync] WARNING: ${message}`);

/** Every installed tool version as `{ tool, version, source }`; `source` is the config file requesting it, if any. */
function listInstalled() {
  // Run from `/` so a mise.toml in the current project directory does not count.
  const result = spawnSync('mise', ['ls', '--json'], { cwd: '/', encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`mise ls failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  const installed = [];
  for (const [tool, versions] of Object.entries(JSON.parse(result.stdout || '{}'))) {
    for (const entry of versions) {
      if (entry.installed) {
        installed.push({ tool, version: entry.version, source: entry.source?.path ?? null });
      }
    }
  }
  return installed;
}

const toolId = ({ tool, version }) => `${tool}@${version}`;

function readRecord() {
  try {
    const parsed = JSON.parse(readFileSync(recordFile, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function writeRecord(ids) {
  mkdirSync(dataDir, { recursive: true });
  const temporaryFile = `${recordFile}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify([...ids].sort(), null, 2)}\n`);
  renameSync(temporaryFile, recordFile); // atomic: a crash never leaves a half-written record
}

function sync() {
  if (!existsSync(systemConfig)) {
    log(`No ${systemConfig}; nothing to install.`);
    return;
  }

  const install = spawnSync('mise', ['install'], { stdio: 'inherit' });
  if (install.status !== 0) {
    warn('mise install failed (no network?). Some languages may be missing; continuing.');
  }

  const installed = listInstalled();
  const current = new Set(installed.filter((item) => item.source === systemConfig).map(toolId));
  const bySource = new Map(installed.map((item) => [toolId(item), item.source]));

  // Only ever remove what the image's list put there at an earlier start.
  for (const id of readRecord()) {
    if (current.has(id) || !bySource.has(id)) continue; // still wanted, or already gone
    if (bySource.get(id) !== null) {
      log(`Keeping ${id}: still requested by ${bySource.get(id)}.`);
      continue; // now the user's: no longer tracked as the image's
    }
    log(`Removing ${id}: no longer in the image's language list.`);
    const removal = spawnSync('mise', ['uninstall', id], { stdio: 'inherit' });
    if (removal.status !== 0) {
      warn(`Could not remove ${id}.`);
      current.add(id); // retry at the next start
    }
  }

  writeRecord(current);
}

try {
  sync();
} catch (error) {
  warn(`${error.message}. Continuing without syncing languages.`);
}

const separator = process.argv.indexOf('--');
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
if (command.length > 0) {
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (error) => {
    console.error(`[mise-sync] Cannot start ${command[0]}: ${error.message}`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}