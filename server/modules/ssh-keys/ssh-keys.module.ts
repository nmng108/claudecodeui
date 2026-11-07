import { createNativeSshKeyProvider } from './native-ssh-key.provider.js';
import { createSshKeysRouter } from './ssh-keys.routes.js';

/**
 * The SSH key lives in `CLOUDCLI_SSH_DIR` when set, otherwise in `~/.ssh`.
 * In the Docker images that directory is a named volume.
 */
const provider = createNativeSshKeyProvider({
  sshDirectory: process.env.CLOUDCLI_SSH_DIR?.trim() || undefined,
});

/** SSH key router mounted by the server entrypoint at `/api/ssh-keys`. */
export const sshKeysRoutes = createSshKeysRouter(provider);