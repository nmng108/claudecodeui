import { getConnection } from '@/modules/database/connection.js';
import type { CentralSkillLinkMode, LLMProvider } from '@/shared/types.js';

type LinkRow = {
  skill_name: string;
  provider: LLMProvider;
  mode: CentralSkillLinkMode;
};

/** Used by the Providers module to remember the provider skill entries it created from central skills. */
export const skillCentralLinksDb = {
  /** Returns every recorded link, or only those of one skill. */
  listLinks(skillName?: string): Array<{ skillName: string; provider: LLMProvider; mode: CentralSkillLinkMode }> {
    const db = getConnection();
    const rows = (skillName === undefined
      ? db.prepare('SELECT skill_name, provider, mode FROM skill_central_links').all()
      : db.prepare('SELECT skill_name, provider, mode FROM skill_central_links WHERE skill_name = ?').all(skillName)
    ) as LinkRow[];
    return rows.map((row) => ({ skillName: row.skill_name, provider: row.provider, mode: row.mode }));
  },

  /** Records (or updates) the link for a skill and provider. */
  setLink(skillName: string, provider: LLMProvider, mode: CentralSkillLinkMode): void {
    getConnection()
      .prepare(
        `INSERT INTO skill_central_links (skill_name, provider, mode) VALUES (?, ?, ?)
         ON CONFLICT(skill_name, provider) DO UPDATE SET mode = excluded.mode`,
      )
      .run(skillName, provider, mode);
  },

  removeLink(skillName: string, provider: LLMProvider): void {
    getConnection()
      .prepare('DELETE FROM skill_central_links WHERE skill_name = ? AND provider = ?')
      .run(skillName, provider);
  },
};
