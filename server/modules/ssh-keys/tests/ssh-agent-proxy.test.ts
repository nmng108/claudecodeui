import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import {
  AGENT_FAILURE,
  AGENT_REQUEST_IDENTITIES,
  AGENT_SIGN_REQUEST,
  createAgentFilterProxy,
} from '../ssh-agent-proxy.js';

const IDENTITIES_ANSWER = 12;
const SIGN_RESPONSE = 14;
const ADD_IDENTITY = 17;
const REMOVE_IDENTITY = 18;
const REMOVE_ALL_IDENTITIES = 19;
const LOCK = 22;
const EXTENSION = 27;

/** Frames a message the way the agent protocol does: length, type, body. */
const message = (type: number, body = Buffer.alloc(0)) => {
  const framed = Buffer.alloc(5 + body.length);
  framed.writeUInt32BE(1 + body.length, 0);
  framed[4] = type;
  body.copy(framed, 5);
  return framed;
};

/** A stand-in for the real agent that answers the two requests clients may make and records everything it receives. */
async function withProxy(run: (context: { port: number; upstreamTypes: number[] }) => Promise<void>) {
  const upstreamTypes: number[] = [];
  const upstream = net.createServer((socket) => {
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 5 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
        const size = buffered.readUInt32BE(0);
        const type = buffered[4];
        upstreamTypes.push(type);
        buffered = buffered.subarray(4 + size);
        socket.write(type === AGENT_REQUEST_IDENTITIES
          ? message(IDENTITIES_ANSWER, Buffer.from([0, 0, 0, 0]))
          : message(SIGN_RESPONSE, Buffer.from('signature')));
      }
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamPort = (upstream.address() as AddressInfo).port;

  const proxy = createAgentFilterProxy({ connectUpstream: () => net.connect(upstreamPort, '127.0.0.1') });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');

  try {
    await run({ port: (proxy.address() as AddressInfo).port, upstreamTypes });
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
}

/** Sends raw bytes and collects what comes back until `expectedBytes` arrived or the connection closed. */
function talk(port: number, payload: Buffer, expectedBytes: number): Promise<{ received: Buffer; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload));
    let received = Buffer.alloc(0);
    let closed = false;
    const done = () => { socket.destroy(); resolve({ received, closed }); };
    const timer = setTimeout(done, 1500);
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= expectedBytes) { clearTimeout(timer); done(); }
    });
    socket.on('close', () => { closed = true; clearTimeout(timer); resolve({ received, closed }); });
    socket.on('error', reject);
  });
}

test('lets a client list identities and request signatures', async () => {
  await withProxy(async ({ port, upstreamTypes }) => {
    const { received } = await talk(
      port,
      Buffer.concat([message(AGENT_REQUEST_IDENTITIES), message(AGENT_SIGN_REQUEST, Buffer.from('data'))]),
      5 + 4 + 5 + 9,
    );

    assert.equal(received[4], IDENTITIES_ANSWER);
    // The second response follows the first, in request order.
    const second = received.subarray(4 + received.readUInt32BE(0));
    assert.equal(second[4], SIGN_RESPONSE);
    assert.deepEqual(upstreamTypes, [AGENT_REQUEST_IDENTITIES, AGENT_SIGN_REQUEST]);
  });
});

test('answers removal, loading, locking and extensions with a failure and never forwards them', async () => {
  await withProxy(async ({ port, upstreamTypes }) => {
    for (const type of [REMOVE_IDENTITY, REMOVE_ALL_IDENTITIES, ADD_IDENTITY, LOCK, EXTENSION, 99]) {
      const { received } = await talk(port, message(type, Buffer.from('payload')), 5);
      assert.deepEqual([...received], [0, 0, 0, 1, AGENT_FAILURE], `type ${type}`);
    }
    assert.deepEqual(upstreamTypes, [], 'the real agent saw none of them');
  });
});

test('a blocked request between allowed ones does not break the order of answers', async () => {
  await withProxy(async ({ port, upstreamTypes }) => {
    const { received } = await talk(
      port,
      Buffer.concat([
        message(AGENT_REQUEST_IDENTITIES),
        message(REMOVE_ALL_IDENTITIES),
        message(AGENT_SIGN_REQUEST, Buffer.from('data')),
      ]),
      9 + 5 + 14,
    );

    const types: number[] = [];
    let rest = received;
    while (rest.length >= 5) {
      types.push(rest[4]);
      rest = rest.subarray(4 + rest.readUInt32BE(0));
    }
    assert.deepEqual(types, [IDENTITIES_ANSWER, AGENT_FAILURE, SIGN_RESPONSE]);
    assert.deepEqual(upstreamTypes, [AGENT_REQUEST_IDENTITIES, AGENT_SIGN_REQUEST]);
  });
});

test('handles a request that arrives in pieces', async () => {
  await withProxy(async ({ port }) => {
    const request = message(AGENT_REQUEST_IDENTITIES);
    const socket = net.connect(port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(request.subarray(0, 2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.write(request.subarray(2));
    const [chunk] = (await once(socket, 'data')) as [Buffer];
    socket.destroy();
    assert.equal(chunk[4], IDENTITIES_ANSWER);
  });
});

test('drops a connection that sends an empty or oversized message', async () => {
  await withProxy(async ({ port, upstreamTypes }) => {
    const empty = Buffer.alloc(4);
    assert.equal((await talk(port, empty, 1)).closed, true);

    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(10 * 1024 * 1024, 0);
    assert.equal((await talk(port, oversized, 1)).closed, true);
    assert.deepEqual(upstreamTypes, []);
  });
});

test('closes the client when the real agent is unreachable', async () => {
  const proxy = createAgentFilterProxy({
    connectUpstream: () => net.connect(1, '127.0.0.1'),
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  try {
    const { closed } = await talk((proxy.address() as AddressInfo).port, message(AGENT_REQUEST_IDENTITIES), 5);
    assert.equal(closed, true);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});