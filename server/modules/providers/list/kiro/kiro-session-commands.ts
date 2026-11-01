import os from 'node:os';

import { sessionsDb } from '@/modules/database/index.js';
import { KiroAcpClient } from '@/modules/providers/list/kiro/kiro-acp.client.js';
import { isKiroSessionRunning } from '@/modules/providers/list/kiro/kiro-runtime.provider.js';
import { AppError } from '@/shared/utils.js';

/** How long `/context` waits for Kiro's context report after asking for it. */
const CONTEXT_REPORT_TIMEOUT_MS = 5000;

export type KiroContextReport = {
  usagePercentage: number | null;
  /** Context sections, e.g. `contextFiles`, with their token share. */
  sections: Array<{ name: string; tokens: number; percent: number; items: number }>;
};

/** Resolves an app session id (or a Kiro id) to the Kiro session and its project folder. */
function resolveKiroSession(sessionId: string | null | undefined, fallbackCwd?: string): { kiroSessionId: string; cwd: string } {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  const row = id ? sessionsDb.getSessionById(id) : null;
  const kiroSessionId = row?.provider_session_id || (id && /^(sess|cli)_/.test(id) ? id : '');
  if (!kiroSessionId || (row && row.provider !== 'kiro')) {
    throw new AppError('Send a message first: this Kiro session has not started yet.', {
      code: 'KIRO_SESSION_NOT_STARTED',
      statusCode: 409,
    });
  }
  return { kiroSessionId, cwd: row?.project_path || fallbackCwd || os.homedir() };
}

/** Runs `work` against a short-lived `kiro-cli acp` that has loaded the session. */
async function withLoadedKiroSession<T>(
  sessionId: string | null | undefined,
  fallbackCwd: string | undefined,
  work: (client: KiroAcpClient, events: { onContext(listener: (report: KiroContextReport) => void): void }) => Promise<T>,
): Promise<T> {
  const { kiroSessionId, cwd } = resolveKiroSession(sessionId, fallbackCwd);
  if (isKiroSessionRunning(kiroSessionId)) {
    throw new AppError('Kiro is still working on this session. Try again when the turn has finished.', {
      code: 'KIRO_SESSION_IN_USE',
      statusCode: 409,
    });
  }

  let contextListener: ((report: KiroContextReport) => void) | null = null;
  const client = new KiroAcpClient({
    cwd,
    events: {
      onSessionUpdate: (event) => {
        if (event.type === 'session_info' && contextListener && event.meta.breakdown !== undefined) {
          contextListener(toContextReport(event.meta));
        }
      },
    },
  });
  try {
    await client.connect();
    if (client.getEngine() !== 'v3') {
      throw new AppError('This command needs the Kiro CLI v3 engine.', {
        code: 'KIRO_V3_REQUIRED',
        statusCode: 501,
      });
    }
    await client.resumeSession(kiroSessionId);
    return await work(client, { onContext: (listener) => { contextListener = listener; } });
  } finally {
    await client.close().catch(() => {});
  }
}

/** Turns a `session_info_update` `_meta.kiro` payload into a short, display-ready report. */
export function toContextReport(meta: Record<string, unknown>): KiroContextReport {
  const usage = (meta.contextUsage as { usagePercentage?: unknown } | undefined)?.usagePercentage ?? meta.usagePercentage;
  const breakdown = meta.breakdown && typeof meta.breakdown === 'object' ? (meta.breakdown as Record<string, unknown>) : {};

  const sections: KiroContextReport['sections'] = [];
  for (const [name, value] of Object.entries(breakdown)) {
    const section = value as { tokens?: unknown; percent?: unknown; items?: unknown } | null;
    if (!section || typeof section !== 'object') {
      continue;
    }
    sections.push({
      name,
      tokens: typeof section.tokens === 'number' ? section.tokens : 0,
      percent: typeof section.percent === 'number' ? section.percent : 0,
      items: Array.isArray(section.items) ? section.items.length : 0,
    });
  }

  return { usagePercentage: typeof usage === 'number' ? usage : null, sections };
}

/** `/compact`: summarizes the session's history to free context. */
export async function compactKiroSession(sessionId: string | null | undefined, cwd?: string): Promise<void> {
  await withLoadedKiroSession(sessionId, cwd, async (client) => {
    const result = await client.extMethod('_kiro/session/compact', { sessionId: client.getSessionId() });
    if (result && (result as { success?: unknown }).success === false) {
      throw new AppError('Kiro could not compact this session.', { code: 'KIRO_COMPACT_FAILED', statusCode: 502 });
    }
  });
}

/** `/context`: asks Kiro for the session's context breakdown. */
export async function readKiroSessionContext(sessionId: string | null | undefined, cwd?: string): Promise<KiroContextReport> {
  return withLoadedKiroSession(sessionId, cwd, async (client, events) => {
    const report = new Promise<KiroContextReport>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new AppError('Kiro did not report its context in time.', { code: 'KIRO_CONTEXT_TIMEOUT', statusCode: 504 })),
        CONTEXT_REPORT_TIMEOUT_MS,
      );
      events.onContext((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    report.catch(() => {});
    await client.extMethod('_kiro/session/context', { sessionId: client.getSessionId() });
    return report;
  });
}
