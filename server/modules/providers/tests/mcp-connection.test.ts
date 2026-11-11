import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import { probeMcpServer } from '@/modules/providers/services/mcp-connection.service.js';
import type { ProviderMcpServer } from '@/shared/types.js';

const baseServer = { provider: 'claude', name: 'demo', scope: 'user' } as const;

const stdioServer = (script: string): ProviderMcpServer => ({
  ...baseServer,
  transport: 'stdio',
  command: process.execPath,
  args: ['-e', script],
});

/** Starts a throwaway HTTP server and hands its base URL to the test. */
async function withHttpServer(
  handler: http.RequestListener,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const initializeResult = { jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'fake', version: '9.9.9' } } };

test('probeMcpServer reports a stdio server that answers initialize as connected', async () => {
  const script = `
    process.stdin.once('data', () => {
      console.log('not json noise');
      console.log(JSON.stringify(${JSON.stringify(initializeResult)}));
    });
  `;
  const result = await probeMcpServer(stdioServer(script), 5000);

  assert.equal(result.status, 'connected');
  assert.deepEqual(result.serverInfo, { name: 'fake', version: '9.9.9' });
  assert.equal(result.message, undefined);
});

test('probeMcpServer reports a stdio server that exits early as failed with its stderr', async () => {
  const result = await probeMcpServer(stdioServer("console.error('boom'); process.exit(3);"), 5000);

  assert.equal(result.status, 'failed');
  assert.match(result.message ?? '', /exited \(3\)/);
  assert.match(result.message ?? '', /boom/);
});

test('probeMcpServer reports a missing command as failed', async () => {
  const result = await probeMcpServer(
    { ...baseServer, transport: 'stdio', command: 'cloudcli-command-that-does-not-exist' },
    5000,
  );

  assert.equal(result.status, 'failed');
  assert.match(result.message ?? '', /Could not start/);
});

test('probeMcpServer times out on a stdio server that never replies', async () => {
  const result = await probeMcpServer(stdioServer('setInterval(() => {}, 1000);'), 300);

  assert.equal(result.status, 'timeout');
});

test('probeMcpServer reads a JSON reply from an http server and forwards configured headers', async () => {
  let receivedAuthorization: string | undefined;
  await withHttpServer((request, response) => {
    receivedAuthorization = request.headers.authorization;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(initializeResult));
  }, async (url) => {
    const result = await probeMcpServer(
      { ...baseServer, transport: 'http', url, headers: { Authorization: 'Bearer test-token' } },
      5000,
    );

    assert.equal(result.status, 'connected');
    assert.equal(receivedAuthorization, 'Bearer test-token');
  });
});

test('probeMcpServer reads the reply from an http server that answers with an event stream', async () => {
  await withHttpServer((_request, response) => {
    response.setHeader('Content-Type', 'text/event-stream');
    response.write(`event: message\ndata: ${JSON.stringify(initializeResult)}\n\n`);
  }, async (url) => {
    const result = await probeMcpServer({ ...baseServer, transport: 'http', url }, 5000);

    assert.equal(result.status, 'connected');
  });
});

test('probeMcpServer reports 401 and 403 as auth_required and other statuses as failed', async () => {
  let status = 401;
  await withHttpServer((_request, response) => {
    response.statusCode = status;
    response.end();
  }, async (url) => {
    const server: ProviderMcpServer = { ...baseServer, transport: 'http', url };

    assert.equal((await probeMcpServer(server, 5000)).status, 'auth_required');
    status = 403;
    assert.equal((await probeMcpServer(server, 5000)).status, 'auth_required');
    status = 500;
    const serverError = await probeMcpServer(server, 5000);
    assert.equal(serverError.status, 'failed');
    assert.match(serverError.message ?? '', /HTTP 500/);
  });
});

test('probeMcpServer treats a legacy sse server that opens an event stream as connected', async () => {
  await withHttpServer((_request, response) => {
    response.setHeader('Content-Type', 'text/event-stream');
    response.write('event: endpoint\ndata: /messages\n\n');
  }, async (url) => {
    const result = await probeMcpServer({ ...baseServer, transport: 'sse', url }, 5000);

    assert.equal(result.status, 'connected');
  });
});

test('probeMcpServer rejects a remote server without a usable URL', async () => {
  const missing = await probeMcpServer({ ...baseServer, transport: 'http' }, 1000);
  const unsupported = await probeMcpServer({ ...baseServer, transport: 'http', url: 'file:///etc/passwd' }, 1000);

  assert.equal(missing.status, 'failed');
  assert.equal(unsupported.status, 'failed');
  assert.match(unsupported.message ?? '', /http and https/);
});
