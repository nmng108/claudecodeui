import { createAgentSshKeyProvider } from './agent-ssh-key.provider.js';
import { createNativeSshKeyProvider } from './native-ssh-key.provider.js';
import type { SshKeyProvider } from './ssh-key-provider.js';
import { createSshKeysRouter } from './ssh-keys.routes.js';

/**
 * Chooses where the SSH key lives.
 *
 * - `CLOUDCLI_SSH_CONTROL_SOCKET` set (the Docker compose files do this): the key
 *   is held by the ssh-agent sidecar container and this process never sees it.
 * - Otherwise the key files of the current user are used, from `CLOUDCLI_SSH_DIR`
 *   or `~/.ssh`.
 */
function createProvider(): SshKeyProvider {
  const controlSocket = process.env.CLOUDCLI_SSH_CONTROL_SOCKET?.trim();
  if (controlSocket) {
    return createAgentSshKeyProvider({ endpoint: { socketPath: controlSocket } });
  }
  return createNativeSshKeyProvider({
    sshDirectory: process.env.CLOUDCLI_SSH_DIR?.trim() || undefined,
  });
}

/** SSH key router mounted by the server entrypoint at `/api/ssh-keys`. */
export const sshKeysRoutes = createSshKeysRouter(createProvider());