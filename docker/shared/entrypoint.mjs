// First step of the standard image's entrypoint. Runs as root, makes the `agent`
// user match the host, drops root, then starts the rest of the chain.
//
//   node entrypoint.mjs [-- command args...]
//
// The image is built once with `agent` at uid/gid 1000, but a bind-mounted
// /workspace belongs to whoever runs Docker on the host. AGENT_UID / AGENT_GID
// (the deploy compose file sets them from the host user) say which ids `agent`
// must have at runtime, so users do not need to rebuild the image to match.
//
// 1. Started as non-root (docker run --user ...): nothing can be changed; the
//    command just runs.
// 2. AGENT_UID / AGENT_GID differ from the image's `agent`: the account's ids
//    are rewritten in /etc/passwd and /etc/group (not with usermod, which also
//    re-owns files under the home folder, host bind mounts included).
// 3. The data volumes keep the owner they were created with. Each one that is not
//    owned by the target ids is chowned, and so is the image's own content in the
//    home folder. /workspace and anything else a user bind-mounts is never walked:
//    it is the host's, and already belongs to the host user.
// 4. Root is dropped (supplementary groups, gid, uid, HOME) and the command
//    after `--` is started.
//
// JavaScript rather than shell so a CRLF checkout on Windows cannot break it.
import { spawn, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const USER_NAME = 'agent';
const HOME = '/home/agent';
// Walked recursively when their owner differs: the image's data volumes
// (docker-compose) and what the image installed under ~/.local (Kiro CLI).
const DATA_DIRS = [
  `${HOME}/.claude`,
  `${HOME}/.kiro`,
  `${HOME}/.cloudcli`,
  `${HOME}/.claude-code-ui`,
  `${HOME}/.local`,
  '/mise',
];
// Only the folder itself: users may bind-mount files into these.
const SHALLOW_DIRS = [HOME, `${HOME}/.ssh`, `${HOME}/.m2`];

const log = (message) => console.log(`[entrypoint] ${message}`);
const fail = (message) => {
  console.error(`[entrypoint] ERROR: ${message}`);
  process.exit(1);
};

/** uid/gid of the image's `agent` account, from /etc/passwd. */
function currentIds() {
  for (const line of readFileSync('/etc/passwd', 'utf8').split('\n')) {
    const [name, , uid, gid] = line.split(':');
    if (name === USER_NAME) return { uid: Number(uid), gid: Number(gid) };
  }
  return fail(`no "${USER_NAME}" account in /etc/passwd.`);
}

/** A numeric id from the environment, or `fallback` when it is unset or empty. */
function idFromEnv(name, fallback) {
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  if (!/^\d+$/.test(raw)) fail(`${name}="${raw}" is not a number.`);
  return Number(raw);
}

/** Rewrites the ids of the account/group named USER_NAME in /etc/passwd or /etc/group. */
function rewriteAccountFile(file, update) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const next = lines.map((line) => {
    const fields = line.split(':');
    if (fields[0] !== USER_NAME) return line;
    update(fields);
    return fields.join(':');
  });
  writeFileSync(`${file}.entrypoint`, next.join('\n'));
  renameSync(`${file}.entrypoint`, file);
}

function chown(target, uid, gid, { recursive }) {
  let stats;
  try {
    stats = lstatSync(target);
  } catch {
    return; // not there (a volume that is not mounted)
  }
  if (stats.uid === uid && stats.gid === gid) return;
  log(`Giving ${target} to ${uid}:${gid}.`);
  const args = ['-h', ...(recursive ? ['-R'] : []), `${uid}:${gid}`, target];
  const result = spawnSync('chown', args, { stdio: 'inherit' });
  // Not fatal: a read-only mount cannot be re-owned, and the app may not need it.
  if (result.status !== 0) console.warn(`[entrypoint] WARNING: could not change the owner of ${target}.`);
}

function becomeTargetUser() {
  const current = currentIds();
  const uid = idFromEnv('AGENT_UID', current.uid);
  const gid = idFromEnv('AGENT_GID', current.gid);
  if (uid === 0 || gid === 0) {
    fail(
      `AGENT_UID/AGENT_GID are ${uid}/${gid}: the agents must not run as root. Use the ids of a ` +
        'normal host user that owns the workspace folder, or leave them unset (1000).',
    );
  }

  if (uid !== current.uid || gid !== current.gid) {
    rewriteAccountFile('/etc/passwd', (fields) => {
      fields[2] = String(uid);
      fields[3] = String(gid);
    });
    rewriteAccountFile('/etc/group', (fields) => {
      fields[2] = String(gid);
    });
    log(`${USER_NAME} is now ${uid}:${gid} (was ${current.uid}:${current.gid}).`);
  }

  // Each directory is only walked when its owner differs, so a normal start does
  // nothing here and a volume of an earlier run with other ids is fixed once.
  for (const dir of SHALLOW_DIRS) chown(dir, uid, gid, { recursive: false });
  for (const entry of readdirSync(HOME, { withFileTypes: true })) {
    if (!entry.isDirectory()) chown(path.join(HOME, entry.name), uid, gid, { recursive: false });
  }
  for (const dir of DATA_DIRS) chown(dir, uid, gid, { recursive: true });
  // A volume mounted below another one (Kiro's data under ~/.local) keeps its own owner.
  chown(`${HOME}/.local/share/kiro-cli`, uid, gid, { recursive: true });

  process.initgroups(USER_NAME, gid);
  process.setgid(gid);
  process.setuid(uid);
  process.env.HOME = HOME;
  process.env.USER = USER_NAME;
  process.env.LOGNAME = USER_NAME;
}

if (process.getuid() === 0) {
  try {
    becomeTargetUser();
  } catch (error) {
    fail(error.message);
  }
}

const separator = process.argv.indexOf('--');
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
if (command.length > 0) {
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (error) => {
    console.error(`[entrypoint] Cannot start ${command[0]}: ${error.message}`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
