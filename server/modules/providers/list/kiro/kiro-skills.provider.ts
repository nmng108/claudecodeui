import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';

/**
 * Skill discovery roots per `docs/kiro/design.md`: `~/.kiro/skills` (user) and
 * `<workspace>/.kiro/skills` (project), with slash-style commands.
 */
export class KiroSkillsProvider extends SkillsProvider {
  constructor() {
    super('kiro');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    return [
      {
        scope: 'user',
        rootDir: path.join(os.homedir(), '.kiro', 'skills'),
        commandPrefix: '/',
      },
      {
        scope: 'project',
        rootDir: path.join(workspacePath, '.kiro', 'skills'),
        commandPrefix: '/',
      },
    ];
  }
}
