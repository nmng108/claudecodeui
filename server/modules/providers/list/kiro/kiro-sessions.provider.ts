import { createReadStream } from 'node:fs';
import readline from 'node:readline';

import {
  findKiroSessionDir,
  getKiroMessagesPath,
  getKiroSubExecutionPath,
} from '@/modules/providers/list/kiro/kiro-paths.js';
import { parseFilesInputTag, parseImagesInputTag } from '@/shared/image-attachments.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  FetchHistoryOptions,
  FetchHistoryResult,
  NormalizedMessage,
  SubagentActivity,
  SubagentInfo,
} from '@/shared/types.js';
import {
  createNormalizedMessage,
  normalizeProviderTimestamp,
  readObjectRecord,
  sliceTailPage,
  truncateSubagentActivity,
} from '@/shared/utils.js';

const readText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

/** Tool output reaches the transcript as a string; anything else is shown as JSON. */
const toDisplayText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return String(value);
  }
};

/** Upper bound on how much of a subagent's timeline is sent to the client, as for Claude, Codex and OpenCode. */
const MAX_TRANSMITTED_SUBAGENT_ACTIVITIES = 200;

/**
 * Flattens one `sub-executions/<id>.jsonl` file into the timeline a subagent
 * card shows. Tool calls and their results pair up by `toolCallId`; assistant
 * prose and reasoning become text and thinking entries. Everything else in the
 * file (steering, permission prompts, usage) is bookkeeping and skipped.
 */
function readSubagentActivity(lines: readonly string[]): SubagentActivity[] {
  const activity: SubagentActivity[] = [];
  const toolsById = new Map<string, SubagentActivity>();

  for (const line of lines) {
    let row: Record<string, unknown> | null;
    try {
      row = readObjectRecord(JSON.parse(line));
    } catch {
      continue;
    }
    const payload = readObjectRecord(row?.payload);
    if (!row || !payload) {
      continue;
    }
    const timestamp = normalizeProviderTimestamp(row.timestamp);

    if (payload.type === 'tool_call') {
      const toolId = readText(payload.toolCallId);
      const tool: SubagentActivity = {
        kind: 'tool',
        timestamp,
        toolId,
        toolName: readText(payload.toolName) ?? 'Tool',
        toolInput: payload.args ?? {},
      };
      activity.push(tool);
      if (toolId) {
        toolsById.set(toolId, tool);
      }
    } else if (payload.type === 'tool_result') {
      const tool = toolsById.get(readText(payload.toolCallId) ?? '');
      if (tool) {
        tool.toolResult = { content: toDisplayText(payload.content), isError: payload.success === false };
      }
    } else if (payload.type === 'assistant') {
      const content = readText(payload.content);
      if (content) {
        activity.push({
          kind: payload.operationType === 'Reasoning' ? 'thinking' : 'text',
          timestamp,
          content,
        });
      }
    }
  }

  return activity;
}

/**
 * Turns the lines of a Kiro `messages.jsonl` into normalized messages.
 *
 * Each line is `{ id, timestamp, payload: { type, ... } }`. Chat turns are
 * `user` and `assistant` (`operationType` `Say` for the reply, `Reasoning` for
 * thinking); a `tool_call` and its `tool_result` share a `toolCallId` and become
 * one `tool_use` message that carries its result. Bookkeeping payloads (turn
 * boundaries, usage, metadata, injected context, permission prompts) are
 * skipped. Lines that are not valid JSON, such as a half-written last line, are
 * ignored. Message ids come from the line number, so they stay stable as the
 * transcript grows.
 *
 * A spawned subagent is recorded as a `sub_agent_start` / `sub_agent_complete`
 * pair rather than a tool call, and its own work lives in a separate file.
 * The pair becomes one `tool_use` message carrying `subagent` (which is what
 * makes the UI draw a subagent card), with the timeline taken from
 * `subAgentLines`, the lines of each sub-execution file keyed by `subSessionId`.
 * A subagent that never completed is `running` until its turn ends, then
 * `stopped`.
 */
export function normalizeKiroTranscriptLines(
  lines: Iterable<string>,
  sessionId: string,
  subAgentLines: ReadonlyMap<string, readonly string[]> = new Map(),
): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  const toolMessages = new Map<string, NormalizedMessage>();
  const openSubagents = new Map<string, { message: NormalizedMessage; info: SubagentInfo }>();
  let lineIndex = -1;

  for (const line of lines) {
    lineIndex += 1;
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let row: Record<string, unknown> | null;
    try {
      row = readObjectRecord(JSON.parse(trimmed));
    } catch {
      continue;
    }
    const payload = readObjectRecord(row?.payload);
    if (!row || !payload) {
      continue;
    }

    const base = {
      id: `${sessionId}:${lineIndex}`,
      sessionId,
      timestamp: normalizeProviderTimestamp(row.timestamp),
      provider: 'kiro' as const,
    };

    switch (payload.type) {
      case 'user': {
        // Attachments reach Kiro as `<images_input>` / `<files_input>` blocks
        // appended to the prompt, so they are stripped back out for display
        // and restored as attachments, as the other providers do.
        const parsedImages = parseImagesInputTag(readText(payload.content) ?? '');
        const parsedFiles = parseFilesInputTag(parsedImages.text);
        const content = parsedFiles.text;
        if (content || parsedImages.attachments.length > 0 || parsedFiles.attachments.length > 0) {
          // Kiro forks at a user message id, which is the transcript line's own id.
          const anchorId = readText(row.id);
          messages.push(createNormalizedMessage({
            ...base,
            kind: 'text',
            role: 'user',
            content,
            ...(parsedImages.attachments.length > 0 ? { images: parsedImages.attachments } : {}),
            ...(parsedFiles.attachments.length > 0 ? { files: parsedFiles.attachments } : {}),
            ...(anchorId ? { transcriptAnchorId: anchorId } : {}),
          }));
        }
        break;
      }
      case 'assistant': {
        const content = readText(payload.content);
        if (!content) {
          break;
        }
        if (payload.operationType === 'Reasoning') {
          messages.push(createNormalizedMessage({ ...base, kind: 'thinking', content }));
          break;
        }
        const model = readText(payload.reasoningModelId);
        messages.push(createNormalizedMessage({
          ...base,
          kind: 'text',
          role: 'assistant',
          content,
          ...(model ? { model } : {}),
        }));
        break;
      }
      case 'tool_call': {
        const toolId = readText(payload.toolCallId) ?? base.id;
        const message = createNormalizedMessage({
          ...base,
          kind: 'tool_use',
          toolName: readText(payload.toolName) ?? 'Tool',
          toolInput: payload.args ?? {},
          toolId,
        });
        toolMessages.set(toolId, message);
        messages.push(message);
        break;
      }
      case 'tool_result': {
        const toolId = readText(payload.toolCallId);
        const toolResult = {
          content: toDisplayText(payload.content),
          isError: payload.success === false,
        };
        const toolMessage = toolId ? toolMessages.get(toolId) : undefined;
        if (toolMessage) {
          toolMessage.toolResult = toolResult;
        } else {
          messages.push(createNormalizedMessage({
            ...base,
            kind: 'tool_result',
            toolId: toolId ?? base.id,
            toolResult,
          }));
        }
        break;
      }
      case 'sub_agent_start': {
        const subSessionId = readText(payload.subSessionId);
        const name = readText(payload.subAgentName);
        const description = readText(payload.explanation);
        // The line id is `<toolCallId>-sub-agent-start`; the call id is what the live stream uses.
        const toolId = readText(row.id)?.replace(/-sub-agent-start$/, '') ?? subSessionId ?? base.id;
        const message = createNormalizedMessage({
          ...base,
          kind: 'tool_use',
          toolName: 'Agent',
          toolInput: { subagent_type: name, description, prompt: readText(payload.prompt) },
          toolId,
        });
        const info: SubagentInfo = {
          id: subSessionId ?? toolId,
          type: name,
          description,
          status: 'running',
        };
        const activity = subSessionId ? readSubagentActivity(subAgentLines.get(subSessionId) ?? []) : [];
        if (activity.length > 0) {
          message.subagentTools = activity
            .slice(-MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)
            .map(truncateSubagentActivity);
          info.activityCount = activity.length;
        }
        message.subagent = info;
        openSubagents.set(info.id, { message, info });
        messages.push(message);
        break;
      }
      case 'sub_agent_complete': {
        const open = openSubagents.get(readText(payload.subSessionId) ?? '');
        if (open) {
          const failed = payload.status !== 'success';
          open.info.status = failed ? 'failed' : 'completed';
          open.message.toolResult = { content: toDisplayText(payload.response), isError: failed };
          openSubagents.delete(open.info.id);
        }
        break;
      }
      case 'turn_end':
        // A subagent still open when its turn ended will never report.
        for (const { info } of openSubagents.values()) {
          info.status = 'stopped';
        }
        openSubagents.clear();
        break;
      default:
        // turn_start, usage_summary, session_metadata, session_event,
        // agent_note, pending_interaction and interaction_resolved carry no
        // chat content.
        break;
    }
  }

  return messages;
}

async function readTranscriptLines(messagesPath: string): Promise<string[]> {
  const lines: string[] = [];
  const reader = readline.createInterface({
    input: createReadStream(messagesPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of reader) {
      lines.push(line);
    }
  } finally {
    reader.close();
  }
  return lines;
}

/**
 * Loads the transcript file of every subagent the main transcript spawned,
 * keyed by `subSessionId`. A missing or unreadable file only means that card
 * has no timeline, so it is left out rather than failing the history load.
 */
async function readSubAgentTranscripts(
  sessionDir: string,
  transcriptLines: readonly string[],
): Promise<Map<string, string[]>> {
  const transcripts = new Map<string, string[]>();
  for (const line of transcriptLines) {
    // Cheap pre-filter so ordinary lines are not parsed twice.
    if (!line.includes('"sub_agent_start"')) {
      continue;
    }
    let subSessionId: string | undefined;
    try {
      subSessionId = readText(readObjectRecord(readObjectRecord(JSON.parse(line))?.payload)?.subSessionId);
    } catch {
      continue;
    }
    const filePath = subSessionId ? getKiroSubExecutionPath(sessionDir, subSessionId) : null;
    if (!subSessionId || !filePath || transcripts.has(subSessionId)) {
      continue;
    }
    try {
      transcripts.set(subSessionId, await readTranscriptLines(filePath));
    } catch {
      // No sub-execution file: the card still shows the prompt and result.
    }
  }
  return transcripts;
}

/** Sessions adapter for Kiro: live events pass through, history comes from `messages.jsonl`. */
export class KiroSessionsProvider implements IProviderSessions {
  /**
   * The Kiro runtime already emits normalized messages, so an event that is
   * already normalized is passed through and anything else is dropped.
   */
  normalizeMessage(raw: unknown, _sessionId: string | null): NormalizedMessage[] {
    const record = readObjectRecord(raw);
    return record && typeof record.kind === 'string' ? [record as NormalizedMessage] : [];
  }

  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const empty: FetchHistoryResult = { messages: [], total: 0, hasMore: false, offset: normalizedOffset, limit: normalizedLimit };

    // Transcripts are keyed by Kiro's own session id, not the app-facing one.
    // Looking the directory up by id also rejects ids that are not safe to use
    // as a path.
    const sessionDir = await findKiroSessionDir(options.providerSessionId ?? sessionId);
    if (!sessionDir) {
      return empty;
    }

    let messages: NormalizedMessage[];
    try {
      const transcriptLines = await readTranscriptLines(getKiroMessagesPath(sessionDir));
      const subAgentLines = await readSubAgentTranscripts(sessionDir, transcriptLines);
      messages = normalizeKiroTranscriptLines(transcriptLines, sessionId, subAgentLines);
    } catch {
      return empty;
    }

    const { page, hasMore } = sliceTailPage(messages, normalizedLimit, normalizedOffset);
    return {
      messages: page,
      total: messages.length,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
    };
  }
}
