import { projectsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type {
  ProviderSkill,
  ProviderSkillCreateInput,
  ProviderSkillListOptions,
  ProviderSkillRemoveInput,
  SkillScopeTarget,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

export const providerSkillsService = {
  /**
   * Turns the optional project id of a request into the folders it applies to:
   * the user's own when it is omitted, otherwise one registered project's. The
   * path always comes from the database, so a request cannot aim a write at an
   * arbitrary folder.
   */
  resolveTarget(projectId?: string | null): SkillScopeTarget {
    if (!projectId) {
      return { scope: 'user' };
    }

    const workspacePath = projectsDb.getProjectPathById(projectId);
    if (!workspacePath) {
      throw new AppError(`Project "${projectId}" was not found.`, {
        code: 'PROJECT_NOT_FOUND',
        statusCode: 404,
      });
    }

    return { scope: 'project', projectId, workspacePath };
  },

  /**
   * Lists normalized skills visible to one provider.
   */
  async listProviderSkills(
    providerName: string,
    options?: ProviderSkillListOptions,
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.listSkills(options);
  },

  /**
   * Writes one or more skills for one provider, to the user's folder or to a project's.
   */
  async addProviderSkills(
    providerName: string,
    input: ProviderSkillCreateInput,
    projectId?: string | null,
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.addSkills(input, providerSkillsService.resolveTarget(projectId));
  },

  async removeProviderSkill(
    providerName: string,
    input: ProviderSkillRemoveInput,
    projectId?: string | null,
  ): Promise<{ removed: boolean; provider: string; directoryName: string }> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.removeSkill(input, providerSkillsService.resolveTarget(projectId));
  },
};
