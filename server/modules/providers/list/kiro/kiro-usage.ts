import { readFile } from 'node:fs/promises';

/**
 * Kiro meters usage in credits, not tokens. A finished turn is recorded in the
 * transcript as a `usage_summary` line (`promptTurnSummaries[].usage`), and the
 * context window as a `session_metadata` line with key `contextUsage`
 * (`value.usagePercentage`). The live ACP stream carries the same numbers in
 * `session_info_update` (`_meta.kiro.kind` = `turn_completion` / `context_usage`).
 */
export type KiroUsage = {
  /** Credits spent by the whole session. */
  credits: number;
  /** Share of the context window in use (0-100), when known. */
  contextPercentage: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Sums the credit entries of one `promptTurnSummaries` array. */
export function sumKiroCredits(summaries: unknown): number {
  if (!Array.isArray(summaries)) {
    return 0;
  }
  let total = 0;
  for (const summary of summaries) {
    if (isRecord(summary) && summary.unit === 'credit' && typeof summary.usage === 'number' && Number.isFinite(summary.usage)) {
      total += summary.usage;
    }
  }
  return total;
}

/** Reads credits and context usage out of transcript lines. Malformed lines are skipped. */
export function summarizeKiroTranscriptUsage(lines: Iterable<string>): KiroUsage {
  let credits = 0;
  let contextPercentage: number | null = null;

  for (const line of lines) {
    if (!line.includes('usage_summary') && !line.includes('contextUsage')) {
      continue;
    }
    let payload: unknown;
    try {
      payload = (JSON.parse(line) as { payload?: unknown }).payload;
    } catch {
      continue;
    }
    if (!isRecord(payload)) {
      continue;
    }
    if (payload.type === 'usage_summary') {
      credits += sumKiroCredits(payload.promptTurnSummaries);
    } else if (
      payload.type === 'session_metadata'
      && payload.key === 'contextUsage'
      && isRecord(payload.value)
      && typeof payload.value.usagePercentage === 'number'
    ) {
      contextPercentage = payload.value.usagePercentage;
    }
  }

  return { credits, contextPercentage };
}

/** Reads a session transcript's usage; zeros when the file is missing. */
export async function readKiroTranscriptUsage(messagesPath: string): Promise<KiroUsage> {
  try {
    return summarizeKiroTranscriptUsage((await readFile(messagesPath, 'utf8')).split('\n'));
  } catch {
    return { credits: 0, contextPercentage: null };
  }
}
