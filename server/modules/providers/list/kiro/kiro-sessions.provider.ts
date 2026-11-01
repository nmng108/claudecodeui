import { createReadStream } from 'node:fs';
import readline from 'node:readline';

import {
  findKiroSessionDir,
  getKiroMessagesPath,
} from '@/modules/providers/list/kiro/kiro-paths.js';
import type { IProviderSessions } from '@/shared/interfaces.js';
import type { FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  normalizeProviderTimestamp,
  readObjectRecord,
  sliceTailPage,
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
 */
export function normalizeKiroTranscriptLines(
  lines: Iterable<string>,
  sessionId: string,
): NormalizedMessage[] {
  const messages: NormalizedMessage[] = [];
  const toolMessages = new Map<string, NormalizedMessage>();
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
        const content = readText(payload.content);
        if (content) {
          messages.push(createNormalizedMessage({ ...base, kind: 'text', role: 'user', content }));
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
      default:
        // turn_start, turn_end, usage_summary, session_metadata, session_event,
        // agent_note, pending_interaction, interaction_resolved and sub-agent
        // markers carry no chat content.
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
      messages = normalizeKiroTranscriptLines(await readTranscriptLines(getKiroMessagesPath(sessionDir)), sessionId);
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
