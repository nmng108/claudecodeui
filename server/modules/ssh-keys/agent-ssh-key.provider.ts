import http from 'node:http';

import { AppError } from '@/shared/utils.js';

import type { GenerateSshKeyOptions, SshKeyInfo, SshKeyProvider } from './ssh-key-provider.js';

const REQUEST_TIMEOUT_MS = 10_000;

type ControlErrorBody = { error?: { code?: string; message?: string; details?: string } };

type AgentProviderOptions = {
  /** Where the ssh-agent sidecar's control API listens: a unix socket in production. */
  endpoint: Pick<http.RequestOptions, 'socketPath' | 'host' | 'port'>;
};

/**
 * Key management through the ssh-agent sidecar container.
 *
 * The private key lives in that container; this process only ever receives the
 * public half. Replacing a key is not offered here, because the agents running
 * beside this process can reach the same socket: it is done with `rotate-key` in
 * the sidecar.
 */
export function createAgentSshKeyProvider({ endpoint }: AgentProviderOptions): SshKeyProvider {
  function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<SshKeyInfo> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        {
          ...endpoint,
          method,
          path,
          timeout: REQUEST_TIMEOUT_MS,
          headers: payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : undefined,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              reject(new AppError('The SSH key service sent an invalid response', {
                code: 'SSH_KEY_SERVICE_INVALID_RESPONSE',
                statusCode: 502,
              }));
              return;
            }

            if ((res.statusCode ?? 500) >= 400) {
              const failure = (parsed as ControlErrorBody).error;
              reject(new AppError(failure?.message ?? 'The SSH key service failed', {
                code: failure?.code ?? 'SSH_KEY_SERVICE_ERROR',
                statusCode: res.statusCode ?? 502,
                details: failure?.details,
              }));
              return;
            }
            resolve(parsed as SshKeyInfo);
          });
        },
      );

      const unavailable = () => reject(new AppError('The SSH key service is not reachable', {
        code: 'SSH_KEY_SERVICE_UNAVAILABLE',
        statusCode: 503,
      }));
      req.on('timeout', () => {
        req.destroy();
        unavailable();
      });
      req.on('error', unavailable);
      req.end(payload);
    });
  }

  return {
    getKey: () => request('GET', '/key'),
    generateKey: (options: GenerateSshKeyOptions = {}) =>
      request('POST', '/generate', options.replace ? { replace: true } : {}),
  };
}