import os from 'node:os';
import { access } from 'node:fs/promises';

import { KiroAcpClient } from '@/modules/providers/list/kiro/kiro-acp.client.js';
import { findKiroSessionDir, getKiroMessagesPath } from '@/modules/providers/list/kiro/kiro-paths.js';
import type { IProviderFork } from '@/shared/interfaces.js';
import { AppError } from '@/shared/utils.js';

/**
 * Branches a Kiro session with the v3 ACP `session/fork` request.
 *
 * Kiro writes the copy itself and returns its id. `upToAnchorId` is the id of a
 * user message in the transcript (the `id` of its `messages.jsonl` line); the
 * copy then ends after that message's turn, answer included, because Kiro's
 * unit is a turn. Without it the whole conversation is copied. The source is
 * not modified.
 */
export class KiroForkProvider implements IProviderFork {
  async forkSession(input: {
    providerSessionId: string;
    jsonlPath: string;
    projectPath: string;
    upToAnchorId?: string;
    title?: string;
  }): Promise<{ providerSessionId: string; jsonlPath: string }> {
    // `title` is not forwarded: the sidebar name lives in this app's session row.
    const client = new KiroAcpClient({ cwd: input.projectPath || os.homedir() });
    try {
      await client.connect();
      if (client.getEngine() !== 'v3') {
        throw new AppError('Forking Kiro sessions needs the Kiro CLI v3 engine.', {
          code: 'KIRO_FORK_UNSUPPORTED',
          statusCode: 501,
        });
      }

      await client.resumeSession(input.providerSessionId);
      const fork = await client.forkSession({ messageId: input.upToAnchorId });

      const sessionDir = await findKiroSessionDir(fork.sessionId);
      const jsonlPath = sessionDir ? getKiroMessagesPath(sessionDir) : null;
      if (!jsonlPath || !(await access(jsonlPath).then(() => true, () => false))) {
        throw new AppError('Kiro created the fork but its transcript was not found.', {
          code: 'KIRO_FORK_TRANSCRIPT_MISSING',
          statusCode: 502,
        });
      }

      return { providerSessionId: fork.sessionId, jsonlPath };
    } finally {
      await client.close().catch(() => {});
    }
  }
}
