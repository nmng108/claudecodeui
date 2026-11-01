/**
 * Helpers that turn ACP tool-call payloads into the plain strings the chat UI
 * renders. The UI reads a tool result's text from the message-level `content`
 * string (and `isError`), so ACP content blocks must never be forwarded as is.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Flattens ACP tool-call content (`[{ type: 'content', content: { type: 'text', text } }, ...]`,
 * or bare text blocks) into text. Diffs become a short label.
 */
export function acpContentToText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  const blocks = Array.isArray(content) ? content : content === undefined || content === null ? [] : [content];
  const parts: string[] = [];

  for (const block of blocks) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === 'content' && isRecord(block.content)) {
      if (typeof block.content.text === 'string') {
        parts.push(block.content.text);
      }
    } else if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'diff' && typeof block.path === 'string') {
      parts.push(`Edited ${block.path}`);
    }
  }

  return parts.join('\n');
}

/**
 * Text for a tool's `rawOutput`. Kiro's own tools return an object such as
 * `{ output, exitCode, message }`, where `message` is the readable form; any
 * other shape is serialized as JSON. Never returns a non-string.
 */
function rawOutputToText(rawOutput: unknown): string {
  if (rawOutput === undefined || rawOutput === null) {
    return '';
  }
  if (typeof rawOutput === 'string') {
    return rawOutput;
  }
  if (isRecord(rawOutput)) {
    for (const key of ['message', 'output']) {
      const value = rawOutput[key];
      if (typeof value === 'string' && value) {
        return value;
      }
    }
  }
  try {
    return JSON.stringify(rawOutput) ?? '';
  } catch {
    return '';
  }
}

export type KiroToolResultFields = {
  content: string;
  isError: boolean;
  toolResult: { content: string };
};

/**
 * Builds the result fields for a `tool_call_update`, or `null` while the tool
 * has not finished (pending / in_progress updates carry progress, not a result).
 */
export function buildKiroToolResult(update: {
  status?: string;
  rawOutput?: unknown;
  content?: unknown;
}): KiroToolResultFields | null {
  if (update.status !== 'completed' && update.status !== 'failed') {
    return null;
  }

  // The ACP content blocks are what Kiro shows its own users, so they win over the raw payload.
  const text = acpContentToText(update.content) || rawOutputToText(update.rawOutput);
  return {
    content: text,
    isError: update.status === 'failed',
    toolResult: { content: text },
  };
}
