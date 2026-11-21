// Tells the agent CLIs how Docker works in this container, in the global instruction
// file each one reads. Without it an agent assumes `docker` is the host's, that
// `localhost` reaches what it publishes, and that any port is visible to the user.
//
//   node agent-environment.mjs [-- command args...]
//
// Runs at every container start (the instruction locations are volumes, so a copy baked
// into the image would never reach an existing one). It renders
// agent-environment/docker.md with this container's DOCKER_HOST and DIND_PORTS, then:
//   - Kiro:        owns ~/.kiro/steering/cloudcli-docker.md.
//   - Claude Code: owns a marked block in ~/.claude/CLAUDE.md.
//   - Codex:       the same in ~/.codex/AGENTS.md, only if ~/.codex exists.
//   - OpenCode:    the same in ~/.config/opencode/AGENTS.md, only if that file exists.
//                  It is not created: OpenCode reads ~/.claude/CLAUDE.md when it has none.
//   - Cursor has no global instruction file, so it gets nothing.
// Content outside the marked block is never touched. With DOCKER_HOST unset the block
// and the Kiro file are removed. Failures are logged and never stop the command.
//
// JavaScript rather than shell so a CRLF checkout on Windows cannot break it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const log = (message) => console.log(`[agent-environment] ${message}`);
const warn = (message) => console.warn(`[agent-environment] WARNING: ${message}`);

const templateFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'agent-environment',
  'docker.md',
);
const BEGIN = '<!-- cloudcli:docker-environment:begin (managed by CloudCLI, rewritten when the container starts) -->';
const END = '<!-- cloudcli:docker-environment:end -->';
// The forwarder script the note points the agent at. It sits next to docker.md, so the path
// is right both in the image (/usr/local/lib/cloudcli) and when run from the repository (dev).
const exposeScript = path.join(path.dirname(templateFile), 'expose-port.mjs');
const DEFAULT_DIND_PORTS = '7080-7089';

const readIfExists = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

/** Whether the Docker daemon at DOCKER_HOST answers right now. */
function daemonAnswers() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 15_000 });
  return result.status === 0;
}

/** The note for this container, or null when it has no Docker to describe. */
function renderNote(env) {
  const dockerHost = env.DOCKER_HOST;
  if (!dockerHost) return null;

  let dindHost;
  try {
    const url = new URL(dockerHost);
    dindHost = url.protocol === 'tcp:' ? url.hostname : '';
  } catch {
    dindHost = '';
  }
  if (!dindHost) {
    warn(`DOCKER_HOST=${dockerHost} is not a tcp:// address; no Docker note written.`);
    return null;
  }

  const ports = (env.DIND_PORTS || DEFAULT_DIND_PORTS).trim();
  const status = daemonAnswers()
    ? 'Status when the container started: the daemon answered.'
    : 'Status when the container started: no daemon answered. The Docker daemon is an optional ' +
      'compose profile and is off by default. Run `docker info` to check. If it still fails, ask the ' +
      'user to enable the `docker` profile (docs/docker-in-docker.md in the CloudCLI repository). ' +
      'Do not try to start a Docker daemon yourself.';

  const values = {
    STATUS: status,
    DOCKER_HOST: dockerHost,
    DIND_HOST: dindHost,
    DIND_PORTS: ports,
    FIRST_PORT: ports.split('-')[0].trim(),
    EXPOSE_SCRIPT: exposeScript,
  };
  const template = readFileSync(templateFile, 'utf8').replace(/\r\n/g, '\n').trim();
  const body = template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => values[key] ?? match);
  return `${BEGIN}\n${body}\n${END}`;
}

/** Position of the managed block in `text`, or null. An unclosed begin marker is ignored. */
function findBlock(text) {
  const end = text.indexOf(END);
  if (end === -1) return null;
  const start = text.lastIndexOf(BEGIN, end);
  return start === -1 ? null : { start, end: end + END.length };
}

/** `text` with the managed block set to `block`, or removed when `block` is null. */
function withBlock(text, block) {
  const found = findBlock(text);
  if (found && block) return `${text.slice(0, found.start)}${block}${text.slice(found.end)}`;
  if (found) {
    const rest = [text.slice(0, found.start).trimEnd(), text.slice(found.end).trimStart()];
    const joined = rest.filter(Boolean).join('\n\n');
    return joined ? `${joined}\n` : '';
  }
  if (!block) return text;
  const existing = text.trimEnd();
  return existing ? `${existing}\n\n${block}\n` : `${block}\n`;
}

function applyTarget(target, block) {
  const existing = readIfExists(target.file);
  if (existing === null && (!block || !target.create)) return;

  const next = target.owned ? (block ? `${block}\n` : '') : withBlock(existing ?? '', block);
  if (next === existing) return;

  if (next === '') {
    unlinkSync(target.file);
    log(`Removed ${target.file}.`);
    return;
  }
  mkdirSync(path.dirname(target.file), { recursive: true });
  writeFileSync(target.file, next);
  log(`${block ? 'Wrote' : 'Removed'} the Docker note for ${target.name} in ${target.file}.`);
}

function writeNotes() {
  const home = process.env.HOME || os.homedir();
  // `owned`: the whole file is ours. Otherwise only the marked block is.
  // `create`: write the file when it does not exist yet.
  const targets = [
    { name: 'Kiro', file: path.join(home, '.kiro', 'steering', 'cloudcli-docker.md'), owned: true, create: true },
    { name: 'Claude Code', file: path.join(home, '.claude', 'CLAUDE.md'), owned: false, create: true },
    { name: 'Codex', file: path.join(home, '.codex', 'AGENTS.md'), owned: false, create: existsSync(path.join(home, '.codex')) },
    { name: 'OpenCode', file: path.join(home, '.config', 'opencode', 'AGENTS.md'), owned: false, create: false },
  ];

  const block = renderNote(process.env);
  for (const target of targets) {
    try {
      applyTarget(target, block);
    } catch (error) {
      warn(`Could not update ${target.file}: ${error.message}`);
    }
  }
}

try {
  writeNotes();
} catch (error) {
  warn(`${error.message}. Continuing without the Docker note.`);
}

const separator = process.argv.indexOf('--');
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
if (command.length > 0) {
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  child.on('error', (error) => {
    console.error(`[agent-environment] Cannot start ${command[0]}: ${error.message}`);
    process.exit(127);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
