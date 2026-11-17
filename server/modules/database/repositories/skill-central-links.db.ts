import { getConnection } from '@/modules/database/connection.js';
import type { CentralSkillLinkMode, LLMProvider } from '@/shared/types.js';

type LinkRow = {
  skill_name: string;
  provider: LLMProvider;
  mode: CentralSkillLinkMode;
};

/**
 * Used by the Providers module to remember the provider skill entries it created from shared skills.
 * `scopeKey` is `user` for the home skill folders, or a project id for one project's folders.
 */
export const skillCentralLinksDb = {
  /** Returns the recorded links of one scope, or only those of one skill in it. */
  listLinks(
    scopeKey: string,
    skillName?: string,
  ): Array<{ skillName: string; provider: LLMProvider; mode: CentralSkillLinkMode }> {
    const db = getConnection();
    const rows = (skillName === undefined
      ? db.prepare('SELECT skill_name, provider, mode FROM skill_central_links WHERE scope_key = ?').all(scopeKey)
      : db
        .prepare('SELECT skill_name, provider, mode FROM skill_central_links WHERE scope_key = ? AND skill_name = ?')
        .all(scopeKey, skillName)
    ) as LinkRow[];
    return rows.map((row) => ({ skillName: row.skill_name, provider: row.provider, mode: row.mode }));
  },

  /** Records (or updates) the link for a skill and provider in one scope. */
  setLink(scopeKey: string, skillName: string, provider: LLMProvider, mode: CentralSkillLinkMode): void {
    getConnection()
      .prepare(
        `INSERT INTO skill_central_links (scope_key, skill_name, provider, mode) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope_key, skill_name, provider) DO UPDATE SET mode = excluded.mode`,
      )
      .run(scopeKey, skillName, provider, mode);
  },

  removeLink(scopeKey: string, skillName: string, provider: LLMProvider): void {
    getConnection()
      .prepare('DELETE FROM skill_central_links WHERE scope_key = ? AND skill_name = ? AND provider = ?')
      .run(scopeKey, skillName, provider);
  },
};
