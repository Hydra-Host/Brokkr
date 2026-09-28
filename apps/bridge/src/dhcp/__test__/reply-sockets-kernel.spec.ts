import * as dgram from 'node:dgram';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReplySocketSet } from '../reply-sockets.js';
import { makeIface } from './test-factories.js';

const opened: dgram.Socket[] = [];

function udp(): dgram.Socket {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  opened.push(socket);
  return socket;
}

afterEach(() => {
  for (const socket of opened.splice(0)) {
    try {
      socket.close();
    } catch (error) {
      void error;
    }
  }
});

describe.runIf(process.platform === 'linux')('ReplySocketSet on real Linux sockets', () => {
  it('receives the unicast datagram that the kernel routes past the 0.0.0.0 listener', async () => {
    const wildcard = udp();
    const atWildcard: Buffer[] = [];
    wildcard.on('message', (msg) => atWildcard.push(msg));
    await new Promise<void>((resolve) => wildcard.bind(0, '0.0.0.0', resolve));
    const { port } = wildcard.address();

    const forwarded: Buffer[] = [];
    const set = new ReplySocketSet(
      udp,
      () => [makeIface({ name: 'lo', ip: '127.0.0.1', network: '127.0.0.0/8' })],
      { info: vi.fn(), warn: vi.fn() },
      (_socket, msg) => forwarded.push(msg),
      port,
    );
    await set.refresh();

    const client = udp();
    await new Promise<void>((resolve) => client.send(Buffer.from('renew'), port, '127.0.0.1', () => resolve()));

    await vi.waitFor(() => expect(forwarded.map(String)).toEqual(['renew']));
    expect(atWildcard).toHaveLength(0);
    set.closeAll();
  });
});
