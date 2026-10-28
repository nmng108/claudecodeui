import { getKiroApiKeyState } from '@/modules/providers/list/kiro/kiro-api-key.store.js';
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

  /**
   * Returns Kiro CLI installation status plus API-key auth state. The key
   * itself is never read into this status — only the masked form and source
   * the key store already exposes.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const { installed, version: installedVersion } = this.checkInstalled();
    const keyState = await getKiroApiKeyState();

    if (keyState.source === 'none') {
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
