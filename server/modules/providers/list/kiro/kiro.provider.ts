import { KiroProviderAuth } from '@/modules/providers/list/kiro/kiro-auth.provider.js';
import { KiroProviderModels } from '@/modules/providers/list/kiro/kiro-models.provider.js';
import { kiroRuntime } from '@/modules/providers/list/kiro/kiro-runtime.provider.js';
import { KiroMcpProvider } from '@/modules/providers/list/kiro/kiro-mcp.provider.js';
import { KiroSessionSynchronizer } from '@/modules/providers/list/kiro/kiro-session-synchronizer.provider.js';
import { KiroSessionsProvider } from '@/modules/providers/list/kiro/kiro-sessions.provider.js';
import { KiroSkillsProvider } from '@/modules/providers/list/kiro/kiro-skills.provider.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderMcp,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

/**
 * Kiro provider wrapper. Auth and the API-key store are real (T3); runtime,
 * models, mcp, skills, sessions, and sessionSynchronizer are safe stubs so
 * the registry type-checks until their tasks (T4-T6) replace them.
 */
export class KiroProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = kiroRuntime;
  readonly models: IProviderModels = new KiroProviderModels();
  readonly mcp: IProviderMcp = new KiroMcpProvider();
  readonly auth: IProviderAuth = new KiroProviderAuth();
  readonly skills: IProviderSkills = new KiroSkillsProvider();
  readonly sessions: IProviderSessions = new KiroSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new KiroSessionSynchronizer();

  constructor() {
    super('kiro');
  }
}
