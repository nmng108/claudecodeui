// @ts-nocheck -- normalized event payloads mirror the other JS runtimes (cursor/opencode); typed at the ACP client boundary instead.
import {
  appendFilesInputTag,
  appendImagesInputTag,
} from '@/shared/image-attachments.js';
import { notifyRunFailed, notifyRunStopped } from '@/modules/notifications/index.js';
import { createCompleteMessage, createNormalizedMessage, generateMessageId } from '@/shared/utils.js';
import { resolveKiroApiKey } from '@/modules/providers/list/kiro/kiro-api-key.store.js';
import { KiroAcpClient } from '@/modules/providers/list/kiro/kiro-acp.client.js';
import { buildKiroToolResult } from '@/modules/providers/list/kiro/kiro-tool-output.js';
import { parseKiroModelCatalog, seedKiroModelCatalog } from '@/modules/providers/list/kiro/kiro-models.provider.js';
import { findKiroSessionDir, getKiroMessagesPath, readKiroSessionJson } from '@/modules/providers/list/kiro/kiro-paths.js';
import { readKiroTranscriptUsage, sumKiroCredits } from '@/modules/providers/list/kiro/kiro-usage.js';

/** Live ACP clients keyed by the app session id (falling back to the ACP session id for legacy/direct callers). */
const activeKiroSessions = new Map();
// Pending UI permission decisions, keyed by ACP requestId (the tool call id),
// mirroring the Claude runtime's module-level map so chat-websocket's generic
// `resolveToolApproval` dispatch (which tries every provider) can reach this
// runtime without it being the active one for that request.
const pendingKiroApprovals = new Map();

const KIRO_INIT_TIMEOUT_MS = parseInt(process.env.KIRO_ACP_INIT_TIMEOUT_MS ?? '', 10) || 20000;

/**
 * Builds the single ACP text prompt for a turn: the user's text plus the
 * same `<images_input>` / `<files_input>` tags the Cursor/OpenCode runtimes
 * use for provider-neutral attachment references (kiro-cli has no documented
 * native image/resource ingestion yet, so this keeps attachments visible to
 * the model without depending on ACP `image`/`resource` content blocks this
 * task has not verified kiro-cli accepts).
 */
function buildKiroPromptText(command, images, files) {
  return appendFilesInputTag(appendImagesInputTag(command || '', images), files);
}

function sessionMapKey(sessionId, acpSessionId) {
  return sessionId || acpSessionId || null;
}

/**
 * Whether a turn is running right now for the given Kiro session id. Used to
 * refuse deleting a session's files while the agent is still writing them.
 */
export function isKiroSessionRunning(providerSessionId) {
  if (!providerSessionId) {
    return false;
  }
  for (const entry of activeKiroSessions.values()) {
    if (entry.status === 'running' && entry.client?.getSessionId() === providerSessionId) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the reasoning level to apply, or `undefined` when none should be
 * sent. A level is only used when the selected model declares it, matching the
 * other runtimes; `default` and unknown levels leave Kiro's own setting alone.
 * Exported for tests.
 */
export const KIRO_DEFAULT_EFFORT = 'medium';

export function resolveKiroEffort(modelId, effort, catalog) {
  const selectedModel = catalog?.OPTIONS?.find((option) => option.value === modelId);
  const allowedEfforts = selectedModel?.effort?.values?.map((value) => value.value) || [];
  // No explicit choice means Kiro's default of "medium" (what kiro-ui starts
  // with), not the model's own default, which can be higher and spend more.
  const requested = typeof effort === 'string' && effort && effort !== 'default' ? effort : KIRO_DEFAULT_EFFORT;
  return allowedEfforts.includes(requested) ? requested : undefined;
}

/**
 * Whether a permission request is answered without asking the user, for the
 * mode chosen in the composer:
 * - bypassPermissions: everything ("Allow all").
 * - acceptEdits: reads and edits, as Kiro labels them (`consent.capability`
 *   `read` / `write`); shell and web access still ask.
 * - default and plan: always ask.
 */
export function shouldAutoApproveKiroPermission(permissionMode, capability) {
  if (permissionMode === 'bypassPermissions') {
    return true;
  }
  return permissionMode === 'acceptEdits' && (capability === 'read' || capability === 'write');
}
/**
 * Runs one Kiro ACP turn: connects (or resumes), sends the prompt, streams
 * normalized events to `ws`, and resolves once the turn's stop reason comes
 * back. Mirrors the run/abort/permissions contract of the Claude/Codex/Cursor
 * runtimes so `providerRuntimeService` can dispatch to it the same way.
 */
async function runKiro(command, options = {}, ws, context) {
  const {
    sessionId,
    cwd,
    projectPath,
    images,
    files,
    sessionSummary,
    permissionMode,
    model,
    effort,
  } = options;

  const workingDirectory = cwd || projectPath || process.cwd();
  const providerSessionId = context.resolveProviderSessionId(sessionId);
  // Agent-API runs (agent.routes.ts) pass 'bypassPermissions' the same way
  // Claude/Codex/OpenCode do for unattended runs: there is no UI tab waiting
  // to answer a `session/request_permission` call, so it is auto-approved
  // with the first allow option ACP offered instead of hanging the turn.

  let client = null;
  let capturedSessionId = providerSessionId || null;
  let sessionCreatedSent = false;
  let completeSent = false;
  let aborted = false;

  const mapKey = () => sessionMapKey(sessionId, capturedSessionId);

  const registerActive = () => {
    const key = mapKey();
    if (key) {
      activeKiroSessions.set(key, { client, status: 'running' });
    }
  };

  const sendComplete = (exitCode, extra = {}) => {
    if (completeSent) {
      return;
    }
    completeSent = true;
    ws.send(createCompleteMessage({
      provider: 'kiro',
      sessionId: sessionId || capturedSessionId || null,
      actualSessionId: capturedSessionId || sessionId || null,
      exitCode,
      ...extra,
    }));
  };

  // Kiro meters credits. The counter shows the session's running total (the
  // transcript's earlier turns plus this run's) and the context-window share.
  let sessionCredits = 0;
  let contextPercentage = null;
  const sendUsage = (activeSessionId) => {
    ws.send(createNormalizedMessage({
      kind: 'status',
      text: 'token_budget',
      tokenBudget: {
        used: sessionCredits,
        unit: 'credit',
        contextPercentage,
        inputTokens: 0,
        outputTokens: 0,
        breakdown: { input: 0, output: 0 },
      },
      sessionId: activeSessionId,
      provider: 'kiro',
    }));
  };

  try {
    client = new KiroAcpClient({
      cwd: workingDirectory,
      apiKey: await resolveKiroApiKey(),
      initTimeoutMs: KIRO_INIT_TIMEOUT_MS,
      events: {
        onSessionUpdate: (event) => {
          const activeSessionId = capturedSessionId || sessionId || null;
          switch (event.type) {
            case 'agent_message_chunk':
              if (event.isThought) {
                ws.send(createNormalizedMessage({ kind: 'thinking', content: event.text, sessionId: activeSessionId, provider: 'kiro' }));
              } else {
                ws.send(createNormalizedMessage({ kind: 'stream_delta', content: event.text, sessionId: activeSessionId, provider: 'kiro' }));
              }
              break;
            case 'agent_thought_chunk':
              ws.send(createNormalizedMessage({ kind: 'thinking', content: event.text, sessionId: activeSessionId, provider: 'kiro' }));
              break;
            case 'tool_call':
              ws.send(createNormalizedMessage({
                kind: 'tool_use',
                toolId: event.toolCallId,
                toolName: event.title,
                toolInput: event.rawInput,
                status: event.status,
                sessionId: activeSessionId,
                provider: 'kiro',
              }));
              break;
            case 'tool_call_update':
            {
              // Only a finished tool has a result; pending/in_progress updates are progress.
              const result = buildKiroToolResult(event);
              if (result) {
                ws.send(createNormalizedMessage({
                  kind: 'tool_result',
                  toolId: event.toolCallId,
                  toolResult: result.toolResult,
                  content: result.content,
                  isError: result.isError,
                  status: event.status,
                  sessionId: activeSessionId,
                  provider: 'kiro',
                }));
              }
              break;
            }
            case 'config_option_update':
              // v3 re-sends the option list whenever it changes (model, mode, effort).
              seedKiroModelCatalog({ configOptions: event.configOptions });
              break;
            case 'session_info':
              if (event.kind === 'context_usage') {
                const percentage = event.meta.usagePercentage ?? event.meta.contextUsage?.usagePercentage;
                if (typeof percentage === 'number') {
                  contextPercentage = percentage;
                  sendUsage(activeSessionId);
                }
              } else if (event.kind === 'turn_completion') {
                sessionCredits += sumKiroCredits(event.meta.promptTurnSummaries);
                sendUsage(activeSessionId);
              }
              break;
            case 'plan':              // No dedicated normalized "plan" message kind exists yet app-wide;
              // riding on `status` (like Codex/Claude's `token_budget`) keeps this
              // forward-compatible without adding a MessageKind this task doesn't own.
              ws.send(createNormalizedMessage({ kind: 'status', text: 'plan', entries: event.entries, sessionId: activeSessionId, provider: 'kiro' }));
              break;
            case 'tool_call_chunk':
              ws.send(createNormalizedMessage({
                kind: 'tool_use',
                toolId: event.toolCallId || generateMessageId('kiro_chunk'),
                toolName: event.title,
                sessionId: activeSessionId,
                provider: 'kiro',
              }));
              break;
            case 'retry_warning':
              ws.send(createNormalizedMessage({ kind: 'status', text: 'retry_warning', reason: event.message, sessionId: activeSessionId, provider: 'kiro' }));
              break;
            case 'unknown':
            default:
              // Unrecognized session update kinds are dropped rather than guessed at.
              break;
          }
        },
        onExtNotification: (event) => {
          const activeSessionId = capturedSessionId || sessionId || null;
          // `_kiro.dev/metadata`, `commands/available`, and `session/list_update`
          // are forwarded as `status` events carrying the raw payload; every
          // other `_kiro.dev/*` notification is intentionally ignored here —
          // T5/T6 own interpreting the rest (agent switches, MCP, compaction).
          if (
            event.method === '_kiro.dev/metadata'
            || event.method === '_kiro.dev/commands/available'
            || event.method === '_kiro.dev/session/list_update'
          ) {
            ws.send(createNormalizedMessage({
              kind: 'status',
              text: event.method,
              sessionId: activeSessionId,
              provider: 'kiro',
              ...event.params,
            }));
          }
        },
        onPermissionRequest: async (event) => {
          const activeSessionId = capturedSessionId || sessionId || null;

          if (shouldAutoApproveKiroPermission(permissionMode, event.capability)) {
            const allowOption = event.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always');
            return allowOption ? { optionId: allowOption.optionId } : { cancelled: true };
          }

          ws.send(createNormalizedMessage({
            kind: 'permission_request',
            requestId: event.requestId,
            toolName: event.title,
            input: event.rawInput,
            sessionId: activeSessionId,
            provider: 'kiro',
          }));

          return new Promise((resolve) => {
            // Metadata mirrors the Claude runtime's resolver shape so the
            // generic `getPendingApprovalsForSession` surface looks the same
            // across providers (chat-websocket reads these fields loosely).
            const resolver = (decision) => {
              pendingKiroApprovals.delete(event.requestId);
              ws.send(createNormalizedMessage({ kind: 'permission_resolved', requestId: event.requestId, sessionId: activeSessionId, provider: 'kiro' }));
              if (!decision || decision.cancelled) {
                resolve({ cancelled: true });
                return;
              }
              if (decision.allow === false) {
                const rejectOption = event.options.find((option) => option.kind === 'reject_once' || option.kind === 'reject_always');
                resolve(rejectOption ? { optionId: rejectOption.optionId } : { cancelled: true });
                return;
              }
              const optionId = typeof decision.optionId === 'string'
                ? decision.optionId
                : event.options.find((option) => option.kind === 'allow_once' || option.kind === 'allow_always')?.optionId;
              if (!optionId) {
                resolve({ cancelled: true });
                return;
              }
              resolve({ optionId });
            };
            resolver._sessionId = activeSessionId;
            resolver._toolName = event.title;
            resolver._input = event.rawInput;
            resolver._receivedAt = new Date();
            resolver._options = event.options;
            pendingKiroApprovals.set(event.requestId, resolver);
          });
        },
        onCrash: ({ code, signal, stderrTail }) => {
          if (aborted) {
            return;
          }
          const activeSessionId = capturedSessionId || sessionId || null;
          // stderrTail is the CLI's own diagnostic output; the API key is
          // injected only into the child's env and kiro-cli has never been
          // observed to echo it, but this message never includes the key or
          // the env object regardless of what the tail contains.
          const detail = stderrTail && stderrTail.trim() ? ` (${stderrTail.trim().slice(-500)})` : '';
          ws.send(createNormalizedMessage({
            kind: 'error',
            content: `Kiro CLI exited unexpectedly (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})${detail}`,
            sessionId: activeSessionId,
            provider: 'kiro',
          }));
        },
      },
    });

    const { initializeResponse } = await client.connect();
    registerActive();

    let sessionResult;
    let recordedMode;
    if (providerSessionId) {
      const priorDir = await findKiroSessionDir(providerSessionId);
      if (priorDir) {
        recordedMode = (await readKiroSessionJson(priorDir))?.agentMode;
        const prior = await readKiroTranscriptUsage(getKiroMessagesPath(priorDir));
        sessionCredits = prior.credits;
        contextPercentage = prior.contextPercentage;
      }
      sessionResult = await client.resumeSession(providerSessionId);
    } else {
      sessionResult = await client.startSession();
    }
    capturedSessionId = sessionResult.sessionId;
    registerActive();

    if (ws.setSessionId && typeof ws.setSessionId === 'function') {
      ws.setSessionId(capturedSessionId);
    }

    if (!providerSessionId && !sessionCreatedSent) {
      sessionCreatedSent = true;
      ws.send(createNormalizedMessage({
        kind: 'session_created',
        newSessionId: capturedSessionId,
        sessionId: capturedSessionId,
        provider: 'kiro',
        // Exposed for T5 (models/agents) rather than consumed here: the
        // `session/new` response's Kiro-specific `models`/`modes` fields.
        modes: sessionResult.raw?.modes ?? null,
        models: sessionResult.raw?.models ?? null,
      }));
    }

    // The same response lists the models Kiro offers; remember it so the model
    // picker does not need its own `kiro-cli` process.
    seedKiroModelCatalog(sessionResult.raw);

    const currentModelId = parseKiroModelCatalog(sessionResult.raw)?.currentModelId
      ?? sessionResult.raw?.models?.currentModelId;
    const resolvedModel = await context.resolveResumeModel(sessionId, model);
    if (resolvedModel && resolvedModel !== currentModelId) {
      try {
        await client.setModel(resolvedModel);
      } catch {
        // A model Kiro rejects should not block the turn; it runs on the
        // session's current model and the user is told why.
        ws.send(createNormalizedMessage({
          kind: 'status',
          text: 'model_switch_failed',
          reason: `Kiro could not switch to "${resolvedModel}".`,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'kiro',
        }));
      }
    }

    const catalog = await context.getProviderModels();
    const resolvedEffort = resolveKiroEffort(resolvedModel || currentModelId, effort, catalog);
    if (resolvedEffort) {
      try {
        await client.setEffort(resolvedEffort);
      } catch {
        ws.send(createNormalizedMessage({
          kind: 'status',
          text: 'effort_switch_failed',
          reason: `Kiro could not apply reasoning level "${resolvedEffort}".`,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'kiro',
        }));
      }
    }

    // Plan mode is Kiro's own "plan" agent mode (v3); leaving it restores the default mode.
    if (client.getEngine() === 'v3') {
      const modeOption = sessionResult.raw?.configOptions?.find((option) => option?.id === 'mode');
      const currentMode = modeOption?.currentValue ?? recordedMode;
      const wantedMode = permissionMode === 'plan' ? 'plan' : currentMode === 'plan' ? 'vibe' : null;
      if (wantedMode && wantedMode !== currentMode) {
        try {
          await client.setConfigOption('mode', wantedMode);
        } catch {
          ws.send(createNormalizedMessage({
            kind: 'status',
            text: 'mode_switch_failed',
            reason: `Kiro could not switch to the "${wantedMode}" mode.`,
            sessionId: capturedSessionId || sessionId || null,
            provider: 'kiro',
          }));
        }
      }
    }

    const promptText = buildKiroPromptText(command, images, files);
    const { stopReason } = await client.prompt(promptText);

    ws.send(createNormalizedMessage({ kind: 'status', text: 'stop_reason', stopReason, sessionId: capturedSessionId || sessionId || null, provider: 'kiro' }));

    const session = activeKiroSessions.get(mapKey());
    aborted = session?.status === 'aborted';

    if (!aborted) {
      sendComplete(0);
      notifyRunStopped({
        userId: ws?.userId || null,
        provider: 'kiro',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        stopReason: stopReason || 'completed',
      });
    }

    void initializeResponse; // available for future capability checks (T5/T6)
  } catch (error) {
    const session = activeKiroSessions.get(mapKey());
    const wasAborted = aborted || session?.status === 'aborted';

    if (!wasAborted) {
      console.error('[Kiro] Error:', error);
      const activeSessionId = capturedSessionId || sessionId || null;
      const installed = await context.isProviderInstalled();
      const errorContent = !installed
        ? 'Kiro CLI is not installed. Install it and ensure `kiro-cli` is on PATH.'
        : (error && error.message) || 'Kiro CLI run failed.';
      ws.send(createNormalizedMessage({ kind: 'error', content: errorContent, sessionId: activeSessionId, provider: 'kiro' }));
      sendComplete(1);
      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'kiro',
        sessionId: sessionId || capturedSessionId || null,
        sessionName: sessionSummary,
        error,
      });
    }
  } finally {
    const key = mapKey();
    if (key) {
      activeKiroSessions.delete(key);
    }
    if (client) {
      await client.close();
    }
  }
}

/**
 * Aborts an active Kiro session: sends `session/cancel`, which resolves any
 * outstanding permission request as cancelled and makes the in-flight
 * `prompt()` return with `stopReason: 'cancelled'`.
 */
function abortKiroSession(sessionId) {
  const session = activeKiroSessions.get(sessionId);
  if (!session) {
    return false;
  }
  session.status = 'aborted';
  const acpSessionId = session.client.getSessionId();
  for (const [requestId, resolver] of [...pendingKiroApprovals]) {
    if (resolver._sessionId === sessionId || resolver._sessionId === acpSessionId) {
      resolver({ cancelled: true });
      pendingKiroApprovals.delete(requestId);
    }
  }
  session.client.cancel().catch(() => {});
  return true;
}

/** Resolves a pending Kiro permission request by the UI's decision (allow/deny). Used by the shared `chat.permission-response` dispatch. */
function resolveKiroPermission(requestId, decision) {
  const resolver = pendingKiroApprovals.get(requestId);
  if (resolver) {
    resolver(decision);
  }
}

/** Pending permission prompts for one session, in the same loosely-typed shape the Claude runtime exposes. */
function getPendingKiroApprovalsForSession(sessionId) {
  const pending = [];
  for (const [requestId, resolver] of pendingKiroApprovals) {
    if (resolver._sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: resolver._toolName,
        input: resolver._input,
        receivedAt: resolver._receivedAt,
      });
    }
  }
  return pending;
}

export const kiroRuntime = {
  run: runKiro,
  abort: abortKiroSession,
  permissions: {
    resolve: resolveKiroPermission,
    listPending: getPendingKiroApprovalsForSession,
  },
};

export { runKiro, abortKiroSession, resolveKiroPermission, getPendingKiroApprovalsForSession };
