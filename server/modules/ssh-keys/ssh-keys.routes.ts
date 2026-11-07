import express from 'express';

import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

import type { SshKeyProvider } from './ssh-key-provider.js';

/**
 * Builds the SSH key HTTP API around a key provider.
 *
 * - `GET /` returns the key's public half and its state.
 * - `POST /generate` creates a key when none exists. `{ "replace": true }`
 *   replaces a key this app generated; any other key is refused.
 *
 * No response ever contains the private key.
 */
export function createSshKeysRouter(provider: SshKeyProvider): express.Router {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json(createApiSuccessResponse(await provider.getKey()));
    }),
  );

  router.post(
    '/generate',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.replace !== undefined && typeof body.replace !== 'boolean') {
        throw new AppError('replace must be a boolean', { code: 'INVALID_REQUEST_BODY', statusCode: 400 });
      }
      res.json(createApiSuccessResponse(await provider.generateKey({ replace: body.replace === true })));
    }),
  );

  return router;
}