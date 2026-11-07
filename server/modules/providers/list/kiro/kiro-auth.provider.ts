import { getKiroApiKeyState } from '@/modules/providers/list/kiro/kiro-api-key.store.js';
import { getKiroCliLogin, type KiroCliLogin } from '@/modules/providers/list/kiro/kiro-login.service.js';
import type { IProviderAuth } from '@/shared/interfaces.js';
import type { CliVersionProbe, ProviderAuthStatus } from '@/shared/types.js';
import { probeCliVersion } from '@/shared/utils.js';

export class KiroProviderAuth implements IProviderAuth {
  /**
   * Checks whether `kiro-cli` is available to the server process, and which
   * version it is. Like OpenCode's CLI, a clean `--version` exit is required
   * to count as installed.
   */
  checkInstalled(): CliVersionProbe {
    const probe = probeCliVersion('kiro-cli');
    return { ...probe, installed: probe.exitCode === 0 };
  }

  /** The sign-in kiro-cli login stored (Builder ID or IAM Identity Center), or null. */
  checkCliLogin(): Promise<KiroCliLogin | null> {
    return getKiroCliLogin();
  }

  /**
   * Returns Kiro CLI installation status plus auth state. An API key (the
   * environment variable, then the stored file) takes precedence, as it does
   * when the CLI is spawned; without one, a browser sign-in made with
   * kiro-cli login counts. The key itself is never read into this status,
   * only the masked form and source the key store already exposes.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();
    const keyState = await getKiroApiKeyState();

    if (keyState.source === 'none') {
      const cliLogin = installed ? await this.checkCliLogin() : null;
      if (cliLogin) {
        return {
          installed,
          provider: 'kiro',
          installedVersion,
          authenticated: true,
          email: `Kiro sign-in (${cliLogin.label})`,
          method: 'cli_login',
        };
      }

      return {
        installed,
        provider: 'kiro',
        installedVersion,
        authenticated: false,
        email: null,
        method: null,
        error: 'Not authenticated',
      };
    }

    return {
      installed,
      provider: 'kiro',
      installedVersion,
      authenticated: true,
      email: `Kiro API key (${keyState.masked})`,
      // 'environment' per R2.3; otherwise 'credentials_file', matching the
      // method name the other file-backed providers (Claude, Codex,
      // OpenCode) already use for a locally stored credentials file.
      method: keyState.source === 'environment' ? 'environment' : 'credentials_file',
    };
  }
}
