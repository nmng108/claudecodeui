// @ts-nocheck -- stub runtime; typed implementation lands with the ACP client (T4).
import { AppError } from '@/shared/utils.js';

/**
 * Stand-in for the Kiro ACP runtime until `KiroAcpClient` lands (T4).
 *
 * Every call fails clearly instead of silently doing nothing, so a chat send
 * routed to `kiro` before the real runtime exists reports an understandable
 * error rather than hanging or crashing.
 */
export const kiroRuntime = {
  async run(_command, _options, _writer, _context) {
    throw new AppError('The Kiro provider runtime is not implemented yet.', {
      code: 'KIRO_RUNTIME_NOT_IMPLEMENTED',
      statusCode: 501,
    });
  },

  abort(_sessionId) {
    return false;
  },
};
