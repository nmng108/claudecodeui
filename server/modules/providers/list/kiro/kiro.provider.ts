import { KiroForkProvider } from '@/modules/providers/list/kiro/kiro-fork.provider.js';
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
  IProviderFork,
  IProviderMcp,
  IProviderModels,
  IProviderRuntime,
  IProviderSessionSynchronizer,
  IProviderSessions,
  IProviderSkills,
} from '@/shared/interfaces.js';

/**
 * Kiro provider wrapper. Chat, models, sessions, MCP, skills, auth and forking are
 * all real; see docs/kiro for the design.
 */
export class KiroProvider extends AbstractProvider {
  readonly runtime: IProviderRuntime = kiroRuntime;
  readonly models: IProviderModels = new KiroProviderModels();
  readonly mcp: IProviderMcp = new KiroMcpProvider();
  readonly auth: IProviderAuth = new KiroProviderAuth();
  readonly skills: IProviderSkills = new KiroSkillsProvider();
  readonly sessions: IProviderSessions = new KiroSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new KiroSessionSynchronizer();
  readonly fork: IProviderFork = new KiroForkProvider();

  constructor() {
    super('kiro');
  }
}
