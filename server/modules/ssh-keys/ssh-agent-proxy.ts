import net from 'node:net';

/**
 * A filtering proxy in front of an ssh-agent socket.
 *
 * ssh-agent only serves connections from its own user, and offers every client
 * the full protocol, including removing the identities and loading others. The
 * sidecar therefore runs the real agent on a private socket and exposes this
 * proxy instead: processes in the app container can list the public keys and ask
 * for signatures (all that SSH authentication needs) and nothing else.
 *
 * Messages (draft-miller-ssh-agent): a 4-byte big-endian length, then a payload
 * whose first byte is the type.
 */

export const AGENT_FAILURE = 5;
export const AGENT_REQUEST_IDENTITIES = 11;
export const AGENT_SIGN_REQUEST = 13;

/** Message types a client may send. Everything else is answered with SSH_AGENT_FAILURE. */
const ALLOWED_REQUEST_TYPES = new Set([AGENT_REQUEST_IDENTITIES, AGENT_SIGN_REQUEST]);

const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;

const FAILURE_RESPONSE = Buffer.from([0, 0, 0, 1, AGENT_FAILURE]);

type ProxyOptions = {
  /** Opens a connection to the real agent. One is opened per request. */
  connectUpstream: () => net.Socket;
};

/** Sends one request to the agent and resolves with its complete response. */
function exchange(connectUpstream: () => net.Socket, request: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const upstream = connectUpstream();
    let received = Buffer.alloc(0);
    let settled = false;

    const finish = (error: Error | null, response?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      upstream.destroy();
      if (error) reject(error);
      else resolve(response as Buffer);
    };

    const timer = setTimeout(() => finish(new Error('agent timed out')), UPSTREAM_TIMEOUT_MS);
    upstream.on('error', (error) => finish(error));
    upstream.on('close', () => finish(new Error('agent closed the connection')));
    upstream.on('connect', () => upstream.write(request));
    // A socket from a factory that already connected still needs the request sent.
    if (!upstream.connecting) upstream.write(request);

    upstream.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 4) {
        const size = received.readUInt32BE(0);
        if (size > MAX_RESPONSE_BYTES) {
          finish(new Error('agent response is too large'));
        } else if (received.length >= 4 + size) {
          finish(null, received.subarray(0, 4 + size));
        }
      }
    });
  });
}

/** Creates the proxy server; the caller chooses where it listens. */
export function createAgentFilterProxy({ connectUpstream }: ProxyOptions): net.Server {
  return net.createServer((client) => {
    let pending = Buffer.alloc(0);
    const queue: Buffer[] = [];
    let running = false;

    const pump = async () => {
      if (running) return;
      running = true;
      try {
        // One request at a time, so responses stay in the order of the requests.
        for (let message = queue.shift(); message; message = queue.shift()) {
          const type = message[4];
          if (!ALLOWED_REQUEST_TYPES.has(type)) {
            client.write(FAILURE_RESPONSE);
            continue;
          }
          client.write(await exchange(connectUpstream, message));
        }
      } catch {
        client.destroy();
      } finally {
        running = false;
      }
    };

    client.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        if (pending.length < 4) break;
        const size = pending.readUInt32BE(0);
        if (size === 0 || size > MAX_REQUEST_BYTES) {
          client.destroy();
          return;
        }
        if (pending.length < 4 + size) break;
        queue.push(pending.subarray(0, 4 + size));
        pending = pending.subarray(4 + size);
      }
      void pump();
    });
    client.on('error', () => client.destroy());
  });
}