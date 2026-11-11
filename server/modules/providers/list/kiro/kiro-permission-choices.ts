/**
 * Rules a user can have Kiro remember when answering a permission request.
 *
 * Kiro labels every `session/request_permission` with `_meta.kiro.consent`
 * (what is being asked about and how). Answering with the `always-accept`
 * option plus `_meta.kiro.consent = { scope, resource }` makes Kiro save an
 * allow rule: `scope` is `session`, `workspace` (a per-user file outside the
 * repository) or `user` (`~/.kiro/settings/permissions.yaml`), and `resource`
 * is the rule's pattern (checked against kiro-cli 2.37; `*` matches the whole
 * tool). Without a pattern Kiro saves only the exact first sub-command, which
 * is why "always allow" kept asking for the next, similar command.
 *
 * This file turns a consent into a short list of patterns from narrow to broad
 * (like Kiro CLI's rule picker) and validates the user's selection, so the
 * client only ever names a choice id and a scope and never supplies a pattern.
 */

/** Where Kiro can keep a remembered rule, narrowest first. Used by the Kiro runtime to tell the UI which scopes it may offer. */
export const KIRO_REMEMBER_SCOPES = ['session', 'workspace', 'user'] as const;

export type KiroRememberScope = (typeof KIRO_REMEMBER_SCOPES)[number];

/** The parts of `_meta.kiro.consent` the app reads. Used by the Kiro ACP client to hand a request's consent to the runtime. */
export type KiroConsent = {
  /** `fs_read`, `fs_write`, `shell`, `web_fetch`, `mcp`, ... */
  capability?: string;
  /** What the whole tool call touches (the full command, a path, a URL). */
  resource?: string;
  /** For chained shell commands, the one sub-command being asked about now. */
  triggeringResource?: string;
  /** `explicit` means a rule asks, and Kiro refuses to save an allow rule for it. */
  askType?: string;
  persistableConsent?: boolean;
};

/**
 * One pattern the user may remember. `kind` tells the UI how to word it:
 * `exact` (only this), `subcommand` (`git stash *`), `command` (`git *`),
 * `directory` (`src/**`) or `tool` (`*`, everything the capability does).
 * Used by the Kiro runtime, which sends the choices to the UI and resolves the reply.
 */
export type KiroRememberChoice = {
  id: string;
  kind: 'exact' | 'subcommand' | 'command' | 'directory' | 'tool';
  pattern: string;
};

/** What the UI sends back: one of the offered choice ids and a scope. */
type KiroRememberSelection = { choiceId: string; scope: string };

/** The `_meta.kiro.consent` part of the reply that makes Kiro save a rule. Used by the Kiro ACP client to build the ACP reply. */
export type KiroConsentReply = { scope: KiroRememberScope; resource: string };

type KiroPermissionOptionLike = { optionId: string; kind: string };

/** Commands that run another command; a wildcard on them would cover whatever follows. */
const WRAPPER_COMMANDS = new Set(['sudo', 'doas', 'env', 'nohup', 'nice', 'time', 'xargs', 'exec', 'command']);
/** Syntax that makes one string more than a plain command with arguments. */
const SHELL_SYNTAX = /[;&|<>`\n\r]|\$\(/;

/** Reads the consent the app needs out of a request's `_meta`, ignoring anything of the wrong type. Used by the Kiro ACP client. */
export function readKiroConsent(params: Record<string, unknown>): KiroConsent | undefined {
  const meta = params._meta as { kiro?: { consent?: Record<string, unknown> } } | undefined;
  const raw = meta?.kiro?.consent;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return {
    capability: text(raw.capability),
    resource: text(raw.resource),
    triggeringResource: text(raw.triggeringResource),
    askType: text(raw.askType),
    ...(typeof raw.persistableConsent === 'boolean' ? { persistableConsent: raw.persistableConsent } : {}),
  };
}

/** The thing the user is being asked about right now: the sub-command for a chain, otherwise the resource. Used by the Kiro runtime to label the prompt. */
export function describeKiroAskedResource(consent: KiroConsent | undefined): string | undefined {
  return consent?.triggeringResource ?? consent?.resource;
}

function buildShellChoices(command: string): KiroRememberChoice[] {
  const choices: KiroRememberChoice[] = [];
  const tokens = command.trim().split(/\s+/);

  // A wildcard rule is only safe for a plain command: not a wrapper such as
  // sudo or env, not an environment assignment, and not shell syntax that
  // could smuggle in a second command.
  const isPlain = !SHELL_SYNTAX.test(command)
    && !WRAPPER_COMMANDS.has(tokens[0])
    && !/^\w+=/.test(tokens[0]);

  if (!command.includes('*')) {
    choices.push({ id: 'exact', kind: 'exact', pattern: command });
  }
  if (isPlain && tokens.length > 2 && /^[A-Za-z][\w-]*$/.test(tokens[1])) {
    choices.push({ id: 'subcommand', kind: 'subcommand', pattern: `${tokens[0]} ${tokens[1]} *` });
  }
  if (isPlain && tokens.length > 1) {
    choices.push({ id: 'command', kind: 'command', pattern: `${tokens[0]} *` });
  }
  return choices;
}

function buildFileChoices(path: string): KiroRememberChoice[] {
  const choices: KiroRememberChoice[] = [];
  if (!path.includes('*')) {
    choices.push({ id: 'exact', kind: 'exact', pattern: path });
  }
  const separator = path.replace(/\\/g, '/').lastIndexOf('/');
  // A file at the top of the workspace has no folder to offer; "entire tool" covers it.
  if (separator > 0) {
    choices.push({ id: 'directory', kind: 'directory', pattern: `${path.slice(0, separator)}/**` });
  }
  return choices;
}

/**
 * The patterns to offer for a request, narrowest first, ending with the whole
 * tool. Empty when Kiro would not save a rule anyway: it offered no
 * `allow_always` option (an `explicit` ask) or marked the request as not
 * persistable. Used by the Kiro runtime when it forwards a request to the UI.
 */
export function buildKiroRememberChoices(
  consent: KiroConsent | undefined,
  options: KiroPermissionOptionLike[],
): KiroRememberChoice[] {
  if (!consent?.capability || consent.persistableConsent === false || consent.askType === 'explicit') {
    return [];
  }
  if (!options.some((option) => option.kind === 'allow_always')) {
    return [];
  }

  const asked = describeKiroAskedResource(consent);
  let narrow: KiroRememberChoice[] = [];
  if (asked) {
    if (consent.capability === 'shell') {
      narrow = buildShellChoices(asked);
    } else if (consent.capability.startsWith('fs_')) {
      narrow = buildFileChoices(asked);
    } else if (!asked.includes('*')) {
      narrow = [{ id: 'exact', kind: 'exact', pattern: asked }];
    }
  }
  return [...narrow, { id: 'tool', kind: 'tool', pattern: '*' }];
}

/** True when `value` names one of the scopes Kiro can keep a rule in. */
function isKiroRememberScope(value: unknown): value is KiroRememberScope {
  return KIRO_REMEMBER_SCOPES.includes(value as KiroRememberScope);
}

/**
 * Validates a selection against the choices that were offered and returns the
 * option and consent to reply with, or `null` when it does not match, in which
 * case the caller allows this one call without saving anything. Used by the
 * Kiro runtime when the UI answers a request.
 */
export function resolveKiroRememberSelection(
  choices: KiroRememberChoice[],
  selection: KiroRememberSelection | undefined,
  options: KiroPermissionOptionLike[],
): { optionId: string; consent: KiroConsentReply } | null {
  if (!selection || !isKiroRememberScope(selection.scope)) {
    return null;
  }
  const choice = choices.find((candidate) => candidate.id === selection.choiceId);
  const allowAlways = options.find((option) => option.kind === 'allow_always');
  if (!choice || !allowAlways) {
    return null;
  }
  return { optionId: allowAlways.optionId, consent: { scope: selection.scope, resource: choice.pattern } };
}
